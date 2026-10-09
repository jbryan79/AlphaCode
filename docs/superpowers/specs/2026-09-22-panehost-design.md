# Panehost — Design Spec

**Date:** 2026-09-22
**Status:** Approved design, pending implementation plan
**Working name:** Panehost (rename is cheap)

## 1. Purpose

A native Windows desktop dashboard that keeps many terminal sessions visible on one screen, optimized for running several **Claude Code** sessions in parallel alongside general shells and dev servers. The dashboard makes agent state obvious at a glance (working / waiting for you / done / error), alerts when an agent needs attention, and never loses a running session because the window was closed or the UI crashed.

### Success criteria

1. Four Claude Code sessions plus a dev server run in one auto-tiled grid.
2. Closing the window (or killing the UI process) leaves every session running; reopening reattaches with scrollback.
3. A session that needs input produces a native toast and a visible amber pane within ~1 s, even when the window is hidden to tray.
4. After a reboot, opening a workspace restores the panes and resumes Claude conversations via `claude --resume`.
5. Keystroke-to-echo latency is indistinguishable from Windows Terminal in normal use.

### Non-goals (v1)

Remote/phone access · manual split layouts · multi-window/multi-monitor · themes beyond dark/light · plugin system · auto-update · exact screen-state restoration (the `vt100`-based mirror is a v2 candidate).

## 2. Environment

Windows 11, Rust 1.96, Node 24 / pnpm 11, Tauri 2. Shells: Windows PowerShell 5.1 (`powershell.exe`, the default), `cmd.exe`, `wsl.exe -d <distro>`. PowerShell 7 is not installed and is not assumed.

## 3. Architecture

Three executables in one Cargo workspace plus a web UI:

```
panehost/
├─ crates/
│  ├─ protocol/   shared, versioned message types (serde) — the only inter-process contract
│  ├─ hostd/      background daemon: owns PTYs, state, persistence, hook intake
│  ├─ hook/       panehost-hook.exe — tiny CLI invoked by Claude Code hooks
│  └─ app/        Tauri 2 shell: window, tray, notifications, global hotkey, launches hostd
└─ ui/            React + TypeScript + Vite, xterm.js (WebGL renderer)
```

