# Orchestrate mode

Date: 2026-10-10. Status: approved in conversation, awaiting written review.
Depends on: `2026-10-09-claude-memory-vault-design.md` (the run note is written into the vault).
Reuses the token design from `2026-09-22-panehost-design.md` section 3.

## Purpose

A per-workspace mode in which one Claude Code pane, the orchestrator, takes a master prompt
from the user, decides whether the work splits into independent pieces, and if it does, runs
each piece as a separate Claude Code session in its own pane and its own git worktree. The
orchestrator reviews each piece, merges the branches, runs user acceptance testing against
the master prompt, red-teams the result, and reports done. Local model panes serve as
read-only advisors the orchestrator can consult.

Success: with Orchestrate on, typing a feature request into the orchestrator pane produces a
task split the user approves with "go", worker panes that visibly work and settle into a
Task done state without closing, a merged branch that passes the project's tests, and a
final report in the orchestrator pane plus a note in the memory vault, with a toast when it
finishes.

## Decisions already made

- The brain is Claude Code. AlphaCode supplies plumbing only: a control channel, a command
  line tool, pane states, a task list, and launch wiring. Decomposition, review, merge, UAT
  and red team live in an editable playbook text file appended to the orchestrator's system
  prompt.
- Workers are interactive Claude Code sessions in real panes. A finished worker's pane stays
  open, in a Task done state. Workers default to the cheaper model (sonnet); the
  orchestrator runs whatever the pane was configured with (Fable).
- Isolation is one git worktree per task, created by Claude Code's own `--worktree` flag so
  the folder sits inside the repo and inherits its trust. The orchestrator pane's cwd must
  be a git repository.
- Done is an explicit report from the worker, never inferred from output text or from the
  Stop hook alone.
