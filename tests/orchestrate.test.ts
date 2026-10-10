import { describe, expect, it } from 'vitest';
import { conflicts, emptyOrchestrate, lastLines, normalizeFile, promptHeader, stripAnsi, transition, validateOrchestrate, validatePlan } from '../shared/orchestrate';
import { applyPreset, validateWorkspace } from '../shared/domain';
import type { Task, Workspace } from '../shared/types';

const task = (over: Partial<Task> = {}): Task => ({ id: 'api', title: 'API', files: ['electron/api.ts'], model: 'sonnet', minutes: 20, advisor: false, state: 'planned', paneId: 'p2', branch: '', worktree: '', startedAt: '', finishedAt: '', retries: 0, sessionId: '', message: '', hidden: false, ...over });
const plan = (tasks: unknown[], tests = 'npm test') => ({ tests, tasks });
const t = (id: string, files: string[], over: Record<string, unknown> = {}) => ({ id, title: id, files, model: 'sonnet', minutes: 10, advisor: false, prompt: 'do it', ...over });
const limits = { maxWorkers: 5, workerPanes: 5 };

describe('plan validation', () => {
  it('accepts a plan and normalizes file paths', () => {
    const p = validatePlan(plan([t('a', ['src\\API\\x.ts']), t('b', ['src/web/'])]), limits);
    expect(p.tasks[0].files).toEqual(['src/API/x.ts']); expect(p.approved).toBe(false);
  });
  it('rejects overlapping files including folder claims and case/separator variants', () => {
    expect(() => validatePlan(plan([t('a', ['src/api/x.ts']), t('b', ['src\\api\\x.ts'])]), limits)).toThrow(/claimed by both a and b/);
    expect(() => validatePlan(plan([t('a', ['src/API/']), t('b', ['src/api/x.ts'])]), limits)).toThrow(/claimed by both/);
    expect(conflicts('src/api/', 'src/api/deep/x.ts')).toBe(true); expect(conflicts('src/api', 'src/apix.ts')).toBe(false);
  });
  it('rejects bad ids, paths, counts, models and minutes with named reasons', () => {
    expect(() => validatePlan(plan([t('A', ['x'])]), limits)).toThrow(/id/);
    expect(() => validatePlan(plan([t('a', ['../x'])]), limits)).toThrow(/outside the repository/);
    expect(() => validatePlan(plan([t('a', ['C:/x'])]), limits)).toThrow(/outside the repository/);
    expect(() => validatePlan(plan([t('a', ['x'], { model: 'gpt' })]), limits)).toThrow(/model/);
    expect(() => validatePlan(plan([t('a', ['x'], { minutes: 0 })]), limits)).toThrow(/minutes/);
    expect(() => validatePlan(plan([t('a', ['x']), t('a', ['y'])]), limits)).toThrow(/duplicate/i);
    expect(() => validatePlan(plan([]), limits)).toThrow(/1 to 5/);
    expect(() => validatePlan(plan([t('a', ['a']), t('b', ['b']), t('c', ['c'])]), { maxWorkers: 5, workerPanes: 2 })).toThrow(/1 to 2/);
    expect(() => validatePlan(plan([t('a', ['x'], { prompt: '' })]), limits)).toThrow(/prompt/);
  });
  it('collapses dot segments so variants of one path conflict, and rejects a path naming no file', () => {
    expect(() => validatePlan(plan([t('a', ['src/./x.ts']), t('b', ['src/x.ts'])]), limits)).toThrow(/claimed by both a and b/);
    expect(normalizeFile('./src/./x.ts')).toBe('src/x.ts'); expect(normalizeFile('src/api/./')).toBe('src/api/');
    expect(() => validatePlan(plan([t('a', ['.'])]), limits)).toThrow(/names no file/);
    expect(() => validatePlan(plan([t('a', ['./'])]), limits)).toThrow(/names no file/);
  });
});