| Unit | Responsibility | Depends on |
|---|---|---|
| `protocol` | Defines all messages: `Hello`, `Snapshot`, `Spawn`, `Input`, `Resize`, `Kill`, `Attach`, `Detach`, `Output`, `PaneAdded`, `PaneRemoved`, `PaneState`, `PaneMeta`, `HookEvent`, `SystemStats`, `Workspace*`. Exposes `PROTOCOL_VERSION`. Generates TypeScript types via `ts-rs`. | serde |
| `hostd` | Spawns and supervises PTYs through ConPTY (`portable-pty`); 4 MB output ring buffer per pane; pane state machine; transcript token/cost accounting; git/port/system sampling; persistence in `%APPDATA%\Panehost\`; WebSocket server. | protocol, portable-pty, tokio, axum, sysinfo |
| `hook` | Reads hook JSON from stdin, attaches `PANEHOST_PANE_ID` from env, POSTs to hostd. Always exits 0 within 200 ms. No-op when `PANEHOST_PANE_ID` is absent. | protocol |
| `app` | Discovers or launches hostd; passes endpoint + token to the UI; tray icon with waiting-count badge; native toasts + sound; global hotkey; start-at-login; single instance. Keeps its own event-only connection to hostd so alerts work while the window is hidden. | protocol, Tauri 2 plugins (single-instance, notification, global-shortcut, autostart) |
| `ui` | Grid, pane headers, status bar, context drawer, command palette. Talks to hostd **directly** over WebSocket for all terminal I/O and pane actions; uses Tauri IPC only for OS-level features. | generated protocol types, xterm.js |

### Boundaries and rules

- **Direct UI↔hostd data path.** The Tauri process never relays terminal bytes, so an app crash cannot affect shells and there is no extra hop on keystrokes.
- **Discovery.** hostd binds `127.0.0.1` on an OS-assigned port and writes `%APPDATA%\Panehost\hostd.json` = `{port, token, pid, protocolVersion}` (token: 32 random bytes, hex; file written atomically). The app reads it, verifies the pid is alive and the version matches, and otherwise spawns hostd (detached, no console window).
- **Auth — two token classes.**
  - **Control token** (in `hostd.json`): required by every WebSocket, which must send `Hello{token, protocolVersion}` first; any other first frame or a bad token closes the socket. It **never** enters a PTY environment — anything running inside a pane (an agent, its tools, an npm script) must not be able to spawn panes or type into other panes.
  - **Hook token** (per pane): hostd mints a fresh random token for each pane at spawn and injects it as `PANEHOST_HOOK_TOKEN`, alongside `PANEHOST_PORT` and `PANEHOST_PANE_ID`. It is accepted **only** by `POST /hook`, and only for events naming that same pane id, so a process in pane A can neither reach the control channel nor forge status for pane B. The WebSocket rejects hook tokens.
- **Single instance.** hostd holds a per-user named mutex `Local\PanehostHostd-<hash of data dir>` (per-session namespace so other Windows users are unaffected; the data-dir hash lets test instances with `PANEHOST_DATA_DIR` run alongside the real one); the app uses Tauri's single-instance plugin.
- **Version skew.** hostd outlives app updates. On mismatch the UI shows "Restart the service to update — N sessions will be resumed/relaunched" and never restarts hostd without confirmation.

### Wire format

- Control messages: JSON text frames, tagged enums (`{"type": "Spawn", ...}`).
- Terminal data: binary frames `[16-byte pane UUID][payload]` in both directions (`Output` from hostd, `Input` from UI).

## 4. Data flow and pane lifecycle

### Spawn

1. UI sends `Spawn{title, cwd, command, kind: claude|shell, shell: powershell|cmd|wsl(distro), workspace?}`.
2. hostd creates the ConPTY with `PANEHOST_PANE_ID`, `PANEHOST_PORT` and that pane's `PANEHOST_HOOK_TOKEN` (never the control token), records the pane, persists pane metadata, and broadcasts `PaneAdded`.
3. PTY output is coalesced in ~8 ms batches, appended to the pane's ring buffer, and fanned out as binary `Output` frames to every client attached to that pane.

A `kind: claude` pane runs `claude` (plus any user args) inside the chosen shell.

### Attach / reattach

1. UI connects, sends `Hello`, receives `Snapshot{panes[], states, meta, workspaces}`.
2. For each pane in the grid, UI sends `Attach{pane, cols, rows}`. hostd replies with a reset sequence (`ESC c`), then the ring-buffer contents, then live output.
3. **Redraw nudge:** hostd then resizes the PTY to `cols-1` and back to `cols`, forcing full-screen TUIs (Claude) to repaint cleanly. Plain shells simply show replayed history.
4. **Backpressure:** each client has a bounded per-pane send queue (1 MB). On overflow hostd drops the queue and re-sends the reset + ring buffer. hostd never blocks on a slow client and never grows memory without bound.

### Pane state machine

| Kind | States | Transitions |
|---|---|---|
| shell | `running`, `exited(code)`, `error(msg)` | spawn → running; process exit → exited; spawn failure → error. An `active` flag is true when output arrived in the last 2 s. |
| claude | `starting`, `idle`, `working`, `waiting`, `done`, `exited(code)`, `error(msg)` | spawn → starting; `SessionStart` → idle; `UserPromptSubmit` → working; `PreToolUse` → working; `Notification` → waiting **only** when it is a permission/input request (`notification_type` = `permission_prompt`, or message text matching "needs your permission" when the field is absent) — `idle_prompt` notifications leave the state unchanged so a finished pane stays `done`; `Stop` → done; process exit code 0 → exited; non-zero → error; spawn failure → error. |

The state machine is a pure function `(state, event) → state` with no I/O, unit-tested exhaustively.

### Claude hooks integration

- **Opt-in install:** Settings → "Install Claude hooks" merges `panehost-hook.exe` entries for `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `Notification`, `Stop` into `~/.claude/settings.json`. It preserves existing hooks, writes a timestamped backup first, validates the merged JSON, and writes atomically (temp + rename). "Uninstall" removes only Panehost entries.
- **Delivery:** the hook reads stdin JSON, adds `pane_id`, POSTs to `http://127.0.0.1:$PANEHOST_PORT/hook` with `Authorization: Bearer $PANEHOST_HOOK_TOKEN`; hostd answers 401 unless the token matches the hook token of the pane named in the body; 200 ms total timeout; exit 0 on every path. Sessions not started by Panehost lack `PANEHOST_PANE_ID` and the hook exits immediately.
- **Session metadata:** `SessionStart` supplies `session_id` and `transcript_path`, stored on the pane and persisted (enables resume).
- **Tokens and cost:** hostd tails the transcript JSONL incrementally (tracking byte offset), sums `usage` input/output/cache tokens per model, and computes cost from a built-in price table. Cost is always labeled "≈ estimated". Unknown models show tokens only.

