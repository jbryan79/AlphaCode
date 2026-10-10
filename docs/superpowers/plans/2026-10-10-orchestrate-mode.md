# Orchestrate Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A per-workspace Orchestrate toggle that gives one Claude Code pane a loopback control channel and a playbook, lets it run tasks as Claude Code sessions in worker panes with one git worktree each, shows task state as pane badges and a Tasks sidebar, and finishes with a toast and a vault note.

**Architecture:** Pure logic (plan validation, task state machine, prompt header, persistence validation) lives in `shared/orchestrate.ts` so tests need no filesystem. `electron/orchestrate.ts` holds `OrchestrateRun`: tokens, launch overrides, the HTTP control server and its endpoints, with every outside effect (git, relaunching a pane, asking a local model, finishing) injected so it is tested against a real server on a random port with fakes behind it. `electron/cli.ts` is the `alphacode` command, compiled with the main process and launched through a generated `.cmd` shim that runs Electron as Node. `main.ts` wires the run into the existing session path: `TerminalManager.start` takes launch overrides, PTY output is tapped for the last-lines ring, and keyboard input clears Waiting. The renderer owns the toggle, roles, badges, Tasks section, and relaunches panes when the run asks.

**Tech Stack:** TypeScript, Electron 44 (`node:http`, `Notification`), React 19, Vitest, Playwright. No new dependencies. Claude Code 2.1.296 flags: `--worktree`, `--model`, `--name`, `--settings`, `--session-id`, `--resume`, `--append-system-prompt-file`.

**Spec:** `docs/superpowers/specs/2026-10-10-orchestrate-mode-design.md`

## Global Constraints

- Tokens are 32 random bytes hex, minted per run, never written to state or disk except inside the generated hook settings file, which is deleted on finish or mode off.
- The control server binds `127.0.0.1` only, OS-assigned port, 1 MB body limit, `Authorization: Bearer <token>`, constant-time compare.
- Control endpoints reject the hook token; `/report` rejects the control token and a hook token whose pane id differs from the body's.
- Plan: 1 to `min(maxWorkers, workerPanes)` tasks; ids `^[a-z0-9-]{1,32}$` unique; files repo-relative, no `..`, no absolute paths, no file in two tasks, a trailing-slash entry claims everything beneath it; model `sonnet | opus | fable`; minutes 1 to 240; prompt text 1 to 65536 characters.
- Plan requires a git repository with a clean index (`git status --porcelain` shows only `??` lines).
- `task start` refuses unless the plan is approved and the task is `planned`, `attention`, `done`, `failed` or `interrupted`, and the pane is not already launching.
- Status returns at most the last 20 lines from a 4 KB ANSI-stripped ring; wait timeout is capped at 240 seconds.
- Worker launch flags: `--worktree task-<id> --model <m> --name "<title>" --settings <hooks file> --session-id <uuid>` plus the task prompt as the positional argument; the orchestrator gets `--append-system-prompt-file <playbook> --name Orchestrator`.
- Retry types into a PTY only for a pane this run launched, in state `attention`, `done` or `failed`; with the process gone it relaunches with `--resume <sessionId>` in the worktree.
- Persisted `Workspace.orchestrate` never holds tokens, port, or prompt text; export strips it; on load `working` and `waiting` become `interrupted` and `on` becomes false.
- Code style: match the repo's dense single-line style in `electron/` and `shared/`; commit trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Review Focus

1. Plan files written with Windows backslashes, mixed case, or a trailing slash on a folder must normalize before overlap checks, so `src\api\` and `src/api/handler.ts` conflict. Pinned in Task 1.
2. A `stop` or `waiting` report for a pane whose task is already `done`, `failed`, or `planned` must be ignored with 200, never flip the state and never 409, because the Stop hook fires on every turn. Pinned in Task 3.
3. Two `task start` calls for the same pane before the first launch resolves must refuse the second with 409 and leave one launch in flight. Pinned in Task 3.
4. A worker pane whose session the user stops or closes mid-task must become `failed`, not stay `working` forever. Pinned in Task 3 (exit signal) and Task 5 (stop-session wiring).
5. Restarting the orchestrator pane by hand mid-run must relaunch it with the same control environment and playbook, and tasks must survive. Pinned in Task 2 (overrides are stable per run) and checked manually in Task 7.

---

### Task 0: Spike the two unverified CLI behaviors

**Files:**
- Create: `work/orchestrate-spike/README.md` (throwaway notes, not committed)

**Interfaces:**
- Produces: facts recorded in the spec's "Verified" paragraph: the worktree path and branch name Claude Code creates for `--worktree task-x`, whether the positional prompt is sent as the first message in interactive mode together with `--worktree`, whether `--settings <file>` hooks run alongside user settings, and the hook `command` form that executes a `.cmd` shim on Windows.

- [ ] **Step 1: Create a throwaway git repo and a hook shim**

```powershell
New-Item -ItemType Directory -Force D:\Dev\AlphaCode\work\orchestrate-spike | Out-Null
Set-Location D:\Dev\AlphaCode\work\orchestrate-spike
git init -q; Set-Content a.txt 'a'; git add .; git commit -qm init
Set-Content -Encoding ascii hook.cmd '@echo %DATE% %TIME% hook-ran %1 >> "%~dp0hook.log"'
Set-Content -Encoding ascii hooks.json ('{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"\"' + ((Get-Location).Path -replace '\\','/') + '/hook.cmd\" stop"}]}]}}')
```

- [ ] **Step 2: Launch Claude interactively with the flags under test**

Run in a terminal, not through a tool:

```
claude --worktree task-x --name "spike" --settings hooks.json --session-id 00000000-0000-4000-8000-000000000001 "Reply with the word READY and nothing else."
```

Record: did Claude answer READY without a prompt being typed (positional prompt accepted)? After the answer, does `hook.log` contain `hook-ran stop`? Run `git worktree list --porcelain` in the repo and record the worktree path and the `branch refs/heads/...` line for the new worktree. Exit Claude.

- [ ] **Step 3: Verify resume in the worktree**

```
claude --resume 00000000-0000-4000-8000-000000000001 "Reply with the word AGAIN."
```

Run it from inside the worktree path recorded in Step 2. Record whether the session resumed and in which cwd (`/status` inside Claude shows it).

- [ ] **Step 4: Record the findings in the spec**

Edit the "Verified against Claude Code 2.1.296" paragraph of `docs/superpowers/specs/2026-10-10-orchestrate-mode-design.md`: replace the sentence about the two unexercised behaviors with the observed facts, including the exact worktree path pattern (expected `<repo>/.claude/worktrees/<name>`) and branch name pattern, and the hook command form that worked. If the positional prompt was NOT accepted with `--worktree`, stop and report; Task 3's launch then needs the retry path's PTY typing for the first message, which is a design change to raise with the user.

- [ ] **Step 5: Commit the spec update and delete the spike folder**

```bash
cd /d/Dev/AlphaCode && rm -rf work/orchestrate-spike
git add docs/superpowers/specs/2026-10-10-orchestrate-mode-design.md
git commit -m "docs(orchestrate): record spiked Claude Code worktree, prompt, hook and resume behavior

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 1: Shared types, plan validation, state machine, prompt header, persistence

**Files:**
- Modify: `shared/types.ts`
- Create: `shared/orchestrate.ts`
- Modify: `shared/domain.ts` (`validateWorkspace`, `applyPreset`)
- Create: `tests/orchestrate.test.ts`

**Interfaces:**
- Produces, in `shared/types.ts`:

```ts
export type TaskState = 'planned' | 'working' | 'waiting' | 'attention' | 'done' | 'failed' | 'interrupted';
export type TaskModel = 'sonnet' | 'opus' | 'fable';
export interface PlanTask { id: string; title: string; files: string[]; model: TaskModel; minutes: number; advisor: boolean; prompt: string; }
export interface Plan { tests: string; approved: boolean; tasks: PlanTask[]; }
/** Persisted task. `prompt` is never persisted; the run holds it in memory. */
export interface Task extends Omit<PlanTask, 'prompt'> { state: TaskState; paneId: string; branch: string; worktree: string; startedAt: string; finishedAt: string; retries: number; sessionId: string; message: string; hidden: boolean; }
export interface OrchestrateConfig { on: boolean; orchestratorPaneId: string; maxWorkers: number; approved: boolean; tasks: Task[]; }
/** `resume`: tasks left `interrupted` by an earlier run, so the new run can list them and retry them with --resume. */
export interface OrchestrateRoles { workspaceId: string; root: string; orchestratorPaneId: string; workerPaneIds: string[]; advisorPaneIds: string[]; maxWorkers: number; resume?: Task[]; }
export type OrchestrateEvent = { kind: 'tasks'; approved: boolean; tasks: Task[] } | { kind: 'launch'; paneId: string } | { kind: 'finished'; summary: string } | { kind: 'error'; message: string } | { kind: 'off' };
```

  `Workspace` gains `orchestrate?: OrchestrateConfig`. `BridgeApi` gains `orchestrateStart(roles: OrchestrateRoles): Promise<void>`, `orchestrateStop(): Promise<void>`, `approvePlan(): Promise<void>`, `onOrchestrateEvent(callback: (event: OrchestrateEvent) => void): () => void`.

