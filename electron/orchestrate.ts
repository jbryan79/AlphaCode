import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { OrchestrateEvent, OrchestrateRoles, PaneConfig, Plan, Task } from '../shared/types';
import { lastLines as tail, promptHeader, stripAnsi, transition, validatePlan, type Signal } from '../shared/orchestrate';
import { validateId } from '../shared/domain';
import type { LaunchOverrides } from './terminals';
export type { LaunchOverrides };

export interface RunDeps { runDir: string; execPath: string; cliPath: string; playbookPath: string; roles: OrchestrateRoles; panes: () => PaneConfig[]; git: (args: string[], cwd: string) => Promise<string>; launch: (paneId: string) => Promise<void>; chat: (paneId: string, prompt: string) => Promise<string>; finish: (report: string, summary: string, run: { tasks: Task[]; plan: Plan | null }) => Promise<void>; emit: (event: OrchestrateEvent) => void; log: (message: string) => void; now?: () => number; }
interface Live { task: Task; prompt: string; hookToken: string; hooksFile: string; }
const token = () => randomBytes(32).toString('hex');
const RING = 4096;

export class OrchestrateRun {
  port = 0; readonly controlToken = token();
  protected plan: Plan | null = null; protected live = new Map<string, Live>(); protected launching = new Set<string>();
  private rings = new Map<string, string>(); private server: Server | null = null; private version = 0; private waiters: (() => void)[] = []; private finished = false;
  constructor(protected deps: RunDeps) {
    // Interrupted tasks from the saved workspace come back without prompt text; retry supplies the next message.
    for (const t of deps.roles.resume || []) if (t.state === 'interrupted' && deps.roles.workerPaneIds.includes(t.paneId) && !this.live.has(t.paneId)) this.live.set(t.paneId, this.mintTask({ ...t }, ''));
  }
  private now() { return (this.deps.now || Date.now)(); }
  async start(): Promise<number> {
    await mkdir(this.deps.runDir, { recursive: true });
    // Electron as Node: the shim keeps ELECTRON_RUN_AS_NODE out of the pane environment (terminals.ts strips it) and inside this one process.
    await writeFile(join(this.deps.runDir, 'alphacode.cmd'), `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${this.deps.execPath}" "${this.deps.cliPath}" %*\r\n`, 'utf8');
    this.server = createServer((req, res) => void this.handle(req, res).catch(e => this.reply(res, 500, { error: (e as Error).message })));
    await new Promise<void>((resolve, reject) => this.server!.once('error', reject).listen(0, '127.0.0.1', resolve));
    this.port = (this.server.address() as { port: number }).port; return this.port;
  }
  async stop(): Promise<void> {
    const server = this.server; this.server = null; for (const w of this.waiters.splice(0)) w();
    await new Promise<void>(resolve => { if (!server) return resolve(); server.close(() => resolve()); server.closeAllConnections(); });
    await rm(this.deps.runDir, { recursive: true, force: true }); this.deps.emit({ kind: 'off' });
  }
  private pathEnv() { return { PATH: `${this.deps.runDir};${process.env.PATH || ''}` }; }
  overrides(paneId: string): LaunchOverrides | null {
    const { roles } = this.deps;
    if (paneId === roles.orchestratorPaneId) return { env: { ...this.pathEnv(), ALPHACODE_CONTROL_URL: `http://127.0.0.1:${this.port}`, ALPHACODE_CONTROL_TOKEN: this.controlToken, ALPHACODE_RUN_DIR: this.deps.runDir }, args: ['--append-system-prompt-file', this.deps.playbookPath, '--name', 'Orchestrator'] };
    const l = this.live.get(paneId); if (!l || !this.launching.has(paneId)) return null;
    const env = { ...this.pathEnv(), ALPHACODE_CONTROL_URL: `http://127.0.0.1:${this.port}`, ALPHACODE_HOOK_TOKEN: l.hookToken, ALPHACODE_PANE_ID: paneId };
    if (l.task.retries > 0 && l.task.worktree) return { env, cwd: l.task.worktree, args: ['--resume', l.task.sessionId, '--settings', l.hooksFile, l.prompt] };
    return { env, args: ['--worktree', `task-${l.task.id}`, '--model', l.task.model, '--name', l.task.title, '--settings', l.hooksFile, '--session-id', l.task.sessionId, promptHeader(l.task) + l.prompt] };
  }
  tap(paneId: string, data: string): void { const next = (this.rings.get(paneId) || '') + data; this.rings.set(paneId, next.length > RING ? next.slice(-RING) : next); }
  lastLines(paneId: string): string[] { return tail(stripAnsi(this.rings.get(paneId) || ''), 20); }
  tasks(): Task[] { return [...this.live.values()].map(l => ({ ...l.task })); }
  protected reply(res: ServerResponse, status: number, body: unknown): void { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); }
  /** Set by main: type into a worker PTY, and whether its process is alive. Defaults keep tests and a partially wired main honest. */
  writer: (paneId: string, data: string) => void = () => { throw new Error('Retry typing is not wired.'); };
  alive: (paneId: string) => boolean = () => false;
  hookTokenFor(paneId: string): string { return this.live.get(paneId)?.hookToken || ''; }
  private async body(req: IncomingMessage): Promise<any> {
    const chunks: Buffer[] = []; let size = 0;
    for await (const c of req) { size += (c as Buffer).length; if (size > 1048576) throw Object.assign(new Error('Body exceeds 1 MB'), { status: 413 }); chunks.push(c as Buffer); }
    if (!chunks.length) return {}; try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw Object.assign(new Error('Body is not JSON'), { status: 400 }); }
  }
  private err(status: number, message: string): never { throw Object.assign(new Error(message), { status }); }
  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', 'http://127.0.0.1'), route = `${req.method} ${url.pathname}`;
    try {
      if (route === 'POST /report') { const b = await this.body(req); const paneId = typeof b.paneId === 'string' ? b.paneId : ''; const l = this.live.get(paneId); if (!l || !this.authorized(req, l.hookToken)) return this.reply(res, 401, { error: 'Unauthorized' }); return this.reply(res, 200, { task: this.report(paneId, b) }); }
      if (!this.authorized(req, this.controlToken)) return this.reply(res, 401, { error: 'Unauthorized' });
      let m: RegExpExecArray | null;
      if (route === 'GET /panes') return this.reply(res, 200, this.panes());
      if (route === 'POST /plan') return this.reply(res, 200, await this.setPlan(await this.body(req)));
      if (route === 'GET /tasks') return this.reply(res, 200, this.tasks().map(t => this.status(t)));
      if (route === 'GET /tasks/wait') return this.reply(res, 200, await this.wait(url.searchParams.get('ids') || '', Number(url.searchParams.get('timeout') || 240)));
      if ((m = /^GET \/tasks\/([a-z0-9-]+)$/.exec(route))) return this.reply(res, 200, this.status(this.find(m[1])));
      if ((m = /^POST \/tasks\/([a-z0-9-]+)\/start$/.exec(route))) return this.reply(res, 200, await this.startTask(m[1]));
      if ((m = /^POST \/tasks\/([a-z0-9-]+)\/retry$/.exec(route))) return this.reply(res, 200, await this.retry(m[1], await this.body(req)));
      if ((m = /^POST \/ask\/([A-Za-z0-9_-]+)$/.exec(route))) return this.reply(res, 200, await this.ask(m[1], await this.body(req)));
      if (route === 'POST /finish') return this.reply(res, 200, await this.finish(await this.body(req)));
      this.reply(res, 404, { error: 'Not found' });
    } catch (error) { const e = error as Error & { status?: number }; this.deps.log(`orchestrate ${route}: ${e.message}`); this.reply(res, e.status || (/^(Invalid|A plan|Task |File |Duplicate|Each task)/.test(e.message) ? 400 : 500), { error: e.message }); }
  }
  private roleOf(id: string): 'orchestrator' | 'worker' | 'advisor' | 'none' { const r = this.deps.roles; return id === r.orchestratorPaneId ? 'orchestrator' : r.workerPaneIds.includes(id) ? 'worker' : r.advisorPaneIds.includes(id) ? 'advisor' : 'none'; }
  private panes() { return this.deps.panes().map(p => { const t = this.live.get(p.id)?.task; return { id: p.id, title: p.title, type: p.type, cwd: p.cwd, role: this.roleOf(p.id), task: t ? { id: t.id, state: t.state } : null }; }); }
  private find(id: string): Task { const l = [...this.live.values()].find(x => x.task.id === id); if (!l) this.err(404, `No task ${id}`); return l.task; }
  private status(t: Task) { return { ...t, elapsedSeconds: t.startedAt ? Math.round(((t.finishedAt ? Date.parse(t.finishedAt) : this.now()) - Date.parse(t.startedAt)) / 1000) : 0, lines: this.lastLines(t.paneId) }; }
  private async setPlan(body: unknown): Promise<Omit<Plan, 'tasks'> & { tasks: Task[] }> {
    const { roles } = this.deps; const workers = roles.workerPaneIds.filter(id => this.deps.panes().some(p => p.id === id && p.type === 'claude'));
    const plan = validatePlan(body, { maxWorkers: roles.maxWorkers, workerPanes: workers.length });
    try { await this.deps.git(['rev-parse', '--is-inside-work-tree'], roles.root); } catch { this.err(400, `${roles.root} is not a git repository; Orchestrate needs one for worktrees`); }
    if ((await this.deps.git(['status', '--porcelain'], roles.root)).split(/\r?\n/).some(l => l && !l.startsWith('??'))) this.err(400, 'The git index is not clean; commit or stash before planning');
    const kept = new Map([...this.live.entries()].filter(([, l]) => l.task.state !== 'planned'));
    const free = workers.filter(id => !kept.has(id));
    for (const pt of plan.tasks) { if ([...kept.values()].some(l => l.task.id === pt.id)) continue; const paneId = free.shift(); if (!paneId) this.err(409, 'No free worker pane for the plan'); const { prompt, ...rest } = pt; const task: Task = { ...rest, state: 'planned', paneId, branch: '', worktree: '', startedAt: '', finishedAt: '', retries: 0, sessionId: '', message: '', hidden: false }; kept.set(paneId, this.mintTask(task, prompt)); }
    this.live = kept; this.plan ={ ...plan, approved: plan.approved || this.plan?.approved === true }; this.bump();
    return { ...this.plan, tasks: this.tasks() };
  }
  private async launchPane(l: Live, signal: Signal): Promise<Task> {
    const id = l.task.paneId; if (this.launching.has(id)) this.err(409, `Pane ${id} is already launching`);
    if (!transition(l.task.state, signal)) this.err(409, `Task ${l.task.id} is ${l.task.state}`);
    this.launching.add(id);
    try { await writeFile(l.hooksFile, this.hooksJson(), 'utf8'); await this.deps.launch(id); this.signal(id, signal); } catch (error) { this.launching.delete(id); l.task.state = 'failed'; l.task.message = (error as Error).message; this.bump(); throw error; }
    this.launching.delete(id); await this.locate(l); return l.task;
  }
  private async locate(l: Live): Promise<void> {
    try { const out = await this.deps.git(['worktree', 'list', '--porcelain'], this.deps.roles.root); const want = `/task-${l.task.id}`; let path = '';
      for (const line of out.split(/\r?\n/)) { if (line.startsWith('worktree ')) path = line.slice(9).replace(/\\/g, '/'); else if (line.startsWith('branch ') && path.endsWith(want)) { l.task.worktree = path; l.task.branch = line.slice(7).replace(/^refs\/heads\//, ''); break; } }
    } catch (error) { this.deps.log(`worktree lookup: ${(error as Error).message}`); }
    this.bump();
  }
  private async startTask(id: string): Promise<Task> {
    const t = this.find(id); const l = this.live.get(t.paneId)!; if (!this.plan?.approved) this.err(409, 'The plan is not approved yet');
    if (t.state === 'attention' || t.state === 'failed' || t.state === 'interrupted') this.err(409, `Task ${id} is ${t.state}; use retry`);
    if (this.launching.has(t.paneId)) this.err(409, `Pane ${t.paneId} is already launching`); if (!transition(t.state, 'start')) this.err(409, `Task ${id} is ${t.state}`);
    t.sessionId = this.uuid(); t.startedAt = new Date(this.now()).toISOString(); t.finishedAt = ''; t.retries = 0; t.message = ''; t.hidden = false;
    return this.launchPane(l, 'start');
  }
  private async retry(id: string, body: any): Promise<Task> {
    const t = this.find(id); const l = this.live.get(t.paneId)!; const feedback = typeof body.feedback === 'string' ? body.feedback.trim() : ''; if (!feedback || feedback.length > 65536) this.err(400, 'feedback is required (1 to 65536 characters)');
    if (!transition(t.state, 'retry')) this.err(409, `Task ${id} is ${t.state}`); if (t.retries >= 2) this.err(409, `Task ${id} already retried twice`);
    const alive = this.alive(t.paneId);
    if (!alive) { if (!t.sessionId || !t.worktree) this.err(409, `Task ${id} has no session to resume`); if (this.launching.has(t.paneId)) this.err(409, `Pane ${t.paneId} is already launching`); }
    if (alive) this.writer(t.paneId, feedback.replace(/[\r\n]+/g, ' ').replace(/[\x00-\x1f\x7f]/g, '') + '\r');
    t.retries++; t.message = ''; t.finishedAt = '';
    if (alive) { this.signal(t.paneId, 'retry'); return t; }
    l.prompt = feedback; return this.launchPane(l, 'retry');
  }
  private report(paneId: string, b: any): Task | null {
    const kind = b.kind, message = typeof b.message === 'string' ? b.message.slice(0, 2000) : '';
    if (kind === 'done' || kind === 'failed' || kind === 'stop') return this.signal(paneId, kind, message);
    if (kind === 'waiting') return b.notificationType === 'permission_prompt' ? this.signal(paneId, 'waiting', 'Waiting for permission') : b.notificationType === 'idle_prompt' ? this.signal(paneId, 'stop', 'Idle, waiting for input') : null;
    this.err(400, 'kind must be done, failed, stop or waiting');
  }
  private wait(ids: string, timeout: number): Promise<{ changed: boolean; tasks: Task[] }> {
    const want = ids ? ids.split(',').map(s => s.trim()).filter(Boolean) : this.tasks().map(t => t.id); for (const id of want) this.find(id);
    const pick = () => this.tasks().filter(t => want.includes(t.id)); const snapshot = JSON.stringify(pick().map(t => [t.id, t.state, t.retries])); const ms = Math.max(0, Math.min(240, Number.isFinite(timeout) ? timeout : 240)) * 1000;
    return new Promise(resolve => {
      const changed = () => JSON.stringify(pick().map(t => [t.id, t.state, t.retries])) !== snapshot;
      const done = () => { clearTimeout(timer); this.waiters = this.waiters.filter(w => w !== check); resolve({ changed: changed(), tasks: pick() }); };
      const check = () => { if (changed() || !this.server) done(); else this.waiters.push(check); };
      const timer = setTimeout(done, ms); this.waiters.push(check);
    });
  }
  private async ask(paneId: string, body: any): Promise<{ answer: string }> {
    this.ensureId(paneId); if (this.roleOf(paneId) !== 'advisor') this.err(400, `Pane ${paneId} is not an advisor (Local Model) pane`);
    const prompt = typeof body.prompt === 'string' ? body.prompt : ''; if (!prompt.trim() || prompt.length > 262144) this.err(400, 'prompt is required (1 to 262144 characters)');
    return { answer: await this.deps.chat(paneId, prompt) };
  }
  private async finish(body: any): Promise<{ summary: string }> {
    if (this.finished) this.err(409, 'This run already finished'); const report: string = typeof body.report === 'string' ? body.report.trim() : ''; if (!report || report.length > 1048576) this.err(400, 'report is required');
    const summary = report.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#') && !/^report$/i.test(l))[0] || 'Finished'; this.finished = true;
    await this.deps.finish(report, summary.slice(0, 200), { tasks: this.tasks(), plan: this.plan }); this.deps.emit({ kind: 'finished', summary: summary.slice(0, 200) }); return { summary };
  }
  protected signal(paneId: string, signal: Signal, message = ''): Task | null { const l = this.live.get(paneId); if (!l) return null; const next = transition(l.task.state, signal); if (!next) return null; l.task.state = next; if (message) l.task.message = message; if (next === 'done' || next === 'failed') l.task.finishedAt = new Date(this.now()).toISOString(); if (next === 'working') l.task.hidden = false; this.bump(); return l.task; }
  protected bump(): void { this.version++; for (const w of this.waiters.splice(0)) w(); this.deps.emit({ kind: 'tasks', approved: this.plan?.approved === true, tasks: this.tasks() }); }
  exited(paneId: string): void { this.signal(paneId, 'exit', 'Process exited without a report.'); }
  typed(paneId: string): void { const l = this.live.get(paneId); if (!l) return; if (l.task.state === 'done' || l.task.state === 'failed') { if (!l.task.hidden) { l.task.hidden = true; this.bump(); } return; } this.signal(paneId, 'typed'); }
  approve(): void { if (this.plan) { this.plan.approved = true; this.bump(); } }
  protected authorized(req: IncomingMessage, expected: string): boolean { const got = (req.headers.authorization || '').replace(/^Bearer\s+/i, ''); return got.length === expected.length && timingSafeEqual(Buffer.from(got), Buffer.from(expected)); }
  protected mintTask(task: Task, prompt: string): Live { const hookToken = token(); return { task, prompt, hookToken, hooksFile: join(this.deps.runDir, `hooks-${task.paneId}.json`) }; }
  protected hooksJson(): string { const shim = join(this.deps.runDir, 'alphacode.cmd').replace(/\\/g, '/'); const hook = (k: string) => [{ hooks: [{ type: 'command', command: `"${shim}" report ${k}` }] }]; return JSON.stringify({ hooks: { Stop: hook('stop'), Notification: hook('waiting') } }); }
  protected uuid(): string { return randomUUID(); }
  protected ensureId(id: string): string { return validateId(id); }
}
