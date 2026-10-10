# Desktop runtime verification

Implemented Electron main and sandboxed/context-isolated preload using the unchanged `BridgeApi`. The renderer receives only typed IPC methods; main owns files, PTYs, network calls, dialogs and elevation. IPC callers must be the application's top-level renderer. Navigation and additional windows are denied.

Terminal sessions have independent process identity, cwd, input, output, resize and cleanup. A cancelled pending launch cannot resurrect after a restart. Claude resolves the native installation at `%USERPROFILE%\\.local\\bin\\claude.exe` before PATH. PowerShell, CMD, WSL, Git Bash, configured native commands and npm CLI `.cmd` shims are supported. Missing executable/cwd failures have actionable status messages. Main creates the four default Claude workspace directories but does not auto-launch terminals itself; renderer launch policy remains deliberate and testable. The runtime selects node-pty's bundled ConPTY DLL backend; this avoids the legacy console-list helper's observed `AttachConsole failed` teardown warning.

Saved state is validated, serialized, atomically replaced and backed up. Main and renderer use the same shared/domain validators, including intentionally empty workspaces, the 32-pane limit, 50 saved workspaces/profiles, and minimum context size 512. A corrupt primary state can recover its previous valid backup. If existing primary/backup files are both invalid, load raises a clear recovery error and subsequent saves are blocked in that store instance so automatic saves preserve the originals. Fresh missing files still return null. The renderer saves on every state change with no debounce, and `before-quit` waits for the store's pending write as well as terminal teardown, so a change made immediately before the window closes reaches disk; the E2E suite covers that path by closing the window straight after a rename. Window position, size and maximized state are kept in `window.json` beside the state file and reapplied once the window is ready to show; at fractional display scaling Electron restores the size a pixel or two off (electron/electron#10862), so an unchanged window writes back the numbers it was restored from rather than the drifted ones. Imported portable workspace JSON is validated and returned for deliberate load; import alone executes nothing. `ALPHACODE_DATA_DIR` overrides userData for E2E isolation.

Local model endpoints allow HTTP(S) localhost, 127.0.0.1 and ::1 only, with no redirects or URL credentials. Ollama and LM Studio have separate discovery/chat schemas. Requests have a 120-second bound, an 8 MB response limit and per-pane cancellation. Histories are supplied independently by the renderer and are not persisted. Ollama receives context size; LM Studio uses its loaded-model context settings. Chat status emits busy/running/error/cancelled-idle events.

The application checks its actual Windows token and refuses to run elevated. Admin PowerShell uses only the fixed built-in shell through a same-Electron executable helper launched via explicit RunAs. It accepts encoded PowerShell configuration, verifies the helper's actual admin token, then authenticates through a random named pipe and 256-bit nonce. Input/output/resize/exit JSON frames are validated and bounded. Cancellation, timeout, protocol failure and disconnect clean up session state; disconnected helpers terminate their PTY. Admin autoStart is normalized false. No UAC request is exercised by unit tests.

## Checks performed

- Test-first runtime suite initially failed because runtime modules were absent, then passed after implementation.
- `npm run build:main` passed with strict TypeScript checks.
- `npx vitest run tests/runtime.test.ts`: **15 tests passed**. Runtime validation, intentionally empty workspace save/reload, corrupt-file preservation and autosave prevention, atomic backup recovery, provider discovery/chat/cancellation/timeouts, IPC protocol construction, privilege boundaries and independent terminal lifecycle are covered.
- Real HTTP integration uses ephemeral loopback mock servers for both providers.
- PTY lifecycle tests use a controllable adapter, covering pane identity, independent output/input, cwd, resize, stop and restart cancellation races.
- Real isolated Electron **44.6.0** application smoke passed using the installed node-pty win32-x64 prebuild and bundled ConPTY DLL: two independently launched PowerShell PTYs used separate temporary cwd paths and output streams, received keyboard input, reported the requested **100 × 30** window dimensions, and stopped with both process PIDs disappearing.
- Native Claude executable resolved to `C:\\Users\\james\\.local\\bin\\claude.exe`; `--version` returned **2.1.292 (Claude Code)** and exited normally. No model request was sent.
- The isolated Electron application exited successfully via `app.quit()`, with no stderr. Reproduce after building main by running Electron with `dist-electron/electron/smoke.js` as its explicit application entrypoint. This smoke creates and removes only temporary cwd directories and does not open the production UI or touch saved workspace state.
- Static helper lifecycle review checked stop, pending elevation cancellation, authentication failure, timeout, disconnect and natural exit paths. Cancellation/timeout also kill the ordinary PowerShell launch process. Natural helper exit flushes its exit frame before closing the authenticated socket and avoids killing the terminal twice. No elevation prompt was started.

