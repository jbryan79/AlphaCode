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