- Produces, in `shared/orchestrate.ts`: `MODELS`, `TASK_STATES`, `TASK_LABELS`, `Signal`, `normalizeFile(path)`, `conflicts(a, b)`, `validatePlan(value, limits)`, `transition(state, signal)`, `promptHeader(task)`, `stripAnsi(text)`, `lastLines(text, n)`, `validateOrchestrate(value, paneIds)`, `emptyOrchestrate()`.
- Produces, in `shared/domain.ts`: `applyPreset(w, count, pad: PaneType = 'powershell')`; `validateWorkspace` accepts and validates `orchestrate`.

- [ ] **Step 1: Add the types**

In `shared/types.ts`, after `VaultTarget`, add the block from Interfaces above. Change `Workspace` to:

```ts
export interface Workspace { id: string; name: string; root: string; panes: PaneConfig[]; layout: GridItem[]; locked: boolean; orchestrate?: OrchestrateConfig; }
```

Append to `BridgeApi`:

```ts
  orchestrateStart(roles: OrchestrateRoles): Promise<void>;
  orchestrateStop(): Promise<void>;
  approvePlan(): Promise<void>;
  onOrchestrateEvent(callback: (event: OrchestrateEvent) => void): () => void;
```

- [ ] **Step 2: Write the failing tests**

Create `tests/orchestrate.test.ts`:

```ts
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
    const p = validatePlan(plan([t('a', ['src\\API\\x.ts']), t('b', ['src/api/'])]), limits);
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
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/orchestrate.test.ts`
Expected: FAIL, "Cannot find module '../shared/orchestrate'".

- [ ] **Step 4: Create `shared/orchestrate.ts`**

```ts
import type { OrchestrateConfig, Plan, PlanTask, Task, TaskModel, TaskState } from './types';
import { string as str, validateId } from './domain';

export const MODELS: readonly TaskModel[] = ['sonnet', 'opus', 'fable'];
export const TASK_STATES: readonly TaskState[] = ['planned', 'working', 'waiting', 'attention', 'done', 'failed', 'interrupted'];
export const TASK_LABELS: Record<TaskState, string> = { planned: 'Planned', working: 'Working', waiting: 'Waiting', attention: 'Needs attention', done: 'Task done', failed: 'Failed', interrupted: 'Interrupted' };
export type Signal = 'start' | 'waiting' | 'typed' | 'stop' | 'retry' | 'done' | 'failed' | 'exit';
const fail = (m: string): never => { throw new Error(m); };

/** Repo-relative, forward slashes, no leading ./; keeps a trailing slash (a folder claim). Throws on anything that could leave the repo. */
export function normalizeFile(value: unknown): string {
  const raw = str(value, 'file path', 1024).replace(/\\/g, '/').replace(/^\.\//, '');
  if (!raw || /^([A-Za-z]:|\/)/.test(raw) || raw.split('/').includes('..') || /^~/.test(raw)) fail(`File path ${JSON.stringify(raw)} is outside the repository`);
  return raw.replace(/\/{2,}/g, '/');
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
    const id = str(v.id, 'task id', 32); if (!/^[a-z0-9-]{1,32}$/.test(id)) fail(`Task id ${JSON.stringify(id)} must match ^[a-z0-9-]{1,32}$`);
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
  const orchestratorPaneId = o.orchestratorPaneId ? validateId(o.orchestratorPaneId) : ''; if (orchestratorPaneId && !paneIds.includes(orchestratorPaneId)) fail('Orchestrator pane is not in this workspace');
  if (!Array.isArray(o.tasks) || o.tasks.length > 5) fail('tasks must list at most 5 tasks');
  const tasks: Task[] = o.tasks.map((v: any) => {
    if (!v || typeof v !== 'object') fail('Invalid task'); for (const k of Object.keys(v)) if (!TASK_KEYS.includes(k)) fail(k === 'prompt' ? 'Task prompt text is never saved' : `Unknown task field ${k}`);
    if (!TASK_STATES.includes(v.state) || !MODELS.includes(v.model) || !Number.isInteger(v.minutes) || !Number.isInteger(v.retries) || !Array.isArray(v.files)) fail('Invalid task');
    const paneId = v.paneId ? validateId(v.paneId) : ''; if (paneId && !paneIds.includes(paneId)) fail('Task pane is not in this workspace');
    const state: TaskState = v.state === 'working' || v.state === 'waiting' ? 'interrupted' : v.state;
    return { id: str(v.id, 'task id', 32), title: str(v.title, 'task title', 100), files: v.files.map(normalizeFile), model: v.model, minutes: v.minutes, advisor: v.advisor === true, state, paneId, branch: str(v.branch || '', 'branch', 200), worktree: str(v.worktree || '', 'worktree', 32768), startedAt: str(v.startedAt || '', 'startedAt', 40), finishedAt: str(v.finishedAt || '', 'finishedAt', 40), retries: v.retries, sessionId: str(v.sessionId || '', 'sessionId', 64), message: str(v.message || '', 'message', 2000), hidden: v.hidden === true };
  });
  return { on: false, orchestratorPaneId, maxWorkers: o.maxWorkers, approved: o.approved === true, tasks };
}
```

- [ ] **Step 5: Wire `validateWorkspace` and `applyPreset` in `shared/domain.ts`**

Change `applyPreset`:

```ts
export function applyPreset(w: Workspace, count: typeof PRESETS[number], pad: PaneType = 'powershell'): Workspace {
  const panes=w.panes.slice(0,count); while(panes.length<count)panes.push(createPane(pad,w.root));
  return {...w,panes,layout:balancedLayout(panes)};
}
```

In `validateWorkspace`, replace the final `return` with:

```ts
  const base:Workspace={id:validateId(w.id),name:string(w.name,'workspace name',100),root:string(w.root,'project directory'),panes,layout,locked:w.locked};
  return w.orchestrate===undefined?base:{...base,orchestrate:validateOrchestrate(w.orchestrate,panes.map(p=>p.id))};
```

Add the import at the top of `shared/domain.ts`: `import { validateOrchestrate } from './orchestrate';`. `shared/orchestrate.ts` imports `string` and `validateId` from `./domain`, which is a cycle; it is safe because both modules only use each other's exports inside functions, never at module load. Keep it that way.

- [ ] **Step 6: Run the tests and the type check**

Run: `npx vitest run tests/orchestrate.test.ts && npx tsc --noEmit -p tsconfig.json && npx tsc --noEmit -p tsconfig.electron.json`
Expected: all PASS, no type errors. The export handler in `main.ts` still serializes `orchestrate`; Task 5 strips it.

- [ ] **Step 7: Commit**

```bash
git add shared/types.ts shared/orchestrate.ts shared/domain.ts tests/orchestrate.test.ts
git commit -m "feat(orchestrate): plan validation, task state machine, prompt header and persisted config

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: OrchestrateRun — tokens, shim, launch overrides, output ring

**Files:**
- Create: `electron/orchestrate.ts`
- Modify: `electron/terminals.ts` (`start` overrides)
- Modify: `tests/orchestrate.test.ts` (append)

**Interfaces:**
- Produces:

```ts
export interface LaunchOverrides { env?: Record<string, string>; args?: string[]; cwd?: string; }
export interface RunDeps {
  runDir: string; execPath: string; cliPath: string; playbookPath: string; roles: OrchestrateRoles;
  panes: () => PaneConfig[];                                   // current panes of the active workspace
  git: (args: string[], cwd: string) => Promise<string>;       // stdout, throws on non-zero
  launch: (paneId: string) => Promise<void>;                   // relaunch the pane; resolves on running, rejects on error/exit
  chat: (paneId: string, prompt: string) => Promise<string>;   // advisor answer
  finish: (report: string, summary: string, run: { tasks: Task[]; plan: Plan | null }) => Promise<void>;
  emit: (event: OrchestrateEvent) => void;
  log: (message: string) => void;
  now?: () => number;
}
export class OrchestrateRun {
  constructor(deps: RunDeps);
  readonly port: number; readonly controlToken: string;
  start(): Promise<number>; stop(): Promise<void>;
  overrides(paneId: string): LaunchOverrides | null;
  tap(paneId: string, data: string): void; exited(paneId: string): void; typed(paneId: string): void; approve(): void;
  tasks(): Task[]; handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
}
```
- `TerminalManager.start(pane, cols, rows, overrides?: LaunchOverrides)`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/orchestrate.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/orchestrate.test.ts -t OrchestrateRun`
Expected: FAIL, "Cannot find module '../electron/orchestrate'".

- [ ] **Step 3: Add overrides to `TerminalManager.start`**

In `electron/terminals.ts`, add the type after the `PtyFactory` type:

```ts
export interface LaunchOverrides {env?:Record<string,string>;args?:string[];cwd?:string}
```

Change the `start` signature and the three lines that build `env`, `args` and the spawn `cwd`:

```ts
  async start(value:PaneConfig,cols:number,rows:number,overrides:LaunchOverrides={}):Promise<void>{
    const pane=validatePane(value);const size=terminalSize(cols,rows);const cwd=overrides.cwd||pane.cwd;
    ...
    try{await assertDirectory(cwd);if(this.pending.get(pane.id)!==token)return;const file=this.resolve(pane);const env={...process.env,...overrides.env};delete env.ELECTRON_RUN_AS_NODE;delete env.ALPHACODE_DATA_DIR;
      const args=[...(pane.args.length?pane.args:(pane.type==='powershell'?['-NoLogo','-NoProfile']:[])),...(overrides.args||[])];
      const launch=executableLaunch(file,args);const terminal=this.spawn(launch.file,launch.args,{name:'xterm-256color',...size,cwd,env,useConpty:true,useConptyDll:true});
```