describe('task state machine', () => {
  it('follows the spec transitions', () => {
    expect(transition('planned', 'start')).toBe('working');
    expect(transition('working', 'waiting')).toBe('waiting');
    expect(transition('waiting', 'typed')).toBe('working');
    expect(transition('working', 'stop')).toBe('attention');
    expect(transition('attention', 'retry')).toBe('working');
    expect(transition('failed', 'retry')).toBe('working');
    expect(transition('interrupted', 'retry')).toBe('working');
    for (const s of ['working', 'waiting', 'attention'] as const) { expect(transition(s, 'done')).toBe('done'); expect(transition(s, 'failed')).toBe('failed'); expect(transition(s, 'exit')).toBe('failed'); }
    expect(transition('done', 'start')).toBe('working');
  });
  it('ignores hook signals that do not apply instead of throwing', () => {
    expect(transition('done', 'stop')).toBeNull(); expect(transition('planned', 'stop')).toBeNull(); expect(transition('failed', 'waiting')).toBeNull(); expect(transition('waiting', 'stop')).toBeNull();
    expect(transition('working', 'retry')).toBeNull(); expect(transition('working', 'start')).toBeNull();
  });
});

describe('prompt header and output helpers', () => {
  it('names the task, worktree, budget, owned files and the report commands', () => {
    const h = promptHeader(task({ files: ['a.ts', 'b/'] }));
    expect(h).toContain('Task api in worktree task-api'); expect(h).toContain('Budget: 20 minutes'); expect(h).toContain('Files you own: a.ts, b/');
    expect(h).toContain('alphacode report done'); expect(h).toContain('alphacode report failed'); expect(h.endsWith('\n\n')).toBe(true);
  });
  it('strips ANSI and returns the last lines', () => {
    expect(stripAnsi('\x1b[31mred\x1b[0m\r\nplain')).toBe('red\r\nplain');
    expect(lastLines('1\n2\n3\n4', 2)).toEqual(['3', '4']); expect(lastLines('', 5)).toEqual([]);
  });
});

describe('persistence', () => {
  const ws: Workspace = { id: 'w', name: 'W', root: 'D:\\Dev', locked: false, panes: [{ id: 'p1', type: 'claude', title: 'A', cwd: 'D:\\Dev', command: '', args: [], profileId: '', color: '', autoStart: true }], layout: [{ i: 'p1', x: 0, y: 0, w: 12, h: 4, minW: 3, minH: 3 }] };
  it('accepts a workspace without orchestrate and one with it, marking live tasks interrupted and the mode off', () => {
    expect(validateWorkspace(ws).orchestrate).toBeUndefined();
    const v = validateWorkspace({ ...ws, orchestrate: { on: true, orchestratorPaneId: 'p1', maxWorkers: 3, approved: true, tasks: [task({ state: 'working', paneId: 'p1' }), task({ id: 'b', state: 'done', paneId: 'p1' })] } });
    expect(v.orchestrate?.on).toBe(false); expect(v.orchestrate?.tasks.map(x => x.state)).toEqual(['interrupted', 'done']);
  });
  it('rejects tokens, unknown panes, bad counts and prompt text', () => {
    expect(() => validateOrchestrate({ ...emptyOrchestrate(), maxWorkers: 9 }, ['p1'])).toThrow(/maxWorkers/);
    expect(() => validateOrchestrate({ ...emptyOrchestrate(), orchestratorPaneId: 'zz' }, ['p1'])).toThrow(/pane/);
    expect(() => validateOrchestrate({ ...emptyOrchestrate(), tasks: [{ ...task(), prompt: 'secret' }] }, ['p2'])).toThrow(/prompt/);
    expect(() => validateOrchestrate({ ...emptyOrchestrate(), token: 'x' }, ['p1'])).toThrow(/unknown/i);
  });
  it('rejects persisted task ids that fail the id rule and duplicate ids', () => {
    expect(() => validateOrchestrate({ ...emptyOrchestrate(), tasks: [task({ id: '../x', paneId: 'p2' })] }, ['p2'])).toThrow(/must match/);
    expect(() => validateOrchestrate({ ...emptyOrchestrate(), tasks: [task({ id: 'a', paneId: 'p2' }), task({ id: 'a', paneId: 'p2' })] }, ['p2'])).toThrow(/Duplicate task ids/);
  });
  it('pads presets with the requested pane type', () => {
    const w = applyPreset({ ...ws, panes: [], layout: [] }, 6, 'claude');
    expect(w.panes).toHaveLength(6); expect(w.panes.every(p => p.type === 'claude')).toBe(true);
    expect(applyPreset({ ...ws, panes: [], layout: [] }, 4).panes.every(p => p.type === 'powershell')).toBe(true);
  });
});