### Alerts

- The app's event connection receives `PaneState` changes. Transitions into `waiting`, `done`, or `error` raise a native toast + sound, except for the currently focused pane (the UI reports focus to the app via Tauri IPC) and muted panes. Global Do-Not-Disturb suppresses all toasts.
- Tray icon shows a badge with the count of `waiting` panes. Clicking a toast focuses the window on that pane.

### Broadcast and quick commands

- `Ctrl+K` palette lists actions, saved snippets, and workspaces (fuzzy search).
- Broadcast mode: select panes (Ctrl-click headers, or "all Claude panes"), type once; the UI sends one `Input` frame per selected pane. Snippets are stored in `snippets.json` as `{name, text, submit: bool}`; `submit` appends `\r`.

### Workspaces

- Stored in `workspaces.json`: `{name, panes: [{title, cwd, command, kind, shell}]}`.
- **Open** spawns only panes not already running (matched by workspace + title). **Save current layout** captures the live grid.
- **Resume after hostd restart:** persisted pane metadata includes `session_id` for Claude panes; restoring relaunches them with `claude --resume <session_id>`, and relaunches shell panes with their original command.

### Window lifecycle

Close button hides to tray. Tray menu: Show · Do Not Disturb · Quit (closes app, hostd keeps running) · Quit and stop all sessions (confirmation required; stops hostd).

## 5. UI

### Visual direction

Calm, dense, professional. Dark theme default, light theme available. One accent color; status colors reserved for status (working: blue, waiting: amber, done: green, error: red, idle/exited: neutral). Inter for chrome, JetBrains Mono for terminals (configurable). Motion limited to ~150 ms zoom/resize transitions; honors the OS reduce-motion setting.

### Layout

```
┌ Status bar ──────────────────────────────────────────────────────────────┐
│ Panehost [Workspace ▾]  4 agents · ◐ 1 waiting · ✓ 1 done  ≈$2.14  CPU 23% RAM 61%  Ctrl+K  ☰ │
├───────────────────────────────┬──────────────────────────────────────────┤
│ ● api · claude · main*    ⋯ ⤢ │ ◐ web · claude · feat/nav     ⋯ ⤢        │
│  xterm                        │  (amber border + header while waiting)   │
├───────────────────────────────┼──────────────────────────────────────────┤
│ ✓ docs · claude               │ ▸ web · npm run dev · :5173              │
└───────────────────────────────┴──────────────────────────────────────────┘
                                                context drawer slides in from right
```

- **Auto-tiling grid:** column count chosen to keep panes closest to square for the current window aspect ratio. Drag headers to reorder (order persisted). Zoom one pane to full window and back; other panes keep running. More than 9 panes → overflow panes appear as status chips in a strip under the status bar; clicking a chip swaps it into the grid.
- **Pane header:** status dot, title, kind, git branch (`*` if dirty), first listening port. `⋯` menu: rename, restart, resume (claude), mute, kill, open folder in Explorer / VS Code.
- **Waiting emphasis:** amber border + header; status-bar "waiting" count is clickable and cycles through waiting panes.

### Context drawer (320 px, follows focused pane)