Everything else in `start` stays as it is.

- [ ] **Step 4: Create `electron/orchestrate.ts` with the run skeleton**

```ts
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
    const env = { ...this.pathEnv(), ALPHACODE_HOOK_TOKEN: l.hookToken, ALPHACODE_PANE_ID: paneId };
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
  exited(paneId: string): void { this.launching.delete(paneId); this.signal(paneId, 'exit', 'Process exited without a report.'); }
  typed(paneId: string): void { const l = this.live.get(paneId); if (!l) return; if (l.task.state === 'done' || l.task.state === 'failed') { if (!l.task.hidden) { l.task.hidden = true; this.bump(); } return; } this.signal(paneId, 'typed'); }
  approve(): void { if (this.plan) { this.plan.approved = true; this.bump(); } }
  protected authorized(req: IncomingMessage, expected: string): boolean { const got = (req.headers.authorization || '').replace(/^Bearer\s+/i, ''); return got.length === expected.length && timingSafeEqual(Buffer.from(got), Buffer.from(expected)); }
  protected mintTask(task: Task, prompt: string): Live { const hookToken = token(); return { task, prompt, hookToken, hooksFile: join(this.deps.runDir, `hooks-${task.paneId}.json`) }; }
  protected hooksJson(): string { const shim = join(this.deps.runDir, 'alphacode.cmd').replace(/\\/g, '/'); const hook = (k: string) => [{ hooks: [{ type: 'command', command: `"${shim}" report ${k}` }] }]; return JSON.stringify({ hooks: { Stop: hook('stop'), Notification: hook('waiting') } }); }
  protected uuid(): string { return randomUUID(); }
  protected ensureId(id: string): string { return validateId(id); }
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/orchestrate.test.ts && npx tsc --noEmit -p tsconfig.electron.json`
Expected: PASS. `runtime.test.ts` still passes because `overrides` defaults to `{}`.

- [ ] **Step 6: Commit**