import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OrchestrateRun, type RunDeps } from '../electron/orchestrate';
import type { OrchestrateEvent, PaneConfig } from '../shared/types';

const pane = (id: string, type: PaneConfig['type'] = 'claude', over: Partial<PaneConfig> = {}): PaneConfig => ({ id, type, title: id, cwd: 'D:\\Dev\\repo', command: '', args: [], profileId: '', color: '', autoStart: true, ...over });
async function fixture(over: Partial<RunDeps> = {}) {
  const runDir = await mkdtemp(join(tmpdir(), 'alphacode-orch-'));
  const events: OrchestrateEvent[] = [], gits: string[][] = [], launches: string[] = [], chats: string[] = [], finishes: string[] = [];
  const deps: RunDeps = {
    runDir, execPath: 'C:\\App\\AlphaCode.exe', cliPath: 'C:\\App\\dist-electron\\electron\\cli.js', playbookPath: 'C:\\Data\\orchestrate.md',
    roles: { workspaceId: 'w', root: 'D:\\Dev\\repo', orchestratorPaneId: 'p1', workerPaneIds: ['p2', 'p3'], advisorPaneIds: ['p4'], maxWorkers: 5 },
    panes: () => [pane('p1'), pane('p2'), pane('p3'), pane('p4', 'local-model')],
    git: async args => { gits.push(args); if (args[0] === 'status') return ''; if (args[0] === 'rev-parse') return 'true\n'; if (args[0] === 'worktree') return 'worktree D:/Dev/repo\nbranch refs/heads/main\n\nworktree D:/Dev/repo/.claude/worktrees/task-api\nbranch refs/heads/task-api\n\n'; return ''; },
    launch: async id => { launches.push(id); }, chat: async (_id, prompt) => { chats.push(prompt); return 'advice'; },
    finish: async report => { finishes.push(report); }, emit: e => events.push(e), log: () => {}, ...over,
  };
  const run = new OrchestrateRun(deps); await run.start();
  return { run, runDir, events, gits, launches, chats, finishes, deps };
}

describe('OrchestrateRun launch overrides', () => {
  it('gives the orchestrator the control env, playbook and name, and puts the shim folder first on PATH', async () => {
    const f = await fixture();
    const o = f.run.overrides('p1')!;
    expect(o.env!.ALPHACODE_CONTROL_URL).toBe(`http://127.0.0.1:${f.run.port}`); expect(o.env!.ALPHACODE_CONTROL_TOKEN).toBe(f.run.controlToken); expect(o.env!.ALPHACODE_RUN_DIR).toBe(f.runDir);
    expect(o.env!.PATH!.split(';')[0]).toBe(f.runDir); expect(o.args).toEqual(['--append-system-prompt-file', 'C:\\Data\\orchestrate.md', '--name', 'Orchestrator']);
    expect(o.env!.ALPHACODE_HOOK_TOKEN).toBeUndefined();
    expect(f.run.overrides('p1')).toEqual(o); // stable across restarts in the same run
    expect(f.run.overrides('p4')).toBeNull(); expect(f.run.overrides('p2')).toBeNull(); // idle worker gets nothing
    const shim = await readFile(join(f.runDir, 'alphacode.cmd'), 'utf8');
    expect(shim).toContain('ELECTRON_RUN_AS_NODE=1'); expect(shim).toContain('"C:\\App\\AlphaCode.exe" "C:\\App\\dist-electron\\electron\\cli.js" %*');
    await f.run.stop(); await expect(stat(f.runDir)).rejects.toThrow();
  });
  it('seeds interrupted tasks from the saved workspace so the new run can list and retry them', async () => {
    const interrupted = task({ id: 'old', state: 'interrupted', paneId: 'p3', sessionId: 'abc', worktree: 'D:/Dev/repo/.claude/worktrees/task-old', branch: 'task-old' });
    const f = await fixture({ roles: { workspaceId: 'w', root: 'D:\\Dev\\repo', orchestratorPaneId: 'p1', workerPaneIds: ['p2', 'p3'], advisorPaneIds: ['p4'], maxWorkers: 5, resume: [interrupted, task({ id: 'stray', state: 'interrupted', paneId: 'p9' })] } });
    expect(f.run.tasks().map(t => [t.id, t.state])).toEqual([['old', 'interrupted']]); expect(f.run.overrides('p3')).toBeNull();
    await f.run.stop();
  });
  it('tracks the last 20 ANSI-stripped lines per pane within 4 KB', async () => {
    const f = await fixture();
    for (let i = 0; i < 300; i++) f.run.tap('p2', `\x1b[32mline ${i}\x1b[0m\r\n`);
    const lines = f.run.lastLines('p2'); expect(lines).toHaveLength(20); expect(lines[19]).toBe('line 299'); expect(lines[0]).toBe('line 280');
    await f.run.stop();
  });
});

