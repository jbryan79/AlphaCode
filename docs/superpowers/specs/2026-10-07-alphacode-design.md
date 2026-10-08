# AlphaCode first desktop version

## Intent and acceptance
Build a runnable Windows terminal cockpit in D:\Dev\clauDashole. The directory was inspected and is empty. User supplied fifteen explicit requirements and requested implementation and verification in this session. Default workspace has four independently launched Claude CLI sessions, normal PowerShell, an Admin PowerShell waiting for a deliberate UAC launch, and two local model sessions. Configuration and position are separate. No command is broadcast across panes.

## Stack decision
Electron + React + TypeScript + xterm.js + node-pty (Windows ConPTY). Electron is chosen for native PTY integration and a same-runtime elevated helper. Tauri would reduce runtime size but require Rust/Win32 elevation and PTY integration alongside the frontend; a native .NET app would sacrifice the requested React ecosystem. Electron is an explicit user-permitted alternative.

## Visual specification
Dark terminal-centric shell, native window frame, compact 48px toolbar, 216px workspace sidebar, pane grid with 8px gaps. Palette: canvas #131619, terminal #101214, raised #1c2025, border #30363d, text #dce2e8, secondary #a3adb8, focus #8cb7df, admin #d8ae68. Segoe UI for controls; Cascadia Mono/Consolas for terminal text. Pane header separates drag grip, title, session status, configure and maximize controls. Working directory sits directly below the title bar. Admin pane has a shield, amber trim, and explicit elevation label. Local panes use a compact transcript and composer. No animated ornament, gradients, fake live indicators, or futuristic branding.

Default spatial layout is two columns by four rows. Presets 4/6/8 arrange the first N panes and create defaults as needed; shrinking hides/removes panes only after a confirmation because sessions end. Runtime supports odd counts. Drag uses insertion/reflow; an explicit swap mode swaps positions without recreating sessions. Free resizing uses grid handles. Maximize keeps every pane mounted so its PTY/transcript survives.

## Runtime and isolation
Renderer has context isolation, sandbox, no Node integration. Typed preload exposes a narrow IPC interface. Main owns PTYs, file persistence and provider HTTP calls. Pane IDs are session identity. Reordering, focusing and renaming never restart PTYs. Duplication clones configuration with a new ID and a fresh independent session. Type/cwd/command changes require an explicit restart action. Workspace switching closes current sessions after a confirmation and starts eligible normal sessions in the loaded workspace.

Every terminal supports start/stop/restart, resize, Ctrl+C, keyboard input, scrollback and copy/paste. PowerShell and Claude launch with independently configured cwd; the four default Claude directories are created beneath this project's workspaces folder on first run. Missing CLIs and invalid directories produce actionable errors.

## Elevation
Main rejects launch as Administrator to preserve normal session integrity. Admin panes never auto-start. Start invokes Start-Process -Verb RunAs for a dedicated Electron helper process using the same packaged native PTY module. The helper has no UI window, authenticates to a random named pipe with a cryptographic nonce, verifies its admin token, then launches only PowerShell through ConPTY. It relays output/input/resize/exit over framed JSON. Cancellation, rejection, timeout and disconnect terminate the session with an honest status. No ordinary PTY receives an elevated token. Interactive UAC approval remains a user action; it is never automated.

## Local models
Saved independently selectable Ollama and LM Studio profiles: endpoint, model, system prompt, context size and temperature. Discover models with GET /api/tags or /v1/models; Ollama POST /api/chat, LM Studio POST /v1/chat/completions. Each pane owns conversation history and cancellation. Main performs HTTP requests with bounded timeouts and descriptive errors. Version one limits endpoints to HTTP(S) loopback hosts for a local-only cockpit, passes context size to Ollama, and explains LM Studio context is controlled by model load settings. Profiles/config persist; transcripts and terminal processes do not survive app exit.

## Persistence
Versioned app state in the user's Electron userData directory; validated on load, atomic replacement and backup. Named workspace save/load plus portable JSON export/import. Import validates configuration and requires a deliberate load, never executes commands merely by selecting a file. Presets are even but pane counts are unrestricted. Layout lock disables dragging/resizing, not terminal interaction.

## Verification
Behavior tests for identity-preserving reorder/swap, odd counts, cloning, preset sizing and validation. Provider integration tests using local mock HTTP servers. Electron end-to-end workflow checks built runtime, xterm keyboard input/output, Claude CLI invocation, separate cwd, resize/reorder/focus, configuration, workspace save/reload, profiles and import/export validation. Admin tests exercise protocol and launch construction without approving UAC; interactive elevated PTY is labeled unverified unless the user approves it. Review actual screenshots, produce a matching static dashboard mockup, and document exact verified boundaries in README/verification report.
