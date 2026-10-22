import { describe, expect, it } from 'vitest';
import { defaultState, validateState } from '../shared/domain';
import type { Task } from '../shared/types';
import { supportPrompt } from '../src/support';

const task = (over: Partial<Task>): Task => ({ id: 'api', title: 'Add export endpoint', files: [], model: 'sonnet', minutes: 10, advisor: false, state: 'working', paneId: 'p1', branch: '', worktree: '', startedAt: '', finishedAt: '', retries: 0, sessionId: '', message: '', hidden: false, ...over });
const base = { workspace: 'Development', root: 'D:\\Dev\\ACO', on: true, approved: true, finished: '', tasks: [] as Task[], errors: [] as string[], statePath: 'C:\\Users\\me\\AppData\\Roaming\\alphacode\\state.json' };

describe('supportPrompt', () => {
  it('names the project, each task and where the run data lives, on one line', () => {
    const text = supportPrompt({ ...base, tasks: [task({}), task({ id: 'ui', title: 'Screens', state: 'failed', retries: 2, branch: 'worktree-task-ui', message: 'tests red\nin ui.spec' })], errors: ['9:00 Pane did not start within 20 seconds.'] });
    expect(text).not.toMatch(/[\r\n]/);
    expect(text).toContain('project D:\\Dev\\ACO');
    expect(text).toContain('Run: running, plan approved');
    expect(text).toContain('ui "Screens" Failed');
    expect(text).toContain('retried 2x, branch worktree-task-ui): tests red in ui.spec');
    expect(text).toContain('Recent app errors: 9:00 Pane did not start within 20 seconds.');
    expect(text).toContain('App data: C:\\Users\\me\\AppData\\Roaming\\alphacode (state.json');
  });
  it('says when the run is stopped and has no tasks', () => {
    expect(supportPrompt({ ...base, on: false })).toContain('Run: stopped. Tasks: none.');
  });
  it('stays under the 4096-character pane argument limit and keeps its instructions', () => {
    const tasks = Array.from({ length: 5 }, (_, n) => task({ id: `t${n}`, message: 'x'.repeat(2000) }));
    const text = supportPrompt({ ...base, tasks, errors: Array(10).fill('e'.repeat(1000)) });
    expect(text.length).toBeLessThanOrEqual(3800);
    expect(text).toMatch(/Do not change files in the orchestrated project unless I ask\.$/);
  });
});

describe('standalone session folders in saved state', () => {
  it('keeps the Chat and Support folders and rejects a malformed one', () => {
    const s = { ...defaultState('D:\\Dev'), chat: { cwd: 'D:\\Notes' }, support: { cwd: 'D:\\Dev\\AlphaCode' } };
    expect(validateState(JSON.parse(JSON.stringify(s)))).toEqual(s);
    expect(validateState(JSON.parse(JSON.stringify(defaultState('D:\\Dev'))))).not.toHaveProperty('chat');
    expect(() => validateState({ ...s, chat: { cwd: 42 } })).toThrow();
  });
});
