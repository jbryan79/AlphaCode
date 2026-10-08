# AlphaCode Implementation Plan

> **For agentic workers:** Use Superpowers execution with test-first behavior checks and a fresh whole-app review. Steps use checkbox syntax for tracking.

**Goal:** Deliver the Windows terminal cockpit specified in the design.
**Architecture:** Electron main owns sessions, persistence and local provider calls. React receives a typed preload API and retains pane identity through layout changes.
**Tech Stack:** Electron, React, TypeScript, xterm.js, node-pty, react-grid-layout, Vitest, Playwright.
**Spec:** ../specs/2026-10-07-alphacode-design.md

## Global constraints
- Windows 10 1809+ or Windows 11; Node 22+ for source builds.
- The application stays unelevated; only a deliberately started Admin PowerShell helper uses UAC.
- Default 8 panes: 4 Claude, 2 PowerShell variants, 2 local model sessions.
- Stable pane IDs; local-only profile endpoints; persistent versioned configuration.

## Review focus
- Working directories with spaces and missing optional CLIs must be handled without command injection.
- Reorder/maximize/rename must preserve live processes and input focus.
- Loading malformed JSON must preserve the previous valid workspace.
- Model cancellation/HTTP failures must restore a usable composer and independent histories.
- UAC cancellation/disconnect must not leave hidden elevated shells alive.

### Task 1: Workspace domain and runtime contracts
Files: shared/types.ts, shared/domain.ts, tests/domain.test.ts, configuration files.
- [ ] Define the IPC/state contracts (shared/types.ts) and add failing tests for defaults, reorder/swap, presets, cloning and invalid imports.
- [ ] Run npm test and confirm missing domain behavior fails.
- [ ] Implement immutable workspace operations; run domain tests to green.

### Task 2: Desktop runtime
Files: electron/main.ts, preload.ts, sessions.ts, elevation.ts, admin-helper.ts, storage.ts, models.ts; tests/runtime.test.ts.
Consumes BridgeApi/PaneConfig/AppState; emits SessionEvent.
- [ ] Add failing tests for validation, launch resolution, provider calls and privilege separation.
- [ ] Implement PTY lifecycle with node-pty, narrow IPC, atomic persistence, providers and authenticated elevated helper.
- [ ] Build main and run provider/runtime tests.

### Task 3: Dashboard and visual mockup
Files: src/main.tsx, App.tsx, TerminalPane.tsx, LocalPane.tsx, PaneEditor.tsx, styles.css, docs/dashboard-mockup.html.
Consumes BridgeApi and shared domain operations.
- [ ] Build stable keyed grid, sidebar, toolbar, pane editor, model profile editor and workspace dialogs.
- [ ] Implement drag/reflow + swap, resizing, lock, focus/maximize, title/type/cwd configuration, clone/remove/add and preset handling.
- [ ] Create a polished static mockup from the same design tokens with clearly labeled sample content.
- [ ] Compile and inspect actual desktop screenshots.

### Task 4: Verification and handoff
Files: tests/e2e.spec.ts, playwright.config.ts, README.md, docs/verification.md, launch.cmd.
- [ ] Test built app launch, real PowerShell/Claude PTY, independent cwd, interaction and persistence; use local provider fixtures.
- [ ] Run npm test, npm run build, npm run test:e2e, and package the Windows directory build.
- [ ] Review screenshots and source with a fresh reviewer; fix material defects and repeat affected checks.
- [ ] Record results and limits; provide a runnable build and launch instructions.