## Verification boundary

Interactive elevated ConPTY/UAC remains unverified and requires a human approval; tests never initiate UAC. Full renderer E2E and packaged executable verification are recorded by the primary integration agent separately. Packaging must retain node-pty's prebuilt native modules and bundled ConPTY DLLs in usable paths. The isolated native smoke verifies the actual Electron ABI and normal PTY workflow, not the interactive elevation approval path.

## Orchestrate mode

Orchestrate mode adds a per-workspace toggle, a loopback control server in the main process with two token classes, the `alphacode` command, worker launches in git worktrees, pane badges, a Tasks sidebar section with Approve plan, a status bar summary, finish and "Worker needs you" toasts, a run note in the Claude memory vault under `AlphaCode Runs`, an editable playbook at `%APPDATA%\alphacode\orchestrate.md`, and a Playwright test that drives a two-task plan through stub workers. The real run with Claude Code and a local advisor model has **not been performed**. This section records what the automated suite proves and what is still pending.

### Verified

Unit and integration tests, `tests/orchestrate.test.ts` and `tests/runtime.test.ts`:

- Plan validation: duplicate file, directory claim over a file, six tasks against a cap of five, bad id, absolute path, dirty index and non-git root are each rejected with the named reason.
- State machine: every signal against every state, the rejected pairs stay rejected, and a `stop` after `done` in the same turn is ignored.
- Token classes: control endpoints reject the hook token and a missing token; `report` rejects the control token and a hook token minted for another pane id.
- CLI end to end against the real server on a random loopback port, for every subcommand, plus a fake worker that reports through the hooks path.
- Launch overrides: worker flags built from the plan and pane config, the task prompt header, the CLI folder prepended to PATH, control variables absent from a worker's environment and hook variables absent from the orchestrator's.
- Wait: resolves on a state change, resolves on timeout, and caps the timeout.

Playwright test, real Electron app with stub workers (no Claude session): the toggle, the 6-pane preset, badges, the Tasks section, Approve plan, two stub workers creating real git worktrees and reporting done, the status bar summary, the finish badge, and turning the mode off clearing the badges.

Task 0 spike against Claude Code 2.1.296, in print mode:

- `--worktree task-x` creates the worktree at `<repo>/.claude/worktrees/<name>` on branch `worktree-<name>`.
- A Stop hook supplied only through `--settings <file>` fires.
- `--resume <session id>` run from inside the worktree resumes the session.

### Pending: real run

The steps below have not been run. They need a person at the keyboard to answer Claude Code's prompts.

1. Start Ollama serving `gpt-oss:20b` and set a Local Model profile to it.
2. Open a workspace whose Claude pane sits in a real git repository with a clean index (untracked files are fine).
3. Turn Orchestrate on, confirm the orchestrator restart, and note the 6-pane layout and the badges.
4. Ask for a small two-piece change, for example "add a --version flag to the CLI and document it in the README".
5. Observe the one-line triage in the orchestrator pane and the plan in the Tasks section.
6. Type `go` (or click Approve plan) and observe two workers start in worktrees, with badges moving Planned, Working, Task done.
7. Observe the merge, the UAT and red-team output in the orchestrator pane, the finish toast, and the note under `AlphaCode Vault\AlphaCode Runs`.
8. On a second attempt, restart the orchestrator pane by hand mid-run. Confirm it relaunches with the playbook and the tasks survive.
9. Confirm that Stop or Notification hooks in `~/.claude/settings.json` still run alongside the `--settings` hooks. This coexistence is untested.

### Not verified

- Anything involving a live Claude Code TUI: the interactive positional prompt together with `--worktree`, and the worker prompt text being accepted.
- Merge conflict handling, the retry path against a real worker, and the advisor consultation through `alphacode ask` against a real model.
- Windows toast appearance in an installed (packaged) build.
