# AlphaCode

AlphaCode is a local Windows terminal cockpit by JABSystems. It puts several independent
terminals and local-model chat panes on one resizable grid so you can run Claude Code,
Codex, Gemini, PowerShell, CMD, WSL, Git Bash, or any command side by side, each in its own
working directory, with layouts you can save, export, and reload.

Nothing leaves your machine. Terminals run as real local processes, local-model panes talk
only to Ollama or LM Studio on loopback, and every setting is stored in a JSON file in your
user profile.

---

## Contents

1. [Requirements](#requirements)
2. [Install and run](#install-and-run)
3. [First launch](#first-launch)
4. [Help: the interface, option by option](#help-the-interface-option-by-option)
   - [Toolbar](#toolbar)
   - [Sidebar: Workspace](#sidebar-workspace)
   - [Sidebar: Panes](#sidebar-panes)
   - [Sidebar: Local model profiles](#sidebar-local-model-profiles)
   - [Pane header and footer](#pane-header-and-footer)
   - [Configure pane dialog](#configure-pane-dialog)
   - [Pane types](#pane-types)
   - [Session status labels](#session-status-labels)
   - [Admin PowerShell and UAC](#admin-powershell-and-uac)
   - [Local model panes](#local-model-panes)
   - [Local model profile dialog](#local-model-profile-dialog)
   - [Keyboard](#keyboard)
5. [Where your data lives](#where-your-data-lives)
6. [Troubleshooting](#troubleshooting)
7. [Limits](#limits)
8. [Development](#development)
9. [Security model](#security-model)

---

## Requirements

- Windows 10 or 11, 64-bit. The app uses Windows ConPTY for terminals.
- Node.js 20 or newer and npm (for running from source).
- Optional CLIs for the matching pane types: Claude Code, Codex, Gemini, WSL, Git for Windows.
- Optional local model servers: Ollama (default port 11434) or LM Studio (default port 1234).
- Python 3 with Pillow, only if you want to regenerate the app icon.

AlphaCode refuses to start when launched as Administrator. Run it normally; only the
Admin PowerShell pane elevates, and only when you ask it to.

## Install and run

```powershell
git clone <this repo> AlphaBetaCode
cd AlphaBetaCode
npm install
npm run build
npm start
```

`launch.cmd` in the project root does the right thing either way: it starts the packaged
executable if one exists under `release\`, otherwise it runs `npm start`.

Other scripts:

| Command | What it does |
|---|---|
| `npm run dev` | Builds the Electron main process, starts the Vite dev server with hot reload, and opens the app against it. |
| `npm run build` | Type-checks, compiles the Electron main process to `dist-electron\`, and bundles the UI to `dist\`. Run this before `npm start`. |
| `npm start` | Launches the built app. |
| `npm test` | Unit tests (Vitest): workspace logic, validation, provider HTTP against mock servers, PTY lifecycle. |
| `npm run test:e2e` | Playwright end-to-end run of the real Electron app with real terminals. Uses an isolated data folder under `work\e2e-state`, so your saved workspaces are untouched. |
| `npm run smoke` | Launches Electron headless, spawns two real PowerShell PTYs, checks input, output, and resize, then exits. |
| `npm run package` | Produces a standalone `release\AlphaCode-win32-x64\AlphaCode.exe` with the app icon. |

## First launch

The first time AlphaCode runs with no saved state it creates a workspace called
**Development** rooted at `%USERPROFILE%\Dev\AlphaBeta` with eight panes:

| Pane | Type | Working directory | Starts automatically |
|---|---|---|---|
| Claude A, B, C, D | Claude | `<root>\workspaces\claude-a` … `claude-d` | Yes |
| PowerShell | PowerShell | `<root>` | Yes |
| PowerShell Admin | PowerShell Admin | `<root>` | Never (requires UAC) |
| Local · Coding | Local Model | n/a | n/a (chat, no process) |
| Local · General | Local Model | n/a | n/a |

The four `claude-*` folders are created under the root on every launch so the Claude panes
always have somewhere to start. Two local model profiles are created as well: an Ollama
profile preset to `qwen3:8b` and an LM Studio profile with no model selected.

If you want the workspace somewhere else, click the folder path in the sidebar and choose a
directory. Every pane that lived under the old root moves with it.

---

## Help: the interface, option by option

The window has a toolbar across the top, a collapsible sidebar on the left, the pane grid in
the middle, and a status bar along the bottom.

### Toolbar

**Sidebar toggle** (panel icon). Hides or shows the left sidebar. The grid takes the space.

**4 / 6 / 8 panes.** Layout presets. Each one keeps the first N panes in sidebar order and
resets the grid to an even two-column arrangement.

- If the workspace has more than N panes, the extra panes are **closed and their sessions
  ended**. You are asked to confirm first.
- If it has fewer than N, new PowerShell panes are added to make up the count.
- The preset buttons only highlight when the pane count matches exactly. Any pane count from
  0 to 32 is allowed; presets are a convenience, not a rule.

**Lock / Unlock layout** (padlock). When locked, panes cannot be dragged, resized, or
reordered. Terminals keep working normally. Use it once you like the arrangement and want to
stop accidental drags. The status bar shows "Layout locked" or "Layout editable".

**Add pane.** Opens a menu of pane types (see [Pane types](#pane-types)). Choosing one adds a
pane at the bottom of the grid, using the workspace root as its directory, and opens the
Configure dialog so you can set a name and directory. **Browse for a folder…** at the bottom
of the menu is a shortcut: pick a directory and a Claude pane is created there, named after
the folder, without opening the dialog. Panes added this way never auto-start until you
turn that on.

### Sidebar: Workspace

A workspace is one named arrangement: a root directory, a list of panes with their
configuration, and the grid layout. You can keep up to 50 of them.

**Workspace dropdown.** Shows the active workspace and lets you load another. Loading a
different workspace **ends every running session** in the current one; you are asked to
confirm. Sessions in the newly loaded workspace start according to each pane's auto-start
setting.

**Rename** (pencil). Changes the name of the current workspace in place. Nothing else changes.

**Project directory** (folder path button). Shows the workspace root. Click it to choose a
new root. Every pane whose directory was the old root, or a folder beneath it, is repointed
to the same relative place under the new root. Panes pointing elsewhere are left alone.
Running sessions are not restarted; the new directory takes effect the next time each pane
starts.

**Save as.** Makes a copy of the current workspace under a new name and adds it to the
dropdown. The copy gets fresh pane IDs, so its sessions are independent. The copy is not
loaded automatically. Select it from the dropdown when you want it.

**Export** (download icon). Writes the current workspace to a JSON file you choose: name,
root, panes, layout. Useful for backups or moving a layout to another machine.

**Import** (upload icon). Reads a workspace JSON file and adds it to the dropdown as a new
workspace. Importing never starts anything: all imported panes have auto-start switched off,
and the workspace is not loaded until you pick it. Check directories and commands before
starting sessions from an imported file.

### Sidebar: Panes

A list of every pane in the workspace, in grid order (left to right, top to bottom). The
colored dot is the session status. Click a name to focus that pane and scroll it into view.
If a pane is maximized, clicking another name switches the maximized view to that pane.

**Drag a list item**, or use the **up / down arrows**, to reorder. What happens depends on
the Drag behavior setting below.

**Drag behavior.** Controls what dragging does, both in this list and on the grid.

- **Reflow** (default). The dragged pane is inserted at the new position and the others shift
  to make room. The sidebar order follows the grid order. Reordering from the sidebar in this
  mode also resets the grid to the even two-column layout, so custom sizes are lost. Resize
  after reordering, or use Swap mode to keep sizes.
- **Swap.** The dragged pane and the pane you drop it on exchange places, including their
  sizes. Nothing else moves. Dropping on empty space puts the pane back where it was.

Neither mode restarts a session. Pane identity is the session; moving a pane never touches
its process or transcript.

**Balance panes.** Resets every pane to the same size in two columns. Disabled while locked.

### Sidebar: Local model profiles

Reusable connection settings for Ollama or LM Studio. Click a profile to edit it, or the plus
button to add one. See [Local model profile dialog](#local-model-profile-dialog).

**Local workspace storage** at the bottom shows the path of the file where everything is
saved. Hover for the full path.

### Pane header and footer

From left to right in the header:

- **Grip and title.** Drag the grip to move the pane on the grid (unless locked). The icon
  shows the pane type: terminal, shield for Admin, chip for local model.
- **Status label** with a colored dot. See [Session status labels](#session-status-labels).
  Hover it to read the last status message, which is where error details appear.
- **Configure** (sliders). Opens the Configure pane dialog.
- **Duplicate** (copy). Adds a new pane with the same configuration, named "<title> copy",
  with auto-start off. The new pane starts its own fresh session when you start it.
- **Maximize / Restore.** Shows only this pane in the grid. The other panes stay mounted, so
  their sessions keep running and their output is kept. Dragging and resizing are disabled
  while a pane is maximized. "Restore grid" in the sub-bar brings everything back.
- **Close** (X). Removes the pane from the workspace and ends its session. You are asked to
  confirm if the session is running.

Directly under the header is the **working directory strip**. Click it to pick a different
folder for this pane. Changing the folder stops a running session, because the directory is
fixed at launch; press Start to relaunch in the new folder.

The **footer** shows the kind of session and has **Clear** (clears the terminal screen
without touching the process) and either **Stop** (ends the process) or **Restart**
(launches a new process when nothing is running).

Before a terminal pane has started, or after it stops, a message panel sits over the
terminal with a **Start session** button. Panes with auto-start on skip this at load time.

### Configure pane dialog

**Pane name.** Display name only. Renaming never affects a running session.

**Pane type.** See [Pane types](#pane-types). Changing the type switches auto-start off, so
you make a deliberate choice about the new command.

**Working directory.** Where the process starts. Must exist. Use the folder button to browse.

**Executable override** (not shown for Admin or Local Model). Leave blank to use the default
command for the type. Fill it in to point at a specific executable, for example a particular
`claude.exe` or a portable PowerShell 7. Absolute paths are used as-is; bare names are looked
up on `PATH`. For the **Custom Command** type this field is required and is labelled
"Executable or script path".

**Arguments (one per line).** Extra command-line arguments, one per line, passed exactly as
typed with no shell interpretation. For PowerShell panes the default is `-NoLogo -NoProfile`
when this is empty; typing any arguments replaces that default entirely.

**Local model profile** (Local Model type only). Which saved profile this pane chats with.

**Start this session when workspace loads** (auto-start). When on, the pane launches its
process as soon as the workspace loads or the app opens. When off, the pane waits for you
to press Start. Admin PowerShell can never auto-start. Duplicated and imported panes always
start with this off.

**Apply changes.** If you changed the type, directory, executable, or arguments while the
session was running, the session is stopped (after a confirmation) and the pane returns to
the Start state. Name and auto-start changes apply without interrupting anything.

### Pane types

| Type | Default command | Notes |
|---|---|---|
| **Claude** | `%USERPROFILE%\.local\bin\claude.exe` if present, otherwise `claude` on PATH | Claude Code CLI. Each pane is its own Claude session in its own directory. |
| **PowerShell** | Windows PowerShell 5.1 | Runs with `-NoLogo -NoProfile` unless you supply arguments. |
| **PowerShell Admin** | Windows PowerShell 5.1, elevated | Requires a UAC approval each time it starts. No overrides, no arguments, no auto-start. See below. |
| **Local Model** | none | A chat transcript against an Ollama or LM Studio profile. No process is spawned. |
| **Codex** | `codex` on PATH | OpenAI Codex CLI. |
| **Gemini** | `gemini` on PATH | Google Gemini CLI. |
| **WSL** | `wsl.exe` | Your default WSL distribution. |
| **CMD** | `%ComSpec%` (cmd.exe) | Classic command prompt. |
| **Git Bash** | `C:\Program Files\Git\bin\bash.exe` | Set an override if Git is installed elsewhere. |
| **Custom Command** | none, required | Any executable or `.cmd`/`.bat` script. Never auto-starts by default. |

npm-style `.cmd` and `.bat` shims (how many Node CLIs are installed on Windows) are launched
through PowerShell with each argument quoted literally, so arguments are never interpreted
as PowerShell syntax.

All terminal panes are real pseudo-terminals: colors, cursor, scrollback (5000 lines),
resize, Ctrl+C, and interactive programs all work.

### Session status labels

| Label | Dot | Meaning |
|---|---|---|
| **Ready** | grey | No process. Press Start. |
| **starting** | amber | Launching. For Admin panes this includes waiting for the UAC prompt. |
| **running** | green | Process is alive and attached. Admin panes show **Admin** instead. |
| **busy** | amber | Local model pane is waiting for a response. |
| **exited** | dark grey | Process ended on its own, or you pressed Stop. Hover for the exit code. |
| **error** | red | Launch failed. Hover the label, or read the red line in the terminal, for the reason. |

The sub-bar above the grid shows how many panes are active out of the total.

### Admin PowerShell and UAC

The Admin pane is the one place AlphaCode runs anything elevated, and it is deliberately
restrictive:

- It can only run Windows PowerShell. Executable overrides and arguments are rejected.
- It never auto-starts. Press **Start with UAC** and approve the Windows prompt.
- You have 60 seconds to answer the prompt. Declining, cancelling, or timing out puts the pane
  in the error state; press Start again to retry. **Cancel launch** withdraws the request.
- Behind the scenes a separate helper process is launched with "Run as administrator". The
  main app and all other panes stay unelevated. The helper authenticates to the app over a
  random named pipe with a one-time secret before any output is exchanged.
- The pane has an amber border and an "UAC session" tag so it is always obvious which
  terminal has admin rights.

The app itself refuses to start if it has been launched as Administrator, because that would
give every pane elevated rights silently.

### Local model panes

A Local Model pane is a chat window, not a terminal.

- **Profile strip** at the top: pick which saved profile to use and open **Configure** to edit
  it. Switching profiles clears the conversation.
- Type in the composer and press **Enter** to send. **Shift+Enter** inserts a new line.
- The arrow button sends. While a reply is being generated it becomes a **stop** button that
  cancels the request.
- **Clear** in the footer empties the transcript.
- Each pane has its own independent conversation. Conversations are kept in memory only and
  are gone when the app closes or the pane is removed.
- Requests time out after 120 seconds and responses are capped at 8 MB.

### Local model profile dialog

**Profile name.** How the profile appears in lists.

**Provider.** Ollama or LM Studio. Changing the provider resets the endpoint to that
provider's default port and clears the model.

**Temperature.** 0 to 2. Lower is more deterministic, higher is more varied. 0.3 suits coding,
0.7 is a general default.

**Endpoint.** The base URL of the local server. Only `http://` or `https://` addresses on
`localhost`, `127.0.0.1`, or `[::1]` are accepted. Defaults: `http://localhost:11434` for
Ollama, `http://localhost:1234` for LM Studio.

**Model.** The model name as the server knows it, for example `qwen3:8b`. Press **Discover**
to ask the server for its list; a dropdown of available models appears if the call succeeds.
If Discover fails, the server is not running or the endpoint is wrong.

**Context size (tokens).** 512 to 1,048,576. For Ollama this is sent with every request as
`num_ctx`. For LM Studio it is informational only: LM Studio fixes the context length when
you load the model in its server, so set it there.

**System prompt.** Sent as the first message of every conversation that uses this profile.

### Keyboard

| Keys | In a terminal pane |
|---|---|
| **Ctrl+C** | Sent to the running process (interrupt), as in any terminal. |
| **Ctrl+Shift+C** | Copy the current selection. |
| **Ctrl+Shift+V** | Paste from the clipboard. |
| **Ctrl+V** | Also pastes, via the native paste event, so dictation tools such as Wispr Flow work. |
| **Shift+Enter** | In a local model composer, inserts a new line instead of sending. |

Clicking anywhere in a pane focuses it and sends keyboard input there.

---

## Where your data lives

Everything AlphaCode remembers is in one file:

```
%APPDATA%\alphacode\state.json
```

It contains all workspaces (panes, directories, commands, layouts) and all local model
profiles. It does not contain terminal output, chat transcripts, or any secrets.

- Saves happen automatically about half a second after any change. The status bar shows
  "Saving…" then "Saved locally".
- Each save is written to a temporary file and swapped in atomically, and the previous valid
  file is kept as `state.json.bak`.
- On startup, if `state.json` is unreadable or invalid, the `.bak` file is loaded instead.
- Set the environment variable `ALPHACODE_DATA_DIR` to a folder to keep a completely separate
  set of settings, for example for testing. The end-to-end tests do this.

Editing the file by hand is fine while the app is closed. The app validates it on load and
refuses anything malformed rather than guessing.

## Troubleshooting

**"Working directory does not exist: … Choose an existing directory in pane configuration."**
The pane's folder was moved, renamed, or deleted. Click the directory strip under the pane
title and pick the new location, or click the workspace root in the sidebar to move every
pane under it at once.

**"Cannot find claude. Install the CLI, add it to PATH, or set its full executable path in
pane configuration."** (or codex, gemini, bash.exe). The CLI is not installed, or not on the
`PATH` the app was launched with. Install it, or set the Executable override in the pane's
Configure dialog to the full path. After installing a CLI, restart AlphaCode so it sees the
new `PATH`.

**"AlphaCode must run without Administrator privileges."** You started the app from an
elevated shell or with "Run as administrator". Close it and start it normally.

**"Windows elevation was declined, cancelled, or could not start."** The UAC prompt was
dismissed or timed out. Press Start with UAC again.

**"Saved workspace state is corrupt or invalid and no valid backup is available."** Both
`state.json` and `state.json.bak` failed validation. The app leaves them untouched and blocks
saving. Move both files out of `%APPDATA%\alphacode\`, start the app to get the default
workspace, then use Import to bring back a previously exported workspace.

**"Cannot reach <profile> at <endpoint>"** or **"Local provider returned HTTP …"**. The model
server is not running, is on a different port, or does not have the selected model loaded.
Open the profile and press Discover to confirm the connection.

**The error log repeats the same message once per pane.** That is expected: every pane with
auto-start on tries independently at load, so a bad shared setting shows up once each.

**A pane says "exited" immediately after Start.** The program ran and quit. Hover the status
label for the exit code and look at the terminal for the program's own message.

## Limits

| Thing | Limit |
|---|---|
| Panes per workspace | 32 |
| Saved workspaces | 50 |
| Local model profiles | 50 |
| Terminal scrollback | 5000 lines |
| Local model request time | 120 seconds |
| Local model response size | 8 MB |
| Workspace import file size | 4 MB |

## Development

```
electron/      Main process: window, IPC, PTYs, elevation helper, provider HTTP, state file
src/           React renderer: App shell, TerminalPane, LocalPane, PaneEditor, ProfileEditor
shared/        Types and pure workspace logic shared by both sides, plus all validators
tests/         Vitest unit tests and the Playwright e2e spec
scripts/       dev.cjs (dev server + Electron) and make-icon.py (regenerates public/icon.ico)
public/        Static assets copied into the build: icon.svg (favicon) and icon.ico (window and exe icon)
docs/          Design spec, plan, and runtime verification report
```

The stack is Electron 44, React 19, TypeScript, Vite, xterm.js 6, node-pty 1.1 (ConPTY),
and react-grid-layout. The renderer runs sandboxed with context isolation and no Node
integration; it talks to the main process only through the typed bridge in
`electron/preload.ts`, whose shape is `BridgeApi` in `shared/types.ts`.

Workspace behavior (reorder, swap, presets, duplication, moving the root, validation) is pure
code in `shared/domain.ts` and is unit tested without Electron. Change it there and the main
process and renderer both pick it up.

To change the app icon, edit `public/icon.svg`, mirror the change in `scripts/make-icon.py`,
and run `python scripts/make-icon.py`.

## Security model

- The renderer cannot touch the filesystem, spawn processes, or make network requests
  directly. Every capability is a named IPC call, and the main process validates every
  argument against the shared validators before acting.
- IPC is only accepted from the app's own top-level window. Navigation and new windows are
  blocked, and the content security policy allows no remote content.
- Terminal processes inherit a copy of the app's environment with internal variables removed.
- Local model endpoints are restricted to loopback addresses, with redirects disabled and
  URL credentials rejected.
- Elevation is confined to a separate helper process that runs only PowerShell, authenticates
  with a 256-bit nonce over a random named pipe, and is torn down on disconnect, timeout, or
  cancel.
- State files are validated on load; invalid files are preserved for recovery, never
  overwritten.

See `docs/runtime-report.md` for what has been verified and the exact boundaries of that
verification.