- **Session:** state and time in state, Claude session id, tokens in/out, ≈ cost, last prompt (from transcript).
- **Git:** branch, ahead/behind, changed-file count and list, "copy diff summary". Sampled by hostd via `git status --porcelain=v2 -b` every 5 s and on each hook event; cwd comes from the pane's launch cwd, updated by the `cwd` field in hook payloads.
- **Ports:** listening TCP ports owned by the pane's process tree (via the Windows TCP table + process-tree walk), with open-in-browser links. Sampled every 5 s.
- **System:** overall CPU/RAM and per-pane process-tree CPU/RAM (`sysinfo`), sampled every 2 s.

### Keyboard

| Keys | Action |
|---|---|
| `Ctrl+Alt+Space` (global) | Summon / hide window |
| `Ctrl+Shift+T` | New pane |
| `Ctrl+Shift+W` | Jump to next waiting pane |
| `Ctrl+Shift+D` | Toggle context drawer |
| `Alt+1…9` | Focus pane N |
| `Ctrl+Shift+Enter` | Zoom / unzoom focused pane |
| `Ctrl+Shift+B` | Toggle broadcast mode |
| `Ctrl+K` | Command palette |

All other keys pass through to the focused terminal. Shortcuts are configurable in `settings.json`.

### Performance

xterm.js WebGL renderer; one `Terminal` instance per pane, created once and reparented (never recreated) across layout changes; resize debounced (~50 ms) and sent to hostd only when cols/rows actually change; 10k-line client scrollback (hostd ring buffer holds the durable history).

## 6. Persistence

All under `%APPDATA%\Panehost\`: `hostd.json` (discovery), `settings.json` (UI + shortcuts + DND + default shell), `workspaces.json`, `snippets.json`, `panes.json` (live pane metadata incl. Claude session ids, for resume), `logs\` (daily rotation, 7 days kept). All writes are atomic (temp + rename). A file that fails to parse is renamed `*.bad` and replaced with defaults; the UI shows a one-time notice.

## 7. Error handling

| Failure | Behavior |
|---|---|
| hostd not running at app start | App spawns it, waits ≤3 s for a fresh `hostd.json`; on failure shows a banner with the tail of `hostd.log` and Retry. |
| hostd crashes | UI shows "Service disconnected", reconnects with exponential backoff (250 ms → 5 s). App respawns hostd, then offers to resume Claude panes and relaunch shell panes from `panes.json`. |
| Pane spawn fails (bad cwd / missing command) | Pane shows `error` with the message inline plus Edit / Retry; other panes unaffected. |
| Hook fires while hostd is down | 200 ms timeout, exit 0; Claude is never blocked. |
| Hook event for unknown pane id | Logged at debug, ignored. |
| Protocol version mismatch | Upgrade prompt (§3); no silent restart. |
| `~/.claude/settings.json` unreadable or invalid | Install aborts with a clear message; file untouched. |
| Corrupt Panehost state file | Renamed `*.bad`, defaults used, user notified once. |

## 8. Testing

- **protocol:** serde round-trip for every message; CI check that generated TS types are current.
- **hostd unit:** state machine (every transition + unexpected-event sequences), ring buffer (wraparound, replay correctness), Claude settings merge (existing hooks preserved, idempotent install, clean uninstall), transcript token/cost parsing against sample JSONL fixtures (including incremental tailing from a byte offset), port-to-process-tree attribution.
- **hostd integration:** start a real hostd on a temp `%APPDATA%`; over WebSocket: auth rejection, spawn `cmd /c echo hello`, attach and read output, detach + reattach replay, resize, kill, `POST /hook` drives state changes; token isolation — a pane's environment contains no control token, a hook token cannot open the WebSocket, and pane A's hook token is refused for pane B's events.
- **hook:** exits 0 in <200 ms with hostd down; delivers the event with hostd up; no-op without `PANEHOST_PANE_ID`.
- **ui:** Vitest for grid-geometry math, status reducer, and keyboard routing; Playwright against a fake hostd for zoom, drawer, broadcast, waiting-pane navigation, and reconnect banner.
- **Manual acceptance (v1 exit):** the five success criteria in §1, run on this machine.