- Local model panes (profile model is the user's choice, currently gpt-oss:20b on Ollama)
  are advisors: they answer prompts and never edit files.
- Mode, not default. Off unless the workspace turns it on. Inside the mode the orchestrator
  triages every prompt and does small work itself.
- The control channel is a loopback HTTP server in Electron main with two token classes.
  No MCP server, no file mailbox.
- Out of scope: more than one orchestrator per workspace, workers on non-Claude CLIs,
  Claude-on-Ollama coding workers, remote access, automated answering of permission
  prompts, auto-resolving merge conflicts.

Verified against Claude Code 2.1.296: `--worktree [name]`, `--settings <file-or-json>`,
`--append-system-prompt`, `--model`, `--permission-mode`, `--name`, `--session-id`,
`--resume` all exist. Spiked in print mode (`claude -p`; no TTY available): `--worktree task-x`
creates the worktree at `<repo>/.claude/worktrees/task-x` on branch `worktree-task-x` (pattern
`worktree-<name>`), locked by the session. A Stop hook supplied only through `--settings <file>`
fired; the working `command` form was a forward-slash absolute path to the `.cmd` shim, quoted,
with an argument: `"D:/path/hook.cmd" stop`. The `--settings` file did not need to exist inside the
worktree. `claude -p --resume <session-id>` run from inside the worktree path resumed the
session (it recalled its earlier reply) with cwd set to the worktree path. The interactive
positional prompt together with `--worktree` is documented CLI behavior and is verified by the
real run in Task 7. Not tested: whether `--settings` hooks run alongside the user's own settings hooks.

## The toggle

**Orchestrate** is a toolbar toggle beside the layout presets. Workspace gains
`orchestrate: { on: boolean; orchestratorPaneId: string; maxWorkers: number; tasks: Task[] }`.
`maxWorkers` defaults to 5 and is shown as a number next to the toggle.

Turning it on:

1. Applies the 6-pane preset through the existing `applyPreset`, with its existing confirm
   when panes would be closed.
2. Chooses the orchestrator: the focused Claude pane, else the first Claude pane in grid
   order, else a new Claude pane at the workspace root added to the layout.
3. Confirms with the user that the orchestrator session will restart, then restarts it with
   the control environment (section "Control channel") and the playbook appended.
4. The other five slots are workers: existing Claude panes in grid order first, padded with
   new Claude panes titled Worker 1..n at the workspace root. Non-Claude panes already in
   those slots keep their place; a Local Model pane there is an advisor, any other type is
   ignored by the orchestrator.
5. Opens the control server. If the server cannot bind or the restart fails, the toggle
   snaps back off and the error shows in the status bar; nothing else changes.

Turning it off closes the control server, deletes the run's hook settings files, clears
badges and the Tasks section, and leaves every session running and every worktree on disk.
The orchestrator pane's next restart runs without the control environment.

The toggle also turns off, with the same cleanup, when the orchestrator pane is closed, its
type is changed away from Claude, or the workspace is switched. Stopping or restarting the
orchestrator's session by hand keeps the mode on: the next start reattaches the control
environment and the playbook, and the tasks survive. Workers keep running either way.

Worker panes belong to the mode while it is on. Starting a task ends whatever session the
worker pane was running (by default an idle auto-started Claude session) and launches the
worker in its place. Panes outside the six slots are never touched.

## What the user sees

**Pane header badge**, left of the session status:

| Badge | Meaning |
|---|---|
| Orchestrator | The pane holding the control token |
| Planned | Task assigned to this pane, worker not yet started |
| Working | Worker is mid-task |
| Waiting | Worker raised a permission prompt or asked a question. Amber. A Windows toast fires |
| Needs attention | Worker went idle without reporting done |
| Task done | Worker reported done. Stays until the next task starts or the user types in the pane |
| Failed | Worker reported failure, or its process exited without a report |
| Interrupted | Task was Working or Waiting when the app last closed |

Badges are driven by the task state; the existing session status (running, exited, error)
stays as it is.

**Sidebar: Tasks.** A section shown only while Orchestrate is on. One row per task: title,
pane title, state, branch, model, elapsed time since start, and for Failed the exit code or
reason. Clicking a row focuses its pane. Empty state text: "Waiting for a plan."

**Status bar.** While on: `Orchestrate · N working · N waiting · N done`.

**Finish.** The orchestrator pane badge becomes Done, a toast "Orchestrator finished:
<summary line>" fires, and a run note is written to the vault (section "Run note").

**Plan-first gate.** The orchestrator never starts a worker before posting the split with
`alphacode plan` and receiving "go" from the user in the orchestrator pane. This is enforced
by the playbook and by the server: `task start` fails for a plan that was not acknowledged,
and the acknowledgement is the orchestrator calling `alphacode plan --approved` after the
user says go. The user can also approve from the Tasks section with an Approve button, which
sets the same flag.

## Control channel

Electron main, new module `electron/orchestrate.ts`. Opens `http.createServer` on
`127.0.0.1`, OS-assigned port, when the mode turns on. Every request carries
`Authorization: Bearer <token>`.

Two token classes, 32 random bytes hex each, minted when the mode turns on and never saved:

- **Control token.** Injected only into the orchestrator pane's environment as
  `ALPHACODE_CONTROL_URL` and `ALPHACODE_CONTROL_TOKEN`. Required by every endpoint except
  `report`.
- **Hook token, one per worker pane**, minted at `task start`, injected into that worker's
  environment as `ALPHACODE_HOOK_TOKEN` and `ALPHACODE_PANE_ID`. Accepted only by `report`,
  and only when the body's pane id matches the id the token was minted for.

Any other pane, and anything a worker runs, has no token. A request with a missing,
unknown, or mismatched token is answered 401 and logged to the main process console; it
never changes state. The server accepts bodies up to 1 MB and closes idle connections.

Endpoints, all JSON:

| Endpoint | Token | Effect |
|---|---|---|
| `GET /panes` | control | Panes with id, title, type, cwd, session status, role (orchestrator, worker, advisor, none), task state |
| `POST /plan` | control | Validates and stores the task list; `{approved: true}` sets the gate |
| `POST /tasks/:id/start` | control | Launches the worker (section "Worker launch") |
| `GET /tasks/:id` | control | State, elapsed, branch, model, last 20 lines of the pane's output |
| `GET /tasks/wait?ids=&timeout=` | control | Long-polls until any listed task changes state or timeout (max 240 s) |
| `POST /tasks/:id/retry` | control | Sends a follow-up message to the worker (section "Retry") |
| `POST /ask/:paneId` | control | Sends a prompt to a Local Model pane through `ProviderClient.chat`, returns the answer |
| `POST /finish` | control | Marks the run done, fires the toast, writes the run note |
| `POST /report` | hook | `{paneId, kind: 'done' \| 'failed' \| 'stop' \| 'waiting', message?}` |

The last 20 lines come from a per-pane ring of the most recent 4 KB of PTY output kept in
main while the mode is on, stripped of ANSI escapes. Nothing larger is ever returned; the
orchestrator reviews work through git, not scrollback.

## The `alphacode` command

A Node script, `scripts/alphacode-cli.cjs`, shipped with the app and placed on the
orchestrator's PATH by prepending its folder to `PATH` in the orchestrator's environment,
with a `.cmd` shim so it runs from PowerShell and Claude's Bash alike. It reads the URL and
token from the environment, prints JSON, exits non-zero with a one-line error on failure,
and is never interactive.

| Command | Endpoint |
|---|---|
| `alphacode panes` | `GET /panes` |
| `alphacode plan <file> [--approved]` | `POST /plan` with the file's JSON |
| `alphacode task start <taskId>` | `POST /tasks/:id/start` |
| `alphacode task status [taskId]` | `GET /tasks/:id`, or every task |
| `alphacode task wait [taskId...] --timeout 240` | `GET /tasks/wait` |
| `alphacode task retry <taskId> <file>` | `POST /tasks/:id/retry` with the file's text |
| `alphacode ask <paneId> <file>` | `POST /ask/:paneId` with the file's text |
| `alphacode finish <file>` | `POST /finish` with the file's text as the report |
| `alphacode report done\|failed\|stop\|waiting [message]` | `POST /report` with the hook token |

Prompts, plans, feedback and reports are files, never arguments, so quoting cannot corrupt
them. `report` is the only subcommand a worker can use; it reads `ALPHACODE_HOOK_TOKEN`
and `ALPHACODE_PANE_ID` and ignores the control variables.

## Plan format

```json
{ "tests": "npm test",
  "tasks": [ { "id": "api", "title": "Add the export endpoint", "files": ["electron/export.ts", "shared/types.ts"],
               "model": "sonnet", "minutes": 20, "advisor": false, "prompt": "task-api.md" } ] }
```

Validation, in `shared/orchestrate.ts` so the renderer can show the same errors:

- 1 to `maxWorkers` tasks, and no more than the number of worker panes in the layout; ids
  `^[a-z0-9-]{1,32}$` and unique.
- `files` are repo-relative, no `..`, no absolute paths; no file appears in two tasks. A
  directory entry (trailing slash) claims everything beneath it and conflicts with any file
  under it.
- `model` is `sonnet`, `opus`, or `fable`; `minutes` 1 to 240; `prompt` names a file under
  the run folder.
- The orchestrator pane's cwd is a git repository with a clean index. Untracked files are
  allowed. Checked at plan time with `git status --porcelain`.

A plan replaces the previous plan only for tasks not yet started; started tasks are kept.

## Task states

```
Planned -> Working        task start succeeded
Working -> Waiting        report waiting (Notification hook, permission or question type)
Waiting -> Working        the user types in the pane (bridge write-session), i.e. answered the prompt
Working -> Needs attention report stop with no done or failed report in this turn
Needs attention -> Working  task retry
Working|Waiting|Needs attention -> Task done     report done
Working|Waiting|Needs attention -> Failed        report failed, or the pane's process exited
Task done -> Working      task start of another task on the same pane
Failed -> Working         task retry (relaunch with --resume if the process is gone)
Working|Waiting -> Interrupted   app closed; set on load from the saved state
```

Every other transition is rejected with 409 and logged. The Stop hook fires at the end of
every assistant turn, so a `stop` arriving in the same turn after a `done` is ignored. The
user typing in a Task done pane clears its badge; the task row keeps its Task done state and
the pane is treated as free for the next `task start`.

## Worker launch

`POST /tasks/:id/start` refuses if the plan is not approved, the task is not Planned or
Task done (Needs attention, Failed and Interrupted go through retry), or the pane is already
launching.

Otherwise it asks the renderer to restart the worker pane's session, which goes through the
normal `TerminalManager.start` path with the pane's existing config plus:

| Flag | Value |
|---|---|
| `--worktree task-<id>` | Claude Code creates the worktree and branch under the repo |
| `--model <plan model>` | default sonnet |
| `--name "<task title>"` | shown in Claude's prompt box |
| `--settings <run folder>/hooks-<paneId>.json` | Stop and Notification hooks calling `alphacode report` |
| positional prompt | the task prompt file's contents, with the header below prepended |

Permission mode is whatever the pane config carries; the orchestrator does not override it.
The worker's environment carries the hook token, pane id, and the CLI folder on PATH, and
not the control token.

Task prompt header, fixed text prepended by AlphaCode:

```
Task <id> on branch task-<id>, worktree <path>. Budget: <minutes> minutes.
Commit to this branch only. Do not edit files outside this worktree.
Files you own: <list>. Do not touch any other file; if the task needs one, say so and stop.
When finished run: alphacode report done
If you cannot finish run: alphacode report failed "<one line reason>"
```

The hooks file:

```json
{ "hooks": {
    "Stop": [ { "hooks": [ { "type": "command", "command": "alphacode report stop" } ] } ],
    "Notification": [ { "hooks": [ { "type": "command", "command": "alphacode report waiting" } ] } ] } }
```

Hook files live in `<userData>/orchestrate/<runId>/` and are deleted on finish or when the
mode turns off.

## Retry

`POST /tasks/:id/retry` with feedback text. If the worker's process is alive, the text is
written to the pane's PTY followed by Enter; this is the one case where AlphaCode types into
a worker, and only into one it launched, after a Needs attention, Task done or Failed
state. If the process is gone, the pane is relaunched with `--resume <session id>` in the
same worktree and the feedback as the positional prompt. Session ids are captured by
passing `--session-id <uuid>` at launch. The task goes back to Working. The playbook caps
retries at two per task.

## Merge

Done by the orchestrator with ordinary git commands in its own pane, in plan order:

1. `git rebase main` inside the task's worktree; on conflict, abort the rebase, report the
   task, the files in conflict, and the other task that owns them, and stop the pass.
2. If the plan names a test command, run it in the worktree; a failure is reported and the
   pass stops.
3. `git merge --ff-only task-<id>` on main, then `git worktree remove` and branch delete.

Worktrees of failed, unmerged or conflicted tasks are left in place. Turning the mode off
never deletes a worktree.

## The playbook

`orchestrate.md`, bundled under `public/` and copied to `<userData>/orchestrate.md` on
first use. The copy is what is passed with `--append-system-prompt-file`; the user edits it
freely and the bundled file is only the default. It contains the steps and the hard rules:

1. **Triage.** State the determination in one line before anything else: either "One task,
   doing it here" and then do the work, or "Splits into N independent pieces, plan follows."
   Worker count follows the work; the layout is a ceiling, not a quota.
2. **Plan.** Write the split: title, owned files, model, time budget, test command, whether
   the advisor reviews it, and the prompt file. Post with `alphacode plan`. Show the user the
   split in the pane and wait for "go". Revise on request. Then `alphacode plan --approved`.
3. **Dispatch.** Start every task, then loop on `task wait`. On Waiting, tell the user which
   pane and why, keep waiting on the rest. On Needs attention, read the last lines and
   choose between retry with specific feedback and asking the user. Never type into a
   worker.
4. **Review** each Task done by diffing its branch against main. Use `alphacode ask` on the
   advisor pane for a second read when the plan said so, sending the diff and the task
   prompt. Retry or accept.
5. **Merge** as in the Merge section.
6. **UAT.** Check the merged result against each acceptance criterion from the master
   prompt, with evidence (command output, file contents), one by one.
7. **Red team.** Attack the result: edge cases, failure paths, trust boundaries, anything
   dropped between tasks. Fix small gaps directly. Open a new task for large ones and return
   to step 3.
8. **Finish.** Write the final report: what was built, what was verified and how, what was
   not verified, open items. Call `alphacode finish`.

Hard rules: no file in two tasks; no merge without a rebase; no done without a report; at
most two retries per task; never type into a worker; report Interrupted tasks on start and
offer to resume them before taking new work.

## Run note

`alphacode finish` writes `<vault>/AlphaCode Runs/<date> <slug>.md` through the existing
`MemoryVault` with frontmatter `name`, `description` (the summary line), `type: run`,
`project` (repo folder name) and a body holding the master prompt, the approved plan, each
task's outcome and retry count, the UAT checklist, red-team findings, and the final report.
A write failure is shown in the status bar and does not block finishing.

## Persistence

`Workspace.orchestrate` is validated like the rest of the workspace: `on` boolean,
`orchestratorPaneId` a pane id present in the workspace or empty, `maxWorkers` 1 to 5,
`tasks` an array of the plan shape plus `state`, `paneId`, `branch`, `startedAt`,
`finishedAt`, `retries`, `sessionId`. Tokens, the port, and prompt text are never saved; the
prompt file paths are. Export strips `orchestrate` entirely. On load, Working and Waiting
tasks become Interrupted.

## Bridge summary

Additions to `BridgeApi`:

- `orchestrateStart(workspaceId: string, orchestratorPaneId: string): Promise<void>` opens
  the server, mints tokens, restarts the orchestrator.
- `orchestrateStop(): Promise<void>`.
- `onOrchestrateEvent(callback: (event: OrchestrateEvent) => void): () => void` where
  `OrchestrateEvent` is `{ kind: 'task'; task: Task } | { kind: 'finished'; summary: string }
  | { kind: 'error'; message: string }`.
- `approvePlan(): Promise<void>` for the sidebar Approve button.

The renderer never sees tokens or the port. Pane state for workers is driven by main.

## Testing

`tests/orchestrate.test.ts`:

- Plan validation: duplicate file, directory claim over a file, six tasks with cap five,
  bad id, absolute path, dirty index, non-git root, all rejected with the named reason.
- State machine: every signal against every state; the rejected pairs stay rejected; a
  `stop` after `done` in the same turn is ignored.
- Token checks: control endpoints reject the hook token and no token; `report` rejects the
  control token and a hook token for another pane id.
- Launch builder: flags from plan plus pane config, header text, PATH prepend, control
  variables absent from a worker's env and hook variables absent from the orchestrator's.
- Wait: resolves on a state change, resolves on timeout, caps the timeout.

Integration, same file with a real server on a random port: the CLI end to end for every
subcommand, and a fake worker script that calls `alphacode report` through the hooks path.

End to end, in the Playwright suite: throwaway git repo as workspace root, Orchestrate on,
a stub orchestrator command that posts a two-task plan, approves it and starts both; a stub
worker command that commits one file to its branch and reports done; assert two worktrees
exist, both panes show Working then Task done, the Tasks section matches, the finish toast
fires, and the run note exists. Real Claude sessions are not used in CI.

Manual: one real run with sonnet workers and the gpt-oss advisor, recorded in the
verification report with exactly what was and was not verified.

## Security notes

The control token exists only in the orchestrator pane's process environment and the hook
token only in its worker's; neither is written to disk or state. A worker, or anything it
spawns, can only report its own pane's status. The server binds loopback only. The
orchestrator can start sessions only in panes the mode designated as workers, with
arguments built by AlphaCode from the plan, never from free text; the only free text that
reaches a worker is the task prompt, delivered as a prompt, not as a command line. Retry is
the single path that types into a PTY and it is limited to panes this run launched. Merge,
UAT and red team run as the orchestrator's own session under the user's normal permission
mode.