```bash
git add electron/orchestrate.ts electron/terminals.ts tests/orchestrate.test.ts
git commit -m "feat(orchestrate): run skeleton with tokens, CLI shim, launch overrides and output ring; terminal launch overrides

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Control server endpoints, auth, wait, report

**Files:**
- Modify: `electron/orchestrate.ts`
- Modify: `tests/orchestrate.test.ts` (append)

**Interfaces:**
- Consumes: `RunDeps`, `transition`, `validatePlan`.
- Produces: HTTP endpoints exactly as the spec table: `GET /panes`, `POST /plan`, `POST /tasks/:id/start`, `GET /tasks/:id`, `GET /tasks`, `GET /tasks/wait?ids=a,b&timeout=240`, `POST /tasks/:id/retry`, `POST /ask/:paneId`, `POST /finish`, `POST /report`. Responses are JSON; errors are `{ error: string }` with 400 (bad input), 401 (token), 404 (unknown), 409 (wrong state).

- [ ] **Step 1: Write the failing tests**

Append to `tests/orchestrate.test.ts`:

```ts
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
    expect((await call(f.run, f.run.controlToken, 'POST', '/tasks/api/start')).status).toBe(409);
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/orchestrate.test.ts -t "control server"`
Expected: FAIL on `hookTokenFor is not a function` and 404s.

- [ ] **Step 3: Implement the router and endpoints in `electron/orchestrate.ts`**

Add these members to `OrchestrateRun` (replace the placeholder `handle`):

```ts
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
  private async setPlan(body: unknown): Promise<Plan & { tasks: Task[] }> {
    const { roles } = this.deps; const workers = roles.workerPaneIds.filter(id => this.deps.panes().some(p => p.id === id && p.type === 'claude'));
    const plan = validatePlan(body, { maxWorkers: roles.maxWorkers, workerPanes: workers.length });
    try { await this.deps.git(['rev-parse', '--is-inside-work-tree'], roles.root); } catch { this.err(400, `${roles.root} is not a git repository; Orchestrate needs one for worktrees`); }
    if ((await this.deps.git(['status', '--porcelain'], roles.root)).split(/\r?\n/).some(l => l && !l.startsWith('??'))) this.err(400, 'The git index is not clean; commit or stash before planning');
    const kept = new Map([...this.live.entries()].filter(([, l]) => l.task.state !== 'planned'));
    const free = workers.filter(id => !kept.has(id)); this.live = kept;
    for (const pt of plan.tasks) { if ([...kept.values()].some(l => l.task.id === pt.id)) continue; const paneId = free.shift(); if (!paneId) this.err(409, 'No free worker pane for the plan'); const { prompt, ...rest } = pt; const task: Task = { ...rest, state: 'planned', paneId, branch: '', worktree: '', startedAt: '', finishedAt: '', retries: 0, sessionId: '', message: '', hidden: false }; this.live.set(paneId, this.mintTask(task, prompt)); }
    this.plan = { ...plan, approved: plan.approved || this.plan?.approved === true }; this.bump();
    return { ...this.plan, tasks: this.tasks() };
  }
  private async launchPane(l: Live, signal: Signal): Promise<Task> {
    const id = l.task.paneId; if (this.launching.has(id)) this.err(409, `Pane ${id} is already launching`);
    if (!transition(l.task.state, signal)) this.err(409, `Task ${l.task.id} is ${l.task.state}`);
    await writeFile(l.hooksFile, this.hooksJson(), 'utf8'); this.launching.add(id);
    try { await this.deps.launch(id); this.signal(id, signal); } catch (error) { this.launching.delete(id); l.task.state = 'failed'; l.task.message = (error as Error).message; this.bump(); throw error; }
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
    t.sessionId = this.uuid(); t.startedAt = new Date(this.now()).toISOString(); t.finishedAt = ''; t.retries = 0; t.message = ''; t.hidden = false;
    return this.launchPane(l, 'start');
  }
  private async retry(id: string, body: any): Promise<Task> {
    const t = this.find(id); const l = this.live.get(t.paneId)!; const feedback = typeof body.feedback === 'string' ? body.feedback.trim() : ''; if (!feedback || feedback.length > 65536) this.err(400, 'feedback is required (1 to 65536 characters)');
    if (!transition(t.state, 'retry')) this.err(409, `Task ${id} is ${t.state}`); if (t.retries >= 2) this.err(409, `Task ${id} already retried twice`);
    t.retries++; t.message = ''; t.finishedAt = '';
    if (this.alive(t.paneId)) { this.writer(t.paneId, feedback.replace(/\r?\n/g, ' ') + '\r'); this.signal(t.paneId, 'retry'); return t; }
    if (!t.sessionId || !t.worktree) this.err(409, `Task ${id} has no session to resume`);
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
      const done = (changed: boolean) => { clearTimeout(timer); this.waiters = this.waiters.filter(w => w !== check); resolve({ changed, tasks: pick() }); };
      const check = () => { if (JSON.stringify(pick().map(t => [t.id, t.state, t.retries])) !== snapshot || !this.server) done(JSON.stringify(pick().map(t => [t.id, t.state, t.retries])) !== snapshot); };
      const timer = setTimeout(() => done(false), ms); this.waiters.push(check);
    });
  }
  private async ask(paneId: string, body: any): Promise<{ answer: string }> {
    this.ensureId(paneId); if (this.roleOf(paneId) !== 'advisor') this.err(400, `Pane ${paneId} is not an advisor (Local Model) pane`);
    const prompt = typeof body.prompt === 'string' ? body.prompt : ''; if (!prompt.trim() || prompt.length > 262144) this.err(400, 'prompt is required (1 to 262144 characters)');
    return { answer: await this.deps.chat(paneId, prompt) };
  }
  private async finish(body: any): Promise<{ summary: string }> {
    if (this.finished) this.err(409, 'This run already finished'); const report = typeof body.report === 'string' ? body.report.trim() : ''; if (!report || report.length > 1048576) this.err(400, 'report is required');
    const summary = report.split(/\r?\n/).map(l => l.replace(/^#+\s*/, '').trim()).filter(l => l && !/^report$/i.test(l))[0] || 'Finished'; this.finished = true;
    await this.deps.finish(report, summary.slice(0, 200), { tasks: this.tasks(), plan: this.plan }); this.deps.emit({ kind: 'finished', summary: summary.slice(0, 200) }); return { summary };
  }
```

`signal` from Task 2 is reused as is. `bump` wakes waiters, which is what makes `wait` resolve.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/orchestrate.test.ts && npx tsc --noEmit -p tsconfig.electron.json`
Expected: PASS. If the "refuses a second start" test is flaky, raise its 20 ms settle to 50 ms; do not change the server.

- [ ] **Step 5: Commit**

```bash
git add electron/orchestrate.ts tests/orchestrate.test.ts
git commit -m "feat(orchestrate): control server with plan, start, status, wait, retry, ask, finish and worker reports

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: The `alphacode` command

**Files:**
- Create: `electron/cli.ts`
- Modify: `tests/orchestrate.test.ts` (append)

**Interfaces:**
- Consumes: the endpoints from Task 3; env `ALPHACODE_CONTROL_URL`, `ALPHACODE_CONTROL_TOKEN`, `ALPHACODE_HOOK_TOKEN`, `ALPHACODE_PANE_ID`.
- Produces: `electron/cli.ts` exporting `main(argv: string[], env: NodeJS.ProcessEnv, stdin: NodeJS.ReadableStream | null): Promise<{ code: number; out: string; err: string }>` and running `main(process.argv.slice(2), process.env, process.stdin)` when executed directly.

- [ ] **Step 1: Write the failing tests**

Append to `tests/orchestrate.test.ts`:

```ts
import { mkdtemp as mkTemp, writeFile as write } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { main as cli } from '../electron/cli';

describe('alphacode command', () => {
  it('runs every subcommand against the server and prints JSON', async () => {
    const f = await fixture(); const dir = await mkTemp(join(tmpdir(), 'alphacode-cli-'));
    const ctl = { ALPHACODE_CONTROL_URL: `http://127.0.0.1:${f.run.port}`, ALPHACODE_CONTROL_TOKEN: f.run.controlToken };
    const run = (args: string[], env: Record<string, string> = ctl, stdin: NodeJS.ReadableStream | null = null) => cli(args, env, stdin);
    expect(JSON.parse((await run(['panes'])).out)).toHaveLength(4);
    await write(join(dir, 'api.md'), 'Build the endpoint.'); await write(join(dir, 'ui.md'), 'Build the screen.');
    await write(join(dir, 'plan.json'), JSON.stringify({ tests: 'npm test', tasks: [{ id: 'api', title: 'API', files: ['electron/api.ts'], model: 'sonnet', minutes: 20, advisor: true, prompt: 'api.md' }, { id: 'ui', title: 'UI', files: ['src/'], model: 'fable', minutes: 30, advisor: false, prompt: 'ui.md' }] }));
    const planned = await run(['plan', join(dir, 'plan.json')]); expect(planned.code).toBe(0); expect(JSON.parse(planned.out).tasks[0].paneId).toBe('p2');
    expect((await run(['task', 'start', 'api'])).code).toBe(1); // not approved
    expect((await run(['plan', join(dir, 'plan.json'), '--approved'])).code).toBe(0);
    expect(JSON.parse((await run(['task', 'start', 'api'])).out).state).toBe('working');
    const hook = { ALPHACODE_HOOK_TOKEN: f.run.hookTokenFor('p2'), ALPHACODE_PANE_ID: 'p2' };
    expect((await run(['report', 'waiting'], hook, Readable.from([JSON.stringify({ notification_type: 'permission_prompt' })]))).code).toBe(0); expect(f.run.tasks()[0].state).toBe('waiting');
    f.run.typed('p2');
    expect((await run(['report', 'done'], hook)).code).toBe(0); expect(f.run.tasks()[0].state).toBe('done');
    expect((await run(['report', 'done'], ctl)).code).toBe(1); // control env cannot report
    expect(JSON.parse((await run(['task', 'status', 'api'])).out).state).toBe('done');
    expect(JSON.parse((await run(['task', 'status'])).out)).toHaveLength(2);
    expect(JSON.parse((await run(['task', 'wait', 'ui', '--timeout', '0.1'])).out).changed).toBe(false);
    await write(join(dir, 'fb.md'), 'fix tests'); f.run.writer = () => {}; f.run.alive = () => true;
    expect(JSON.parse((await run(['task', 'retry', 'api', join(dir, 'fb.md')])).out).retries).toBe(1);
    await write(join(dir, 'q.md'), 'review'); expect(JSON.parse((await run(['ask', 'p4', join(dir, 'q.md')])).out).answer).toBe('advice');
    await write(join(dir, 'r.md'), 'All done.'); expect(JSON.parse((await run(['finish', join(dir, 'r.md')])).out).summary).toBe('All done.');
    const bad = await run(['nope']); expect(bad.code).toBe(1); expect(bad.err).toMatch(/usage/i);
    expect((await run(['panes'], {})).err).toMatch(/ALPHACODE_CONTROL_URL/);
    await f.run.stop(); await rm(dir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/orchestrate.test.ts -t "alphacode command"`
Expected: FAIL, "Cannot find module '../electron/cli'".

- [ ] **Step 3: Create `electron/cli.ts`**

```ts
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const USAGE = `usage: alphacode <command>
  panes                                   list panes with roles and task states
  plan <plan.json> [--approved]           post the task split (prompt files resolve next to the plan)
  task start <id>                         launch the worker for a task
  task status [id]                        state, elapsed seconds, branch, last lines
  task wait [id ...] [--timeout <s>]      block until a listed task changes (max 240 s)
  task retry <id> <feedback.md>           send feedback to the worker, keeping its context
  ask <paneId> <prompt.md>                ask a Local Model (advisor) pane
  finish <report.md>                      mark the run done, toast, vault note
  report done|failed|stop|waiting [msg]   worker only: report this pane's own status`;

async function stdinJson(stdin: NodeJS.ReadableStream | null): Promise<any> {
  if (!stdin || (stdin as any).isTTY) return {};
  const text = await Promise.race([new Promise<string>(r => { let s = ''; stdin.on('data', c => { s += c; }); stdin.on('end', () => r(s)); stdin.on('error', () => r(s)); }), new Promise<string>(r => setTimeout(() => r(''), 300))]);
  try { return text.trim() ? JSON.parse(text) : {}; } catch { return {}; }
}
const text = async (file: string, max: number) => { const t = await readFile(resolve(file), 'utf8'); if (t.length > max) throw new Error(`${file} exceeds ${max} characters`); return t; };

export async function main(argv: string[], env: NodeJS.ProcessEnv, stdin: NodeJS.ReadableStream | null): Promise<{ code: number; out: string; err: string }> {
  const [cmd, ...rest] = argv; const flag = (name: string) => { const i = rest.indexOf(name); return i >= 0 ? rest.splice(i, 2)[1] : undefined; }; const has = (name: string) => { const i = rest.indexOf(name); if (i >= 0) rest.splice(i, 1); return i >= 0; };
  try {
    if (cmd === 'report') {
      const url = env.ALPHACODE_CONTROL_URL, token = env.ALPHACODE_HOOK_TOKEN, paneId = env.ALPHACODE_PANE_ID; if (!token || !paneId) throw new Error('report runs only inside a worker pane (ALPHACODE_HOOK_TOKEN and ALPHACODE_PANE_ID are set there)');
      const [kind, ...msg] = rest; if (!['done', 'failed', 'stop', 'waiting'].includes(kind || '')) throw new Error(USAGE);
      const input = await stdinJson(stdin);
      return await send(url || env.ALPHACODE_HOOK_URL || '', token, 'POST', '/report', { paneId, kind, message: msg.join(' '), notificationType: input.notification_type });
    }
    const url = env.ALPHACODE_CONTROL_URL, token = env.ALPHACODE_CONTROL_TOKEN; if (!url || !token) throw new Error('ALPHACODE_CONTROL_URL and ALPHACODE_CONTROL_TOKEN are missing; alphacode runs inside the orchestrator pane');
    const api = (method: string, path: string, body?: unknown) => send(url, token, method, path, body);
    switch (cmd) {
      case 'panes': return await api('GET', '/panes');
      case 'plan': { const approved = has('--approved'); const file = rest[0]; if (!file) throw new Error(USAGE); const plan = JSON.parse(await text(file, 1048576)); const base = dirname(resolve(file));
        if (Array.isArray(plan.tasks)) for (const t of plan.tasks) if (typeof t?.prompt === 'string' && /\.md$/i.test(t.prompt)) t.prompt = await text(resolve(base, t.prompt), 65536);
        return await api('POST', '/plan', { ...plan, approved }); }
      case 'task': { const [sub, ...a] = rest;
        if (sub === 'start' && a[0]) return await api('POST', `/tasks/${a[0]}/start`);
        if (sub === 'status') return await api('GET', a[0] ? `/tasks/${a[0]}` : '/tasks');
        if (sub === 'wait') { const timeout = flag('--timeout'); return await api('GET', `/tasks/wait?ids=${encodeURIComponent(rest.slice(1).join(','))}&timeout=${encodeURIComponent(timeout || '240')}`); }
        if (sub === 'retry' && a[0] && a[1]) return await api('POST', `/tasks/${a[0]}/retry`, { feedback: await text(a[1], 65536) });
        throw new Error(USAGE); }
      case 'ask': if (rest[0] && rest[1]) return await api('POST', `/ask/${rest[0]}`, { prompt: await text(rest[1], 262144) }); throw new Error(USAGE);
      case 'finish': if (rest[0]) return await api('POST', '/finish', { report: await text(rest[0], 1048576) }); throw new Error(USAGE);
      default: throw new Error(USAGE);
    }
  } catch (error) { return { code: 1, out: '', err: (error as Error).message }; }
}
async function send(url: string, token: string, method: string, path: string, body?: unknown): Promise<{ code: number; out: string; err: string }> {
  if (!url) throw new Error('ALPHACODE_CONTROL_URL is missing');
  const r = await fetch(url.replace(/\/$/, '') + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
  return r.ok ? { code: 0, out: JSON.stringify(data, null, 2), err: '' } : { code: 1, out: '', err: `${r.status}: ${(data as any).error || 'request failed'}` };
}
if (require.main === module) void main(process.argv.slice(2), process.env, process.stdin).then(r => { if (r.out) process.stdout.write(r.out + '\n'); if (r.err) process.stderr.write(r.err + '\n'); process.exitCode = r.code; });
```

Workers need the server URL for `report`; Task 5 adds `ALPHACODE_CONTROL_URL` to the worker env as well (the URL is not secret; the token is). Update `overrides` in `electron/orchestrate.ts` so the worker env includes `ALPHACODE_CONTROL_URL: \`http://127.0.0.1:${this.port}\``, and add to the Task 2 test: `expect(f.run.overrides('p2')!.env!.ALPHACODE_CONTROL_URL).toBeDefined()` inside the "refuses a second start" test where overrides are non-null. Remove the `ALPHACODE_HOOK_URL` fallback from the CLI once that is done.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/orchestrate.test.ts && npx tsc --noEmit -p tsconfig.electron.json`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add electron/cli.ts electron/orchestrate.ts tests/orchestrate.test.ts
git commit -m "feat(orchestrate): alphacode command line for the orchestrator and worker reports

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Main process wiring, bridge, vault note, toast, playbook file

**Files:**
- Modify: `electron/main.ts`
- Modify: `electron/preload.ts`
- Modify: `electron/runtime-core.ts` (`StateStore.current`)
- Modify: `electron/vault.ts` (`writeNote`)
- Create: `public/orchestrate.md`
- Modify: `tests/orchestrate.test.ts` (append), `tests/runtime.test.ts` (append)

**Interfaces:**
- Consumes: `OrchestrateRun`, `LaunchOverrides`, `MemoryVault`.
- Produces: IPC `bridge:orchestrate-start`, `bridge:orchestrate-stop`, `bridge:approve-plan`, event channel `bridge:orchestrate-event`; `StateStore.current: AppState | null`; `MemoryVault.writeNote(folder: string, name: string, text: string): Promise<string>`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/runtime.test.ts`:

```ts
describe('state store current snapshot', () => {
  it('exposes the last validated saved state', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'alphacode-cur-')); const store = new StateStore(join(dir, 'state.json'));
    expect(store.current).toBeNull(); await store.save(state); expect(store.current?.activeWorkspaceId).toBe('w1');
    await expect(store.save({ ...state, version: 2 })).rejects.toThrow(); expect(store.current?.activeWorkspaceId).toBe('w1');
  });
});
```

Append to `tests/orchestrate.test.ts`:

```ts
import { MemoryVault } from '../electron/vault';
describe('vault run notes', () => {
  it('writes a note under the vault folder with a safe name and returns its path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alphacode-note-')); const vault = new MemoryVault(join(root, 'vault'), join(root, 'claude'), 'x', join(root, 'obsidian.json'), {} as any);
    const file = await vault.writeNote('AlphaCode Runs', '2026-10-10 add export: endpoint?', '---\nname: run\n---\nbody\n');
    expect(file).toBe(join(root, 'vault', 'AlphaCode Runs', '2026-10-10 add export_ endpoint_.md')); expect(await readFile(file, 'utf8')).toContain('body');
    await expect(vault.writeNote('../x', 'n', 't')).rejects.toThrow(); await rm(root, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/runtime.test.ts tests/orchestrate.test.ts`
Expected: FAIL on `store.current` undefined and `writeNote is not a function`.

- [ ] **Step 3: Add `StateStore.current` and `MemoryVault.writeNote`**

In `electron/runtime-core.ts`, inside `StateStore` add `current:AppState|null=null;` after `private recoveryRequired=false;`, set `this.current=state;` in `load()` right before each `return state;`, and in `save()` right after `state=validateState(value)` succeeds add `this.current=state;`.

In `electron/vault.ts`, add to `MemoryVault` after `register()`:

```ts
  /** Writes a note the user asked for (a run report) under a vault subfolder. Folder and name are sanitized; never overwrites an existing file. */
  async writeNote(folder: string, name: string, text: string): Promise<string> {
    if (!folder.trim() || folder !== sanitizeName(folder)) throw new Error('Note folder must be a plain folder name inside the vault'); const dir = join(this.path, folder);
    await mkdir(dir, { recursive: true }); let file = join(dir, `${sanitizeName(name)}.md`), n = 1;
    while (existsSync(file)) file = join(dir, `${sanitizeName(name)} (${++n}).md`);
    await writeFile(file, text, 'utf8'); return file;
  }
```

Add `sanitizeName` to the import from `../shared/vault`.

- [ ] **Step 4: Wire `main.ts`**

Add imports: `import { Notification } from 'electron';` (merge into the existing electron import), `import { OrchestrateRun } from './orchestrate';`, `import { emptyOrchestrate, validateOrchestrate } from '../shared/orchestrate';`, `import type { OrchestrateEvent, OrchestrateRoles, Plan, Task } from '../shared/types';`, `import { copyFile, rm } from 'node:fs/promises';` (merge), `import { existsSync } from 'node:fs';` (merge), `import { randomUUID } from 'node:crypto';`.

After `const vault=...`, add:

```ts
let run:OrchestrateRun|null=null;
const pendingLaunches=new Map<string,{resolve:()=>void;reject:(e:Error)=>void}>();
const lastStates=new Map<string,string>();
const emitOrchestrate=(event:OrchestrateEvent)=>{
  // A worker that just entered Waiting needs the user; one toast per entry, like the finish toast.
  if(event.kind==='tasks')for(const t of event.tasks){if(t.state==='waiting'&&lastStates.get(t.id)!=='waiting')new Notification({title:'Worker needs you',body:`${t.title}: ${t.message||'waiting for input'}`}).show();lastStates.set(t.id,t.state);}
  if(event.kind==='off')lastStates.clear();
  if(window&&!window.isDestroyed())window.webContents.send('bridge:orchestrate-event',event);
};
const git=(args:string[],cwd:string)=>new Promise<string>((resolve,reject)=>execFile('git',args,{cwd,windowsHide:true,timeout:30000,maxBuffer:4*1024*1024},(error,stdout,stderr)=>error?reject(new Error(stderr.trim()||error.message)):resolve(stdout)));
const activePanes=()=>{const s=stateStore.current;return s?.workspaces.find(w=>w.id===s.activeWorkspaceId)?.panes||[];};
const runNote=(report:string,summary:string,r:{tasks:Task[];plan:Plan|null},roles:OrchestrateRoles)=>{
  const date=new Date().toISOString().slice(0,10),project=roles.root.split(/[\\/]/).filter(Boolean).pop()||'project';
  const rows=r.tasks.map(t=>`| ${t.id} | ${t.title} | ${t.state} | ${t.branch||''} | ${t.model} | ${t.retries} | ${t.message.replace(/\|/g,'/')} |`).join('\n');
  return `---\nname: run-${date}-${summary.toLowerCase().replace(/[^a-z0-9]+/g,'-').slice(0,40)}\ndescription: ${summary.replace(/\n/g,' ')}\nmetadata:\n  type: run\n  project: ${project}\n---\n# Orchestrate run ${date}: ${summary}\n\nProject: \`${roles.root}\`\nTest command: \`${r.plan?.tests||''}\`\n\n## Tasks\n\n| id | title | outcome | branch | model | retries | note |\n|---|---|---|---|---|---|---|\n${rows}\n\n## Report\n\n${report}\n`;
};
```

Change `const emit=` to tap output and resolve launches:

```ts
const emit=(event:SessionEvent)=>{
  if(event.kind==='data'&&event.data)run?.tap(event.paneId,event.data);
  if(event.kind==='status'){const p=pendingLaunches.get(event.paneId);if(p&&event.status==='running'){pendingLaunches.delete(event.paneId);p.resolve();}else if(p&&(event.status==='error'||event.status==='exited')){pendingLaunches.delete(event.paneId);p.reject(new Error(event.message||`Pane ${event.status}`));}
    if(event.status==='exited'||event.status==='error')run?.exited(event.paneId);}
  if(window&&!window.isDestroyed())window.webContents.send('bridge:session-event',event);
};
```

Change the start and write handlers and add the new ones inside `registerIpc`:

```ts
  handle('bridge:start-session',async(value:PaneConfig,cols:number,rows:number)=>{const pane=validatePane(value);if(pane.type==='powershell-admin'){/* unchanged admin branch */}else{if(admins.has(pane.id))throw new Error('Stop the Admin PowerShell session before changing its type.');await terminals.start(pane,cols,rows,run?.overrides(pane.id)||{});}});
  listen('bridge:write-session',(id:string,data:string)=>{if(admins.has(id))admins.write(id,data);else{terminals.write(id,data);run?.typed(id);}});
  handle('bridge:export-workspace',async value=>{const {orchestrate:_o,...workspace}=validateWorkspace(value); /* rest unchanged, serializes `workspace` */});
  handle('bridge:orchestrate-start',async(value:OrchestrateRoles)=>{
    if(run)await run.stop().catch(()=>{});
    const workerPaneIds=(value.workerPaneIds||[]).slice(0,5).map(validateId);
    const resume=validateOrchestrate({...emptyOrchestrate(),tasks:Array.isArray(value.resume)?value.resume.slice(0,5):[]},workerPaneIds).tasks.filter(t=>t.state==='interrupted');
    const roles:OrchestrateRoles={workspaceId:validateId(value.workspaceId),root:str(value.root,'project directory'),orchestratorPaneId:validateId(value.orchestratorPaneId),workerPaneIds,advisorPaneIds:(value.advisorPaneIds||[]).slice(0,5).map(validateId),maxWorkers:Math.min(5,Math.max(1,Number(value.maxWorkers)||5)),resume};
    const playbookPath=join(app.getPath('userData'),'orchestrate.md');if(!existsSync(playbookPath))await copyFile(join(app.getAppPath(),'public','orchestrate.md'),playbookPath);
    const r=new OrchestrateRun({runDir:join(app.getPath('userData'),'orchestrate',randomUUID()),execPath:process.execPath,cliPath:join(__dirname,'cli.js'),playbookPath,roles,panes:activePanes,git,
      launch:paneId=>new Promise<void>((resolve,reject)=>{pendingLaunches.set(paneId,{resolve,reject});const timer=setTimeout(()=>{if(pendingLaunches.delete(paneId))reject(new Error('Pane did not start within 20 seconds.'));},20000);emitOrchestrate({kind:'launch',paneId});void timer;}),
      chat:async(paneId,prompt)=>{const pane=activePanes().find(p=>p.id===paneId),profile=stateStore.current?.profiles.find(p=>p.id===pane?.profileId);if(!pane||!profile)throw new Error('Advisor pane has no local model profile.');return providers.chat(paneId,profile,[{role:'user',content:prompt}]);},
      finish:async(report,summary,result)=>{new Notification({title:'Orchestrator finished',body:summary}).show();try{await vault.writeNote('AlphaCode Runs',`${new Date().toISOString().slice(0,10)} ${summary}`,runNote(report,summary,result,roles));}catch(error){emitOrchestrate({kind:'error',message:`Run note was not written: ${(error as Error).message}`});}},
      emit:emitOrchestrate,log:m=>console.error(m)});
    r.writer=(id,data)=>terminals.write(id,data);r.alive=id=>terminals.has(id);
    run=r;try{await r.start();}catch(error){run=null;throw error;}
  });
  handle('bridge:orchestrate-stop',async()=>{const r=run;run=null;if(r)await r.stop();});
  handle('bridge:approve-plan',()=>{run?.approve();});
```

Import `string as str` from `../shared/domain` alongside the existing imports. In `before-quit`, add `run?.stop().catch(()=>{});` before `admins.stopAll()`.

- [ ] **Step 5: Add the preload bridge**

In `electron/preload.ts`, append to the `bridge` object:

```ts
  orchestrateStart:roles=>ipcRenderer.invoke('bridge:orchestrate-start',roles),
  orchestrateStop:()=>ipcRenderer.invoke('bridge:orchestrate-stop'),
  approvePlan:()=>ipcRenderer.invoke('bridge:approve-plan'),
  onOrchestrateEvent:callback=>{const listener=(_event:Electron.IpcRendererEvent,event:OrchestrateEvent)=>callback(event);ipcRenderer.on('bridge:orchestrate-event',listener);return()=>ipcRenderer.removeListener('bridge:orchestrate-event',listener);},
```

Add `OrchestrateEvent` to the type import.

- [ ] **Step 6: Create `public/orchestrate.md`**

```markdown
# Orchestrate playbook

You are the orchestrator pane in AlphaCode. The `alphacode` command is on your PATH and every
call prints JSON. Other Claude panes are workers; Local Model panes are advisors. You never type
into a worker. Workers run in their own git worktree and report their own status.

## Steps

1. **Triage.** Before anything else, state your determination in one line: either
   "One task, doing it here" and then do the work yourself, or
   "Splits into N independent pieces, plan follows." Worker count follows the work. The layout
   is a ceiling, not a quota. If `alphacode panes` shows tasks in state `interrupted`, say so
   first and offer to resume them with `alphacode task retry` before taking new work.
2. **Plan.** Write `plan.json` in `$ALPHACODE_RUN_DIR` with `tests` (the project's test command)
   and `tasks`: `id` (lowercase, dashes), `title`, `files` the task owns (repo-relative; a trailing
   slash claims a folder), `model` (`sonnet` by default, `fable` for the hardest piece), `minutes`
   budget, `advisor` (true when an advisor should review its diff), and `prompt` naming a `.md`
   file next to the plan with the full task prompt. No file may belong to two tasks. Post it with
   `alphacode plan plan.json`, show the user the split in this pane, and wait for the user to say
   "go". Revise on request. Then run `alphacode plan plan.json --approved`.
3. **Dispatch.** `alphacode task start <id>` for every task, then loop on
   `alphacode task wait --timeout 240`. On `waiting`, tell the user which pane needs them and keep
   waiting on the rest. On `attention`, read `alphacode task status <id>` and choose between
   `alphacode task retry <id> feedback.md` with specific feedback and asking the user.
4. **Review** each `done` task with `git diff main...<branch>` from the status output. When the
   plan set `advisor`, write the diff and the task prompt to a file and run
   `alphacode ask <advisorPaneId> file.md` for a second read. Retry or accept.
5. **Merge**, in plan order, one branch at a time: inside the task's worktree run
   `git rebase main`; on conflict run `git rebase --abort`, report the task, the conflicting
   files, and the other task that owns them, and stop. If `tests` is set, run it in the worktree
   and stop on failure. Then on main `git merge --ff-only <branch>`, then
   `git worktree remove <path>` and `git branch -d <branch>`. Leave failed or unmerged worktrees.
6. **UAT.** Check the merged result against each acceptance criterion in the user's request, one
   by one, with evidence from commands or file contents.
7. **Red team.** Attack the result: edge cases, failure paths, trust boundaries, anything dropped
   between tasks. Fix small gaps directly. Open a new task for large ones and return to step 3.
8. **Finish.** Write `report.md`: what was built, what was verified and how, what was not
   verified, open items. Run `alphacode finish report.md`.

## Hard rules

No file in two tasks. No merge without a rebase. No done without the worker's own report. At
most two retries per task. Never type into a worker pane. Never start a worker before the user
says go.
```

- [ ] **Step 7: Build and run the tests**

Run: `npx vitest run && npx tsc --noEmit -p tsconfig.json && npm run build:main`
Expected: PASS, `dist-electron/electron/cli.js` exists.

- [ ] **Step 8: Commit**

```bash
git add electron/main.ts electron/preload.ts electron/runtime-core.ts electron/vault.ts public/orchestrate.md tests/orchestrate.test.ts tests/runtime.test.ts
git commit -m "feat(orchestrate): wire the run into main, bridge, launches, toast, vault run note and bundled playbook

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Renderer — toggle, roles, badges, Tasks section, status bar

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/styles.css`
- Modify: `tests/e2e.spec.ts` (append a test)
- Create: `tests/fixtures/fake-claude.cjs`, `tests/fixtures/fake-claude.cmd`

**Interfaces:**
- Consumes: bridge methods from Task 5, `emptyOrchestrate`, `TASK_LABELS`, `applyPreset(w, 6, 'claude')`.
- Produces: toolbar button `Orchestrate` (aria-label `Turn orchestrate on` / `Turn orchestrate off`), number input aria-label `Max workers`, pane header `.pane-badge.<state>` with text from `TASK_LABELS` or `Orchestrator` / `Done`, sidebar `.tasks-section` with `.task-row[data-task-id]` and an `Approve plan` button, status bar text `Orchestrate · N working · N waiting · N done`.

- [ ] **Step 1: Write the end-to-end test and the stub worker**

Create `tests/fixtures/fake-claude.cjs` (stands in for Claude Code: creates the worktree, commits, reports done):

```js
// Stand-in for the claude CLI in e2e: honors --worktree and the positional prompt, commits one file, reports done.
const { execFileSync } = require('node:child_process'); const { writeFileSync, mkdirSync } = require('node:fs'); const { join } = require('node:path');
const args = process.argv.slice(2); const flag = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : ''; };
const name = flag('--worktree'), prompt = args[args.length - 1] || '';
if (flag('--append-system-prompt-file')) { console.log('ORCHESTRATOR READY'); setInterval(() => {}, 1000); return; } // orchestrator stub idles; the test drives the server through the CLI
const root = process.cwd(), dir = join(root, '.claude', 'worktrees', name); mkdirSync(join(root, '.claude', 'worktrees'), { recursive: true });
execFileSync('git', ['worktree', 'add', '-b', `task-${name.replace(/^task-/, '')}`, dir], { cwd: root, stdio: 'ignore' });
writeFileSync(join(dir, `${name}.txt`), prompt); execFileSync('git', ['add', '.'], { cwd: dir }); execFileSync('git', ['-c', 'user.email=e2e@x', '-c', 'user.name=e2e', 'commit', '-qm', name], { cwd: dir });
console.log(`WORKER ${name} committed`);
execFileSync(join(process.env.ALPHACODE_RUN_DIR_SHIM || '', 'alphacode.cmd'), ['report', 'done'], { stdio: 'inherit', shell: true });
setInterval(() => {}, 1000);
```

Create `tests/fixtures/fake-claude.cmd`:

```
@node "%~dp0fake-claude.cjs" %*
```

Append to `tests/e2e.spec.ts`:

```ts
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
test('orchestrate mode runs a two-task plan through stub workers', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'alphacode-orch-e2e-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo }); await writeFile(join(repo, 'README.md'), '# e2e\n'); execFileSync('git', ['add', '.'], { cwd: repo }); execFileSync('git', ['-c', 'user.email=e2e@x', '-c', 'user.name=e2e', 'commit', '-qm', 'init'], { cwd: repo });
  const stub = join(root, 'tests', 'fixtures', 'fake-claude.cmd');
  // Point every Claude pane at the stub and the repo, then turn the mode on.
  for (const name of ['Claude A', 'Claude B', 'Claude C', 'Claude D']) {
    await page.getByRole('button', { name: `Configure ${name}`, exact: true }).click();
    await page.getByLabel('Executable override (optional)', { exact: true }).fill(stub); await page.getByLabel('Working directory', { exact: true }).fill(repo);
    await page.getByRole('button', { name: 'Apply changes' }).click();
  }
  await page.locator('.pane[data-pane-title="Claude A"]').click();
  await page.getByRole('button', { name: 'Turn orchestrate on', exact: true }).click();
  await expect(page.locator('.pane')).toHaveCount(6);
  await expect(page.locator('.pane[data-pane-title="Claude A"] .pane-badge')).toHaveText('Orchestrator');
  await expect(page.locator('.tasks-section')).toContainText('Waiting for a plan');
  // Drive the control channel the way the orchestrator would, using the pane's own environment.
  const env = await page.evaluate(async () => (window as any).__orchestrateEnv);
  const dir = await mkdtemp(join(tmpdir(), 'alphacode-plan-'));
  await writeFile(join(dir, 'a.md'), 'A task'); await writeFile(join(dir, 'b.md'), 'B task');
  await writeFile(join(dir, 'plan.json'), JSON.stringify({ tests: '', tasks: [{ id: 'a', title: 'Alpha', files: ['a/'], model: 'sonnet', minutes: 5, advisor: false, prompt: 'a.md' }, { id: 'b', title: 'Beta', files: ['b/'], model: 'sonnet', minutes: 5, advisor: false, prompt: 'b.md' }] }));
  const cli = (...a: string[]) => execFileSync('node', [join(root, 'dist-electron', 'electron', 'cli.js'), ...a], { env: { ...process.env, ...env }, encoding: 'utf8' });
  cli('plan', join(dir, 'plan.json'));
  await expect(page.locator('.task-row')).toHaveCount(2);
  await page.getByRole('button', { name: 'Approve plan', exact: true }).click();
  cli('task', 'start', 'a'); cli('task', 'start', 'b');
  await expect(page.locator('.pane-badge', { hasText: 'Task done' })).toHaveCount(2);
  expect(execFileSync('git', ['worktree', 'list'], { cwd: repo, encoding: 'utf8' })).toContain('task-a');
  await expect(page.locator('.app-statusbar')).toContainText('2 done');
  await writeFile(join(dir, 'r.md'), 'E2E finished.'); cli('finish', join(dir, 'r.md'));
  await expect(page.locator('.pane[data-pane-title="Claude A"] .pane-badge')).toHaveText('Done');
  await page.getByRole('button', { name: 'Turn orchestrate off', exact: true }).click();
  await expect(page.locator('.pane-badge')).toHaveCount(0);
});
```

The test reads `window.__orchestrateEnv`, which the renderer sets only when `ALPHACODE_DATA_DIR` ends with `e2e-state`: main returns the control URL and token from `bridge:orchestrate-start` in that case and the renderer stores them on `window`. Implement that in Step 3 below as the one test-only hook; it is never set outside the e2e data folder. The stub worker needs the shim path: in `overrides`, add `ALPHACODE_RUN_DIR_SHIM: this.deps.runDir` to the worker env (the run folder is not secret).

- [ ] **Step 2: Run the e2e test to verify it fails**

Run: `npm run build && npx playwright test -g "orchestrate mode"`
Expected: FAIL, no button named "Turn orchestrate on".

- [ ] **Step 3: Implement the renderer**

In `src/App.tsx`:

Imports: add `Workflow` to the lucide import; add `emptyOrchestrate, TASK_LABELS` from `'../shared/orchestrate'`; add `OrchestrateEvent, OrchestrateRoles, Task` to the types import.

State, next to `vault`:

```tsx
  const [orch,setOrch]=useState<{approved:boolean;tasks:Task[];finished:string}>({approved:false,tasks:[],finished:''});
```

Subscribe, inside the first `useEffect` after `return window.bridge.onSessionEvent(...)`, replace that return with:

```tsx
    const offSession=window.bridge.onSessionEvent(e=>{if(e.kind==='status')setStatuses(previous=>({...previous,[e.paneId]:e}));});
    const offOrch=window.bridge.onOrchestrateEvent(e=>{
      if(e.kind==='tasks'){setOrch(o=>({...o,approved:e.approved,tasks:e.tasks}));update(w=>({...w,orchestrate:{...(w.orchestrate||emptyOrchestrate()),approved:e.approved,tasks:e.tasks}}));}
      else if(e.kind==='launch'){void window.bridge.stopSession(e.paneId).then(()=>setRelaunch(r=>({...r,[e.paneId]:(r[e.paneId]||0)+1}))).catch(err=>report(String(err)));}
      else if(e.kind==='finished'){setOrch(o=>({...o,finished:e.summary}));setNotice(`Orchestrator finished: ${e.summary}`);}
      else if(e.kind==='error')report(e.message);
      else if(e.kind==='off')update(w=>w.orchestrate?{...w,orchestrate:{...w.orchestrate,on:false}}:w);
    });
    return()=>{offSession();offOrch();};
```

Actions, after `preset`:

```tsx
  const orchestrate=workspace?.orchestrate||emptyOrchestrate();
  const orchestrateOn=async()=>{
    if(!workspace)return;
    const removed=workspace.panes.slice(6);
    if(removed.length&&!window.confirm(`Orchestrate uses the 6 pane layout. This closes ${removed.length} pane${removed.length===1?'':'s'} and their sessions.`))return;
    let w=applyPreset(workspace,6,'claude');
    const focusedClaude=w.panes.find(p=>p.id===focused&&p.type==='claude'),first=w.panes.find(p=>p.type==='claude');
    const orchestrator=focusedClaude||first; if(!orchestrator){report('Orchestrate needs a Claude pane.');return;}
    if(isActive(orchestrator.id)&&!window.confirm(`${orchestrator.title} becomes the orchestrator. Its session restarts with the control channel. Continue?`))return;
    const roles:OrchestrateRoles={workspaceId:w.id,root:orchestrator.cwd,orchestratorPaneId:orchestrator.id,workerPaneIds:w.panes.filter(p=>p.type==='claude'&&p.id!==orchestrator.id).map(p=>p.id),advisorPaneIds:w.panes.filter(p=>p.type==='local-model').map(p=>p.id),maxWorkers:orchestrate.maxWorkers,resume:orchestrate.tasks.filter(t=>t.state==='interrupted')};
    try{await Promise.all(removed.map(async p=>{await window.bridge.stopSession(p.id);await window.bridge.cancelChat(p.id);}));
      await window.bridge.orchestrateStart(roles);
      w={...w,orchestrate:{...orchestrate,on:true,orchestratorPaneId:orchestrator.id,approved:false,tasks:orchestrate.tasks.filter(t=>t.state==='interrupted')}};
      setState(s=>s?{...s,workspaces:s.workspaces.map(x=>x.id===w.id?w:x)}:s);setMaximized('');setOrch({approved:false,tasks:w.orchestrate!.tasks,finished:''});
      await window.bridge.stopSession(orchestrator.id);setRelaunch(r=>({...r,[orchestrator.id]:(r[orchestrator.id]||0)+1}));setFocused(orchestrator.id);
    }catch(e){report(String(e));update(x=>x.orchestrate?{...x,orchestrate:{...x.orchestrate,on:false}}:x);}
  };
  const orchestrateOff=async()=>{try{await window.bridge.orchestrateStop();}catch(e){report(String(e));}update(w=>({...w,orchestrate:{...orchestrate,on:false,approved:false,tasks:[]}}));setOrch({approved:false,tasks:[],finished:''});};
  const taskFor=(paneId:string)=>orch.tasks.find(t=>t.paneId===paneId);
  const badge=(p:PaneConfig):{cls:string;text:string}|null=>{
    if(!orchestrate.on)return null;
    if(p.id===orchestrate.orchestratorPaneId)return orch.finished?{cls:'done',text:'Done'}:{cls:'orchestrator',text:'Orchestrator'};
    const t=taskFor(p.id);return t&&!t.hidden?{cls:t.state,text:TASK_LABELS[t.state]}:null;
  };
  const counts=(s:Task['state'])=>orch.tasks.filter(t=>t.state===s).length;
  const elapsed=(t:Task)=>{if(!t.startedAt)return '';const s=Math.round(((t.finishedAt?Date.parse(t.finishedAt):Date.now())-Date.parse(t.startedAt))/1000);return `${Math.floor(s/60)}m ${s%60}s`;};
```

On load, in the `Promise.all([loadState, appInfo])` handler, the saved `orchestrate` already comes back with `on:false` and interrupted tasks from `validateOrchestrate`; seed `orch` from the active workspace: after `setState(next)` add `setOrch({approved:false,tasks:next.workspaces.find(w=>w.id===next.activeWorkspaceId)?.orchestrate?.tasks||[],finished:''});`.

Toolbar, after the Lock button:

```tsx
      <button className={`ghost ${orchestrate.on?'selected':''}`} aria-label={orchestrate.on?'Turn orchestrate off':'Turn orchestrate on'} title="One Claude pane plans and runs tasks in the others" onClick={()=>void (orchestrate.on?orchestrateOff():orchestrateOn())}><Workflow size={14}/><span>Orchestrate</span></button>
      {!orchestrate.on&&<label className="max-workers" title="Most workers at once"><input aria-label="Max workers" type="number" min={1} max={5} value={orchestrate.maxWorkers} onChange={e=>update(w=>({...w,orchestrate:{...orchestrate,maxWorkers:Math.min(5,Math.max(1,Number(e.target.value)||1))}}))}/></label>}
```

Sidebar, after the Panes section, only while on:

```tsx
      {orchestrate.on&&<section className="tasks-section"><div className="section-heading"><span>Tasks</span>{orch.tasks.length>0&&!orch.approved&&<button className="primary" onClick={()=>window.bridge.approvePlan().catch(e=>report(String(e)))}>Approve plan</button>}</div>
        {orch.tasks.length===0?<div className="tasks-empty">Waiting for a plan.</div>:orch.tasks.map(t=><button key={t.id} className="task-row" data-task-id={t.id} onClick={()=>{setFocused(t.paneId);if(maximized)setMaximized(t.paneId);}}><span className={`status-dot task-${t.state}`}/><span className="task-main"><strong>{t.title}</strong><small>{workspace.panes.find(p=>p.id===t.paneId)?.title||t.paneId} · {t.model}{t.branch?` · ${t.branch}`:''}</small></span><span className="task-state">{TASK_LABELS[t.state]}{elapsed(t)?<small>{elapsed(t)}</small>:null}{t.message&&<small title={t.message}>{t.message}</small>}</span></button>)}
      </section>}
```

Pane header: inside `.pane-header` between the drag handle and the status span:

```tsx
{(()=>{const b=badge(p);return b?<span className={`pane-badge ${b.cls}`}>{b.text}</span>:null;})()}
```

Status bar: replace the first `<span>` of `.app-statusbar` with:

```tsx
<span><span className="status-dot running"/>{orchestrate.on?`Orchestrate · ${counts('working')} working · ${counts('waiting')} waiting · ${counts('done')} done`:'Local terminal cockpit'}</span>
```

Test-only hook: in `main.ts`'s `bridge:orchestrate-start` handler, after `await r.start()`, `return app.getPath('userData').endsWith('e2e-state')?{url:\`http://127.0.0.1:${r.port}\`,token:r.controlToken}:null;` and in `orchestrateOn` capture it: `const testEnv=await window.bridge.orchestrateStart(roles);if(testEnv)(window as any).__orchestrateEnv={ALPHACODE_CONTROL_URL:testEnv.url,ALPHACODE_CONTROL_TOKEN:testEnv.token};`. Type `orchestrateStart` as `Promise<{url:string;token:string}|null>` in `shared/types.ts`.

Also in `savePane`: a Claude pane whose type changes away from `claude` while it is the orchestrator turns the mode off; add at the top of `savePane`: `if(orchestrate.on&&p.id===orchestrate.orchestratorPaneId&&p.type!=='claude')await orchestrateOff();`. In `closePane`, after the stop: `if(orchestrate.on&&p.id===orchestrate.orchestratorPaneId)await orchestrateOff();`. In `switchWorkspace`, before `stopAll`: `if(orchestrate.on)await orchestrateOff();`.

- [ ] **Step 4: Styles**

Append to `src/styles.css`:

```css
.pane-badge{font-size:9px;text-transform:uppercase;letter-spacing:.04em;padding:2px 6px;border-radius:3px;background:#2b333b;color:#aab6c2;white-space:nowrap}.pane-badge.orchestrator{background:#2a3b4f;color:#8cb7df}.pane-badge.working{background:#2f3d2f;color:#9cbf9b}.pane-badge.waiting,.pane-badge.attention{background:#3f3523;color:#d8ae68}.pane-badge.done{background:#243a2a;color:#9cbf9b}.pane-badge.failed{background:#4a2b28;color:#e18b83}.pane-badge.planned,.pane-badge.interrupted{background:#2b333b;color:#8696a7}
.max-workers input{width:42px;min-height:24px;padding:2px 4px;font-size:11px}.toolbar-actions>button.selected{color:#8cb7df;border-color:#3d5570}
.tasks-section .section-heading button.primary{font-size:10px;min-height:22px;padding:2px 8px}.tasks-empty{font-size:11px;color:#8292a2;padding:4px 2px}.task-row{display:flex;align-items:center;gap:7px;width:100%;text-align:left;padding:5px 6px;border:1px solid transparent;background:transparent;border-radius:4px}.task-row:hover{background:#1c2025;border-color:#30363d}.task-main{flex:1;min-width:0;display:flex;flex-direction:column}.task-main strong{font-size:11px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.task-main small,.task-state small{font-size:9px;color:#8292a2;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.task-state{display:flex;flex-direction:column;align-items:flex-end;font-size:10px;color:#aab6c2}
.status-dot.task-working{background:#9cbf9b}.status-dot.task-waiting,.status-dot.task-attention{background:#d8ae68}.status-dot.task-done{background:#6e90b1}.status-dot.task-failed{background:#dd867b}
```

- [ ] **Step 5: Type-check, unit tests, build, e2e**

Run: `npx tsc --noEmit -p tsconfig.json && npx vitest run && npm run build && npx playwright test -g "orchestrate mode"`
Expected: PASS. If the e2e stub cannot run `.cmd` through `shell:true`, replace that line in `fake-claude.cjs` with `execFileSync('cmd.exe', ['/c', shim, 'report', 'done'], ...)`.

- [ ] **Step 6: Run the full e2e suite once**

Run: `npx playwright test`
Expected: both tests PASS; the earlier test still counts 8 panes because the orchestrate test runs after it in file order.

- [ ] **Step 7: Commit**

```bash
git add src/App.tsx src/styles.css shared/types.ts electron/main.ts electron/orchestrate.ts tests/e2e.spec.ts tests/fixtures/fake-claude.cjs tests/fixtures/fake-claude.cmd
git commit -m "feat(orchestrate): toolbar toggle, roles, pane badges, Tasks sidebar, status bar and e2e run with stub workers

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Docs and a real run

**Files:**
- Modify: `README.md` (toolbar section, sidebar section, pane types note, limits, data location)
- Modify: `docs/runtime-report.md` (append verification)

**Interfaces:** none.

- [ ] **Step 1: README**

In **Toolbar**, after the Lock paragraph, add:

```markdown
**Orchestrate** (branching icon) with a **Max workers** number. Turns Orchestrate mode on for
this workspace. The 6-pane preset is applied, the focused Claude pane (or the first one)
becomes the **Orchestrator** and restarts with a control channel and the orchestration playbook,
the other Claude panes become workers, and Local Model panes become advisors. Type your request
into the orchestrator pane. It says whether the work splits, posts a plan to the **Tasks**
section, waits for you to type "go" (or click **Approve plan**), then runs each task as a Claude
Code session in a worker pane, in its own git worktree under the project. Finished workers stay
open with a **Task done** badge. When the orchestrator finishes you get a Windows notification
and a run note in the Claude memory vault under `AlphaCode Runs`. Turning it off closes the
channel and clears badges; every session and worktree stays. The project folder of the
orchestrator pane must be a git repository with a clean index.

The playbook is a text file at `%APPDATA%\AlphaCode\orchestrate.md`, copied from the app on
first use. Edit it to change how the orchestrator plans, reviews, merges and reports.
```

In **Sidebar**, add a **Tasks** subsection describing the rows (title, pane, model, branch, state, elapsed) and the Approve button. In **Pane types**, add a line under the Claude row: "In Orchestrate mode a Claude pane carries a badge: Orchestrator, Planned, Working, Waiting (amber, needs you), Needs attention, Task done, Failed, Interrupted." In **Limits**, add `| Orchestrate workers | 5 |` and `| Task retries | 2 |`. In **Where your data lives**, add the playbook path and `orchestrate\<run id>\` as transient per-run files.

- [ ] **Step 2: Real run**

With Ollama serving `gpt-oss:20b` and a Local Model profile set to it, open a workspace whose Claude pane sits in a real git repo with a clean index. Turn Orchestrate on. Ask for a small two-piece change (for example: "add a `--version` flag to the CLI and document it in the README"). Observe: the triage line, the plan in the Tasks section, "go", two workers in worktrees, badges reaching Task done, the merge, UAT and red-team output in the orchestrator pane, the toast, and the note under `AlphaCode Vault\AlphaCode Runs`. Then restart the orchestrator pane by hand mid-run on a second attempt and confirm it relaunches with the playbook and the tasks survive (Review Focus 5).

- [ ] **Step 3: Record the verification**

Append to `docs/runtime-report.md` a section "Orchestrate mode" listing exactly what was verified (commands, screenshots in `work/`), what the e2e stub covers versus the real run, and anything not verified (for example, a merge conflict path if none occurred).

- [ ] **Step 4: Commit**

```bash
git add README.md docs/runtime-report.md
git commit -m "docs: Orchestrate mode help, limits, data locations and verification report

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```
