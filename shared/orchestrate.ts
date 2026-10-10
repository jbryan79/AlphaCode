import type { OrchestrateConfig, Plan, PlanTask, Task, TaskModel, TaskState } from './types';
import { string as str, validateId } from './domain';

export const MODELS: readonly TaskModel[] = ['sonnet', 'opus', 'fable'];
export const TASK_STATES: readonly TaskState[] = ['planned', 'working', 'waiting', 'attention', 'done', 'failed', 'interrupted'];
export const TASK_LABELS: Record<TaskState, string> = { planned: 'Planned', working: 'Working', waiting: 'Waiting', attention: 'Needs attention', done: 'Task done', failed: 'Failed', interrupted: 'Interrupted' };
export type Signal = 'start' | 'waiting' | 'typed' | 'stop' | 'retry' | 'done' | 'failed' | 'exit';
const fail = (m: string): never => { throw new Error(m); };
export const ID_RE = /^[a-z0-9-]{1,32}$/;

/** Repo-relative, forward slashes, no leading ./; keeps a trailing slash (a folder claim). Throws on anything that could leave the repo. */
export function normalizeFile(value: unknown): string {
  const raw = str(value, 'file path', 1024).replace(/\\/g, '/'), folder = raw.endsWith('/');
  if (/^([A-Za-z]:|\/|~)/.test(raw)) fail(`File path ${JSON.stringify(raw)} is outside the repository`);
  const parts = raw.split('/').filter(s => s !== '' && s !== '.');
  if (parts.includes('..')) fail(`File path ${JSON.stringify(raw)} is outside the repository`);
  if (!parts.length) fail(`File path ${JSON.stringify(raw)} names no file`);
  return parts.join('/') + (folder ? '/' : '');
}
/** Two normalized entries collide when equal (case-insensitive) or when one is a folder claim that contains the other. */
export function conflicts(a: string, b: string): boolean {
  const x = a.toLowerCase(), y = b.toLowerCase(); if (x === y) return true;
  const under = (dir: string, file: string) => dir.endsWith('/') && file.startsWith(dir);
  return under(x, y) || under(y, x);
}
export function validatePlan(value: unknown, limits: { maxWorkers: number; workerPanes: number }): Plan {
  const p = value as Plan; if (!p || typeof p !== 'object' || !Array.isArray(p.tasks)) fail('A plan is an object with a tasks array');
  const max = Math.max(0, Math.min(limits.maxWorkers, limits.workerPanes)); if (p.tasks.length < 1 || p.tasks.length > max) fail(`A plan has 1 to ${max} tasks`);
  const tests = p.tests === undefined ? '' : str(p.tests, 'test command', 500);
  const tasks: PlanTask[] = p.tasks.map((v: any) => {
    if (!v || typeof v !== 'object') fail('Each task is an object');
    const id = str(v.id, 'task id', 32); if (!ID_RE.test(id)) fail(`Task id ${JSON.stringify(id)} must match ^[a-z0-9-]{1,32}$`);
    if (!Array.isArray(v.files) || v.files.length < 1 || v.files.length > 200) fail(`Task ${id}: files lists 1 to 200 entries`);
    if (!MODELS.includes(v.model)) fail(`Task ${id}: model must be one of ${MODELS.join(', ')}`);
    if (!Number.isInteger(v.minutes) || v.minutes < 1 || v.minutes > 240) fail(`Task ${id}: minutes must be 1 to 240`);
    const prompt = str(v.prompt, 'task prompt', 65536); if (!prompt.trim()) fail(`Task ${id}: prompt is empty`);
    return { id, title: str(v.title, 'task title', 100), files: v.files.map(normalizeFile), model: v.model, minutes: v.minutes, advisor: v.advisor === true, prompt };
  });
  const ids = new Set(tasks.map(t => t.id)); if (ids.size !== tasks.length) fail('Duplicate task ids');
  for (let i = 0; i < tasks.length; i++) for (let j = i + 1; j < tasks.length; j++) for (const a of tasks[i].files) for (const b of tasks[j].files) if (conflicts(a, b)) fail(`File ${b} is claimed by both ${tasks[i].id} and ${tasks[j].id}`);
  return { tests, approved: p.approved === true, tasks };
}
/** Next state, or null when the signal does not apply (hook signals repeat; callers ignore null). */
export function transition(state: TaskState, signal: Signal): TaskState | null {
  const live = state === 'working' || state === 'waiting' || state === 'attention';
  switch (signal) {
    case 'start': return state === 'planned' || state === 'done' ? 'working' : null;
    case 'retry': return state === 'attention' || state === 'done' || state === 'failed' || state === 'interrupted' ? 'working' : null;
    case 'waiting': return state === 'working' ? 'waiting' : null;
    case 'typed': return state === 'waiting' ? 'working' : null;
    case 'stop': return state === 'working' ? 'attention' : null;
    case 'done': return live ? 'done' : null;
    case 'failed': case 'exit': return live ? 'failed' : null;
  }
}
export const promptHeader = (t: Pick<Task, 'id' | 'minutes' | 'files'>): string =>
  `Task ${t.id} in worktree task-${t.id} (Claude Code created it; run git branch --show-current to see your branch). Budget: ${t.minutes} minutes.\n` +
  `Commit to this branch only. Do not edit files outside this worktree.\n` +
  `Files you own: ${t.files.join(', ')}. Do not touch any other file; if the task needs one, say so and stop.\n` +
  `When finished run: alphacode report done\nIf you cannot finish run: alphacode report failed "<one line reason>"\n\n`;
