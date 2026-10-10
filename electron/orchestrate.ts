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
    await new Promise<void>(resolve => this.server ? this.server.close(() => resolve()) : resolve()); this.server = null;
    for (const w of this.waiters.splice(0)) w();
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
  async handle(_req: IncomingMessage, res: ServerResponse): Promise<void> { this.reply(res, 404, { error: 'Not found' }); }
  // Task 3 fills in: signal(), approve(), exited(), typed(), the router and endpoints.
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