async function call(run: OrchestrateRun, token: string, method: string, path: string, body?: unknown) {
  const r = await fetch(`http://127.0.0.1:${run.port}${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json() as any };
}
const planBody = { tests: 'npm test', tasks: [{ id: 'api', title: 'API', files: ['electron/api.ts'], model: 'sonnet', minutes: 20, advisor: true, prompt: 'Build the endpoint.' }, { id: 'ui', title: 'UI', files: ['src/'], model: 'fable', minutes: 30, advisor: false, prompt: 'Build the screen.' }] };

describe('control server', () => {
  it('rejects missing, wrong-class and foreign tokens', async () => {
    const f = await fixture();
    expect((await call(f.run, '', 'GET', '/panes')).status).toBe(401);
    expect((await call(f.run, 'x'.repeat(64), 'GET', '/panes')).status).toBe(401);
    await call(f.run, f.run.controlToken, 'POST', '/plan', { ...planBody, approved: true });
    await call(f.run, f.run.controlToken, 'POST', '/tasks/api/start');
    const hook = f.run.hookTokenFor('p2');
    expect((await call(f.run, hook, 'GET', '/panes')).status).toBe(401);
    expect((await call(f.run, f.run.controlToken, 'POST', '/report', { paneId: 'p2', kind: 'done' })).status).toBe(401);
    expect((await call(f.run, hook, 'POST', '/report', { paneId: 'p3', kind: 'done' })).status).toBe(401);
    expect(f.run.tasks().find(t => t.id === 'api')!.state).toBe('working');
    await f.run.stop();
  });
  it('lists panes with roles and task states', async () => {
    const f = await fixture();
    const r = await call(f.run, f.run.controlToken, 'GET', '/panes');
    expect(r.status).toBe(200); expect(r.body.map((p: any) => [p.id, p.role])).toEqual([['p1', 'orchestrator'], ['p2', 'worker'], ['p3', 'worker'], ['p4', 'advisor']]);
    expect(r.body[1]).toMatchObject({ title: 'p2', type: 'claude', cwd: 'D:\\Dev\\repo', task: null });
    await f.run.stop();
  });
  it('validates the plan, requires a clean git index, assigns panes in order and gates start on approval', async () => {
    const f = await fixture();
    expect((await call(f.run, f.run.controlToken, 'POST', '/plan', { tasks: [] })).status).toBe(400);
    const dirty = await fixture({ git: async args => args[0] === 'status' ? ' M a.ts\n' : 'true\n' });
    expect((await call(dirty.run, dirty.run.controlToken, 'POST', '/plan', planBody)).body.error).toMatch(/clean/); await dirty.run.stop();
    const notGit = await fixture({ git: async () => { throw new Error('fatal: not a git repository'); } });
    expect((await call(notGit.run, notGit.run.controlToken, 'POST', '/plan', planBody)).body.error).toMatch(/git repository/); await notGit.run.stop();
    const ok = await call(f.run, f.run.controlToken, 'POST', '/plan', planBody);
    expect(ok.status).toBe(200); expect(ok.body.approved).toBe(false); expect(ok.body.tasks.map((t: any) => [t.id, t.paneId, t.state])).toEqual([['api', 'p2', 'planned'], ['ui', 'p3', 'planned']]);
    expect(f.events.at(-1)).toMatchObject({ kind: 'tasks', approved: false });
    expect((await call(f.run, f.run.controlToken, 'POST', '/tasks/api/start')).status).toBe(409);
    f.run.approve(); expect((await call(f.run, f.run.controlToken, 'POST', '/tasks/api/start')).status).toBe(200);
    expect(f.launches).toEqual(['p2']); expect(f.run.tasks()[0]).toMatchObject({ state: 'working', branch: 'task-api', worktree: 'D:/Dev/repo/.claude/worktrees/task-api' });
    expect(f.run.tasks()[0].sessionId).toMatch(/^[0-9a-f-]{36}$/); expect(f.run.tasks()[0].startedAt).not.toBe('');
    const hooks = JSON.parse(await readFile(join(f.runDir, 'hooks-p2.json'), 'utf8'));
    expect(hooks.hooks.Stop[0].hooks[0].command).toMatch(/alphacode\.cmd" report stop$/); expect(hooks.hooks.Notification[0].hooks[0].command).toMatch(/report waiting$/);
    expect(f.run.overrides('p2')).toBeNull(); // launch completed: no more overrides until a retry
    await f.run.stop();
  });
  it('refuses a second start while a launch is in flight and fails the task when the launch rejects', async () => {
    let release = () => {}; const f = await fixture({ launch: () => new Promise<void>(r => { release = r; }) });
    await call(f.run, f.run.controlToken, 'POST', '/plan', { ...planBody, approved: true });
    const first = call(f.run, f.run.controlToken, 'POST', '/tasks/api/start');
    await new Promise(r => setTimeout(r, 20));
    const sid = f.run.tasks()[0].sessionId; expect(sid).not.toBe('');
    expect((await call(f.run, f.run.controlToken, 'POST', '/tasks/api/start')).status).toBe(409); expect(f.run.tasks()[0].sessionId).toBe(sid);
    const o = f.run.overrides('p2')!; expect(o.args).toContain('--worktree'); expect(o.env!.ALPHACODE_CONTROL_TOKEN).toBeUndefined(); expect(o.env!.ALPHACODE_HOOK_TOKEN).toBe(f.run.hookTokenFor('p2'));
    release(); expect((await first).status).toBe(200);
    const bad = await fixture({ launch: async () => { throw new Error('Cannot find claude'); } });
    await call(bad.run, bad.run.controlToken, 'POST', '/plan', { ...planBody, approved: true });
    const r = await call(bad.run, bad.run.controlToken, 'POST', '/tasks/api/start');
    expect(r.status).toBe(500); expect(bad.run.tasks()[0]).toMatchObject({ state: 'failed', message: 'Cannot find claude' });
    await f.run.stop(); await bad.run.stop();
  });
  it('applies hook reports, ignores repeats, and reports status with the last lines', async () => {
    const f = await fixture();
    await call(f.run, f.run.controlToken, 'POST', '/plan', { ...planBody, approved: true });
    await call(f.run, f.run.controlToken, 'POST', '/tasks/api/start');
    const hook = f.run.hookTokenFor('p2'), report = (kind: string, extra = {}) => call(f.run, hook, 'POST', '/report', { paneId: 'p2', kind, ...extra });
    expect((await report('waiting', { notificationType: 'permission_prompt' })).status).toBe(200); expect(f.run.tasks()[0].state).toBe('waiting');
    expect((await report('stop')).status).toBe(200); expect(f.run.tasks()[0].state).toBe('waiting'); // stop while waiting is ignored
    f.run.typed('p2'); expect(f.run.tasks()[0].state).toBe('working');
    expect((await report('waiting', { notificationType: 'other' })).status).toBe(200); expect(f.run.tasks()[0].state).toBe('working'); // only permission prompts wait
    expect((await report('waiting', { notificationType: 'idle_prompt' })).status).toBe(200); expect(f.run.tasks()[0].state).toBe('attention');
    f.run.tap('p2', 'hello\r\nworld\r\n');
    const s = await call(f.run, f.run.controlToken, 'GET', '/tasks/api');
    expect(s.body).toMatchObject({ id: 'api', state: 'attention', lines: ['hello', 'world'] }); expect(typeof s.body.elapsedSeconds).toBe('number');
    expect((await call(f.run, f.run.controlToken, 'GET', '/tasks')).body).toHaveLength(2);
    expect((await report('done')).status).toBe(200); expect(f.run.tasks()[0].state).toBe('done');
    expect((await report('stop')).status).toBe(200); expect(f.run.tasks()[0].state).toBe('done');
    expect((await report('failed', { message: 'late' })).status).toBe(200); expect(f.run.tasks()[0].state).toBe('done');
    f.run.typed('p2'); expect(f.run.tasks()[0].hidden).toBe(true);
    f.run.exited('p3'); expect(f.run.tasks()[1].state).toBe('planned'); // exit on a planned pane is ignored
    await f.run.stop();
  });
  it('fails a working task whose process exits, and long-polls wait until a change or timeout', async () => {
    const f = await fixture();
    await call(f.run, f.run.controlToken, 'POST', '/plan', { ...planBody, approved: true });
    await call(f.run, f.run.controlToken, 'POST', '/tasks/api/start');
    const waiting = call(f.run, f.run.controlToken, 'GET', '/tasks/wait?ids=api&timeout=5');
    await new Promise(r => setTimeout(r, 30)); f.run.exited('p2');
    const w = await waiting; expect(w.body.changed).toBe(true); expect(w.body.tasks[0]).toMatchObject({ id: 'api', state: 'failed' });
    const t0 = Date.now(); const timed = await call(f.run, f.run.controlToken, 'GET', '/tasks/wait?ids=ui&timeout=0.1');
    expect(timed.body.changed).toBe(false); expect(Date.now() - t0).toBeLessThan(2000);
    expect((await call(f.run, f.run.controlToken, 'GET', '/tasks/wait?ids=nope')).status).toBe(404);
    await f.run.stop();
  });
  it('retries by typing into a live pane or relaunching with resume in the worktree', async () => {
    const typed: string[] = []; const f = await fixture();
    f.run.writer = (id, data) => { typed.push(`${id}:${data}`); }; f.run.alive = () => true;
    await call(f.run, f.run.controlToken, 'POST', '/plan', { ...planBody, approved: true });
    await call(f.run, f.run.controlToken, 'POST', '/tasks/api/start');
    expect((await call(f.run, f.run.controlToken, 'POST', '/tasks/api/retry', { feedback: 'fix tests' })).status).toBe(409); // working
    await call(f.run, f.run.hookTokenFor('p2'), 'POST', '/report', { paneId: 'p2', kind: 'done' });
    expect((await call(f.run, f.run.controlToken, 'POST', '/tasks/api/retry', { feedback: 'fix tests' })).status).toBe(200);
    expect(typed).toEqual(['p2:fix tests\r']); expect(f.run.tasks()[0]).toMatchObject({ state: 'working', retries: 1 });
    f.run.alive = () => false; f.run.exited('p2');
    expect((await call(f.run, f.run.controlToken, 'POST', '/tasks/api/retry', { feedback: 'again' })).status).toBe(200);
    expect(f.launches).toEqual(['p2', 'p2']); expect(f.run.tasks()[0].retries).toBe(2);
    f.run.exited('p2'); expect((await call(f.run, f.run.controlToken, 'POST', '/tasks/api/retry', { feedback: 'third' })).status).toBe(409); // cap of two
    await f.run.stop();
  });
  it('asks an advisor pane and refuses a worker, and finishes once', async () => {
    const f = await fixture();
    expect((await call(f.run, f.run.controlToken, 'POST', '/ask/p2', { prompt: 'review' })).status).toBe(400);
    const a = await call(f.run, f.run.controlToken, 'POST', '/ask/p4', { prompt: 'review this diff' }); expect(a.body).toEqual({ answer: 'advice' }); expect(f.chats).toEqual(['review this diff']);
    const fin = await call(f.run, f.run.controlToken, 'POST', '/finish', { report: '# Report\nAll good.' });
    expect(fin.status).toBe(200); expect(f.finishes).toEqual(['# Report\nAll good.']); expect(f.events.at(-1)).toEqual({ kind: 'finished', summary: 'All good.' });
    expect((await call(f.run, f.run.controlToken, 'POST', '/finish', { report: 'again' })).status).toBe(409);
    await f.run.stop();
  });
});

describe('control server fixes', () => {
  const C = (f: Awaited<ReturnType<typeof fixture>>) => f.run.controlToken;
  it('wait keeps its subscription across unrelated bumps and reports the change', async () => {
    const f = await fixture();
    await call(f.run, C(f), 'POST', '/plan', { ...planBody, approved: true });
    await call(f.run, C(f), 'POST', '/tasks/api/start'); await call(f.run, C(f), 'POST', '/tasks/ui/start');
    const t0 = Date.now(), waiting = call(f.run, C(f), 'GET', '/tasks/wait?ids=api&timeout=20');
    await new Promise(r => setTimeout(r, 30)); f.run.exited('p3');
    await new Promise(r => setTimeout(r, 30)); f.run.exited('p2');
    const w = await waiting; expect(w.body.changed).toBe(true); expect(w.body.tasks[0].state).toBe('failed'); expect(Date.now() - t0).toBeLessThan(3000);
    await f.run.stop();
  });
  it('retry guards run before mutating and typed feedback is sanitized', async () => {
    const typed: string[] = []; const f = await fixture(); f.run.writer = (_id, d) => { typed.push(d); }; f.run.alive = () => false;
    await call(f.run, C(f), 'POST', '/plan', { ...planBody, approved: true });
    await call(f.run, C(f), 'POST', '/tasks/api/start');
    f.run.exited('p2');
    const live = (f.run as any).live.get('p2'); live.task.worktree = '';
    const r = await call(f.run, C(f), 'POST', '/tasks/api/retry', { feedback: 'x' });
    expect(r.status).toBe(409); expect(f.run.tasks()[0].retries).toBe(0);
    live.task.state = 'attention'; f.run.alive = () => true;
    expect((await call(f.run, C(f), 'POST', '/tasks/api/retry', { feedback: 'a\rb\x1b[Ac\n' })).status).toBe(200);
    expect(typed).toEqual(['a b[Ac\r']);
    await f.run.stop();
  });
  it('a plan that runs out of panes leaves the previous state intact', async () => {
    const f = await fixture();
    await call(f.run, C(f), 'POST', '/plan', { ...planBody, approved: true });
    await call(f.run, C(f), 'POST', '/tasks/api/start'); // ui stays planned, so p3 is the only free pane
    await call(f.run, f.run.hookTokenFor('p2'), 'POST', '/report', { paneId: 'p2', kind: 'done' });
    const before = f.run.tasks();
    const t = (id: string) => ({ ...planBody.tasks[0], id, files: [`src/${id}/`] });
    const r = await call(f.run, C(f), 'POST', '/plan', { tests: 'npm test', tasks: [t('n1'), t('n2')] });
    expect(r.status).toBe(409); expect(r.body.error).toMatch(/No free worker pane/);
    expect(f.run.tasks()).toEqual(before); expect(before.map(x => [x.id, x.state])).toEqual([['api', 'done'], ['ui', 'planned']]);
    await f.run.stop();
  });
  it('finish skips heading lines for the summary', async () => {
    const f = await fixture();
    expect((await call(f.run, C(f), 'POST', '/finish', { report: '# Overview\n\nAll good.' })).body).toEqual({ summary: 'All good.' });
    await f.run.stop();
  });
});
describe('concurrent launch', () => {
  it('lets exactly one of two simultaneous starts launch', async () => {
    let release = () => {}; const f = await fixture({ launch: () => new Promise<void>(r => { release = r; }) }); let n = 0; const inner = f.deps.launch; f.deps.launch = (id: string) => { n++; return inner(id); };
    await call(f.run, f.run.controlToken, 'POST', '/plan', { ...planBody, approved: true });
    const both = Promise.all([call(f.run, f.run.controlToken, 'POST', '/tasks/api/start'), call(f.run, f.run.controlToken, 'POST', '/tasks/api/start')]);
    await new Promise(r => setTimeout(r, 100)); release();
    expect((await both).map(r => r.status).sort()).toEqual([200, 409]); expect(n).toBe(1);
    await f.run.stop();
  });
});