// eslint-disable-next-line no-control-regex
export const stripAnsi = (text: string): string => text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)|\x1b[()][A-Za-z0-9]/g, '');
export const lastLines = (text: string, n: number): string[] => text ? text.split(/\r?\n/).filter((l, i, a) => i < a.length - 1 || l !== '').slice(-n) : [];
export const emptyOrchestrate = (): OrchestrateConfig => ({ on: false, orchestratorPaneId: '', maxWorkers: 5, approved: false, tasks: [] });
const KEYS = ['on', 'orchestratorPaneId', 'maxWorkers', 'approved', 'tasks'], TASK_KEYS = ['id', 'title', 'files', 'model', 'minutes', 'advisor', 'state', 'paneId', 'branch', 'worktree', 'startedAt', 'finishedAt', 'retries', 'sessionId', 'message', 'hidden'];
/** Saved orchestrate block: never on after a load, live tasks become interrupted, no prompt text or tokens tolerated. */
export function validateOrchestrate(value: unknown, paneIds: string[]): OrchestrateConfig {
  const o = value as Record<string, any>; if (!o || typeof o !== 'object') fail('Invalid orchestrate configuration');
  for (const k of Object.keys(o)) if (!KEYS.includes(k)) fail(`Unknown orchestrate field ${k}`);
  if (!Number.isInteger(o.maxWorkers) || o.maxWorkers < 1 || o.maxWorkers > 5) fail('maxWorkers must be 1 to 5');
  // A closed pane is a normal way to leave the mode: drop what pointed at it instead of rejecting every later save.
  let orchestratorPaneId = o.orchestratorPaneId ? validateId(o.orchestratorPaneId) : ''; if (orchestratorPaneId && !paneIds.includes(orchestratorPaneId)) orchestratorPaneId = '';
  if (!Array.isArray(o.tasks) || o.tasks.length > 5) fail('tasks must list at most 5 tasks');
  const tasks: Task[] = o.tasks.map((v: any) => {
    if (!v || typeof v !== 'object') fail('Invalid task'); for (const k of Object.keys(v)) if (!TASK_KEYS.includes(k)) fail(k === 'prompt' ? 'Task prompt text is never saved' : `Unknown task field ${k}`);
    if (!TASK_STATES.includes(v.state) || !MODELS.includes(v.model) || !Number.isInteger(v.minutes) || !Number.isInteger(v.retries) || !Array.isArray(v.files)) fail('Invalid task');
    const paneId = v.paneId ? validateId(v.paneId) : '';
    const id = str(v.id, 'task id', 32); if (!ID_RE.test(id)) fail(`Task id ${JSON.stringify(id)} must match ^[a-z0-9-]{1,32}$`);
    const state: TaskState = v.state === 'working' || v.state === 'waiting' ? 'interrupted' : v.state;
    return { id, title: str(v.title, 'task title', 100), files: v.files.map(normalizeFile), model: v.model, minutes: v.minutes, advisor: v.advisor === true, state, paneId, branch: str(v.branch || '', 'branch', 200), worktree: str(v.worktree || '', 'worktree', 32768), startedAt: str(v.startedAt || '', 'startedAt', 40), finishedAt: str(v.finishedAt || '', 'finishedAt', 40), retries: v.retries, sessionId: str(v.sessionId || '', 'sessionId', 64), message: str(v.message || '', 'message', 2000), hidden: v.hidden === true };
  }).filter((t: Task) => !t.paneId || paneIds.includes(t.paneId));
  if (new Set(tasks.map(t => t.id)).size !== tasks.length) fail('Duplicate task ids');
  return { on: false, orchestratorPaneId, maxWorkers: o.maxWorkers, approved: o.approved === true, tasks };
}
