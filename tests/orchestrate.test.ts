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
  it('pads presets with the requested pane type', () => {
    const w = applyPreset({ ...ws, panes: [], layout: [] }, 6, 'claude');
    expect(w.panes).toHaveLength(6); expect(w.panes.every(p => p.type === 'claude')).toBe(true);
    expect(applyPreset({ ...ws, panes: [], layout: [] }, 4).panes.every(p => p.type === 'powershell')).toBe(true);
  });
});
