# Release notes

## Unreleased (since v0.1.0)

52 commits, 2026-10-08 to 2026-10-19. The version in `package.json` is still 0.1.0.

### Multimodel: new name, Chat view, Support agent

- **Renamed to Multimodel** in the window title, toolbar, dialogs and the packaged folder
  (`release\Multimodel-win32-x64\Multimodel.exe`). It has a new logo and app icon: an M drawn
  as a graph of model nodes. Saved settings stay in `%APPDATA%\alphacode`, so workspaces carry
  over. Internal names are unchanged: the `alphacode` orchestrator command, `ALPHACODE_*`
  variables and the `AlphaCode Vault` folder.
- **Chat view, opened at launch.** A full-size Claude Code session outside every workspace and
  run. It has its own folder (click it to change) and a **New chat** button. The
  **Chat | Orchestration** switch sits in the toolbar. When a run is on, a dot on the
  Orchestration tab and a status pill in Chat show its progress.
- **Support dock in Orchestration.** A second Claude session that runs in the Multimodel source
  folder whatever project is being orchestrated. Packaged builds find it by looking above the
  exe; you can choose a different folder. **Ask for help** (in the dock, the run header, and on
  run error notices) sends Support the run's project, every task's state and message, recent app
  errors and where the run data lives. It types this into a live session, or starts one with it.
- Status bar: a **Platinum · Unlimited credits** plan badge with the logo. The duplicate
  "Layout editable" label is gone.
- Pane header actions (configure, duplicate, maximize, close) appear on hover, focus or keyboard
  focus.

### Orchestrate mode

One Claude pane becomes the **Orchestrator**. It splits your request into a plan, waits for you
to approve it, and runs each task as its own Claude Code session in a worker pane. Each session
gets its own git worktree and branch. See the Orchestrate section of the README for the whole
flow.

- **Orchestrate** toolbar toggle with a **Max workers** setting (1 to 5). The toggle shows an
  ON/OFF badge and a pulsing live indicator. While a run is active the toolbar is highlighted and
  the status bar says **Orchestrating**.
- The Orchestrator is Fable. Plans can give simple tasks to Haiku and the hardest to Opus. If
  Fable is unavailable, the run falls back to Opus.
- Unattended runs: a preflight check, a separate allow-list and folder list for each task, and
  the bundled playbook, which is refreshed at the start of every run.
- `alphacode` command line inside the orchestrator pane: `plan`, `task start|status|wait|retry`,
  `ask` (consult a Local Model advisor pane) and `finish`. Workers report their own status with
  `alphacode report`.
- Each worker commits a work record to `docs/orchestrate/<id>.md` before it reports done.
- Workers start from the orchestrator's root folder, so their worktree branches come from the
  intended repository.
- **Tasks** sidebar, pane badges, and an **Orchestration** / **Side** tab split between the run's
  panes and everything else.
- Each run pane shows its task title, a role and model chip, a tint for its state, and a token
  count.
- During a run, worker panes are locked, and the app asks before you close a pane or the window.
  The project folder is reserved for the run.
- When the run finishes, it shows a toast and writes a run note to the vault.
- Turning Orchestrate on always asks you to confirm.

### Memory vault and Vault pane

- Scans Claude memory folders into an Obsidian vault of junctions and hub notes, and registers
  that vault with Obsidian.
- Claude memory sidebar section with actions to open in Obsidian and open the folder.
- **Vault** pane: answers questions from your memory notes, launches projects, and shows a
  force-directed graph with thinking and highlight states.
- Projects whose transcripts were pruned are matched back to their folders by slug.

### Layout and UI

- Pane sizes are fixed, the sidebar can be resized, and the menu bar is hidden.
- New and duplicated panes take the first free half-width slot instead of stacking in column 0.

### Fixes

- Saving an orchestrate task keeps its allow-list and folders instead of rejecting the save.
- Concurrent task starts can no longer both pass the launch guard.
- `start`, `retry` and `plan` validate their input before changing anything. A late start failure
  stops the run.
- Windows: environment overrides for a launch merge keys case-insensitively, so `PATH` wins.
- Development: `ELECTRON_RUN_AS_NODE` is removed from the Electron environment, not just blanked.
- Vault: graph fits its canvas, highlights time out, scan failures are isolated, and loose
  launch matches are gated.

## In the working tree (not yet committed)

- **Fresh reviewers.** `alphacode task review <id> criteria.md [--model m]` starts a read-only
  Claude session in the task's worktree with none of the worker's context. It returns a verdict
  with `alphacode verdict pass|fail`. The playbook now forbids merging without a `pass`.
- **Max workers** is now the exact number of worker panes: extra Claude panes close (you confirm
  first) and missing ones are added. Worker panes show **Waiting for a task** or
  **Next: <task>** until the run starts work in them.
- Conductor layout: the orchestrator gets a full-height column and the other run panes tile
  beside it.
- Run header that says in one line what needs you, and run lanes that show a timeline of each
  agent's tasks.
- Right-click a pane in the sidebar to **Configure…** or **Delete pane**. A new confirm dialog
  asks before you delete a running session.
- The focused pane gets a white ring and a bold title.
