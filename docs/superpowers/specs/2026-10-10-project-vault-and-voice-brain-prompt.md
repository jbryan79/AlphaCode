# Prompt: AlphaCode project vault mirror + always-on voice brain

You are a senior Electron/TypeScript engineer working inside an existing Windows-only Electron app called **AlphaCode**, located at `D:\Dev\AlphaCode`. Read this whole brief before touching code. Deliver two features in order: (1) turn the existing "Claude memory vault" into a **project vault mirror**, then (2) add an **always-on voice launcher with an animated brain widget**. Keep the code style of the repo (dense single-line TypeScript, few files, no new runtime dependencies unless this brief allows one). Run `npm test` after every step and `npm run build` before you call anything done.

## 1. The repo as it stands

- Electron main process: `electron/main.ts`, `electron/preload.ts`, `electron/vault.ts`, `electron/providers.ts`. Renderer: React in `src/` (`App.tsx`, `VaultPane.tsx`, `VaultGraph.tsx`, `PaneEditor.tsx`, `styles.css`). Shared pure code: `shared/vault.ts`, `shared/types.ts`, `shared/domain.ts`. Tests: Vitest in `tests/` (`vault.test.ts`, `vault-pane.test.ts`, `domain.test.ts`), Playwright in `tests/e2e.spec.ts`.
- Scripts: `npm test` (vitest), `npm run build` (tsc + vite), `npm run test:e2e`.
- The sidebar has a "Claude memory" section (`src/App.tsx` around the `vault-section` element) showing project and note counts plus "Open in Obsidian" and "Show folder" buttons. A "Vault" pane type (`src/VaultPane.tsx`) shows a force-directed canvas graph (`src/VaultGraph.tsx`) of notes, answers questions about the notes through a local model profile, and accepts `launch <name>` / `open <name>` / `start <name>` commands that open a Claude pane in a project folder, open a registered Obsidian vault, or load a saved workspace.
- `electron/vault.ts` exports `class MemoryVault`. Today its `scan()` reads Claude Code's memory folders under `%USERPROFILE%\.claude\projects\<slug>\memory\`, creates directory junctions to them under `%USERPROFILE%\AlphaCode Vault\Projects\<name>\`, writes generated hub notes (`Projects\<name>.md`, `Types\<type>.md`, `Home.md`) that carry `generated: alphacode` in their frontmatter, and writes `.obsidian\app.json` and `graph.json` once if absent. It also has `register()` (adds the vault to Obsidian's `obsidian.json` without a BOM), `graph()`, `ask()`, `resolve()`, `obsidianUrl()`. `main.ts` constructs it, scans on startup and every 5 minutes, and exposes IPC handlers `bridge:vault-info`, `bridge:open-vault`, `bridge:show-vault-folder`, `bridge:vault-graph`, `bridge:vault-ask`, `bridge:vault-resolve`, `bridge:open-obsidian-vault`.
- `shared/vault.ts` holds the pure helpers: `parseFrontmatter`, `wikilinks`, `isGenerated`, `sanitizeName`, `uniqueNames`, `hubNote`, `homeNote`, `pickNotes`, `buildMessages`, `parseAnswer`, `COMMAND`, `matchTargets`, `buildGraph`, plus `NoteMeta`. Reuse them; extend rather than fork.
- Rule already in force: a scan only overwrites a note that carries the `generated: alphacode` marker. Any other file with the same name is left alone and reported in the status message. Every junction/hub/copy step is its own try/catch so one bad entry never stops the scan.
- The vault folder on disk currently contains only `.obsidian\`, empty `Projects\` and `Types\`, and a user file `Untitled.md`. The Claude memory junctions have already been removed by hand. Do not touch anything under `%USERPROFILE%\.claude`.

## 2. Feature 1: project vault mirror

Replace the memory-folder source with the user's own project folders, filtered to source code, Markdown, and build-support files. Rename the class to `ProjectVault`.

### Sources and names
- Roots are passed from `main.ts`: `['D:\\Dev', 'B:\\']`. Every immediate subfolder of a root is a project, hidden folders included, except `$RECYCLE.BIN` and `System Volume Information`. Loose files at the root (for example `D:\Dev\Gyre.zip`, an `.exe` on `B:\`) are ignored. Junctions and symlinks at any depth are never followed.
- Project display name is the folder name run through `sanitizeName`. On a collision across roots append the parent in parentheses using `uniqueNames`; for a drive root the parent label is the drive letter, so `ProvClaimsTrend_JB` (which exists on both drives) becomes `ProvClaimsTrend_JB (Dev)` and `ProvClaimsTrend_JB (B)`.

### File filter (pure, in `shared/vault.ts`, unit tested)
- Skip directories named: `node_modules .git .svn .hg target dist dist-electron build out .next .nuxt .svelte-kit .angular .turbo .parcel-cache .cache coverage bin obj .idea .vs vendor release tmp temp logs __pycache__ .pytest_cache .mypy_cache .gradle .terraform`. Additionally skip any directory that contains a `pyvenv.cfg` file, whatever its name (the user has virtualenvs named `venv-chatterbox`; this rule is what removes 96k files from `D:\Dev\xtts`).
- Keep files whose extension is in this allowlist: `.ts .tsx .js .jsx .mjs .cjs .rs .py .cs .fs .vb .sql .ps1 .psm1 .psd1 .sh .bat .cmd .html .css .scss .less .json .toml .yaml .yml .xml .md .mdx .txt .rdl .go .java .kt .swift .c .cpp .h .hpp .vue .svelte .prisma .graphql .ini .cfg .csproj .sln .props .targets .lock .editorconfig .gitignore .gitattributes .npmrc .nvmrc .dockerignore .rb .php .lua .r .ipynb .dart .ex .exs .zig`, or whose name matches `README*`, `LICENSE*`, `Dockerfile*`, `Makefile*`, `CMakeLists.txt`, `Procfile`, `justfile`, `.env.example`, `tsconfig*`, `*.config.*`. Skip files larger than 2 MB. Everything else (archives, executables, media, `.pbix`, databases) is left out.
- Measured result with this filter: about 37k files / 410 MB under `D:\Dev` and 5.4k files / 26 MB under `B:\`.

### Mirror sync (in `electron/vault.ts`)
- Mirror root is `%USERPROFILE%\AlphaCode Vault\Projects\<name>\`, keeping each file's path relative to its project folder.
- Each scan, per project: list source files passing the filter with size and mtime; list mirror files; copy files that are new or whose size or mtime differ (`copyFile` then `utimes` to preserve the source mtime); delete mirror files whose source no longer exists or no longer passes the filter; remove empty mirror folders. Delete a whole mirror folder when its project folder is gone. Never delete anything outside `Projects\`.
- Keep the existing behavior: scan on startup and every 5 minutes, scans never overlap (`running` promise), each project is its own try/catch and failures are collected into `info.message`.
- Generated notes: one hub per project at `Projects\<name>.md` with the source path, a count of kept files by extension, the README embedded (`![[Projects/<name>/README]]` when one exists), and a wikilink to every Markdown file in the project. `Home.md` lists projects grouped by root with file counts and the scan time. Remove the `Types\` hubs; do not create `Types\` any more (delete it if it exists and is empty).
- `.obsidian\app.json`: if the file is missing write `{"showUnsupportedFiles":true}`; if it exists and lacks `showUnsupportedFiles`, add that one key and keep every other key. Keep writing `graph.json` once if absent, with color groups by `path:Projects` and `file:Home`.
- `VaultInfo` becomes `{ path, projects, files, obsidian, scannedAt, message }` (rename `notes` to `files`). Update `shared/types.ts`, the sidebar text ("Project vault", "N projects · N files"), and the e2e assertion that currently expects "Claude memory" and "notes".

### Vault pane
- Questions (`ask`) are answered over Markdown files plus root manifests (`package.json`, `Cargo.toml`, `pyproject.toml`, `*.csproj`). During the scan keep the first 4 KB of each as `NoteMeta.body` for scoring; at ask time re-read up to 16 KB of the chosen notes before building the prompt. `NoteMeta.type` becomes `'doc' | 'manifest'`; `NoteMeta.project` is the project name; `name` is the path relative to the project without extension.
- Graph (`buildGraph`): nodes are project hubs plus Markdown files at each project's root only (README, CLAUDE.md, CHANGELOG and the like), edges from each note to its hub and along wikilinks. `VaultGraph.tsx` colors become `hub`, `doc`, `manifest`, `other`.
- `resolve('launch X')` matches against the mirrored projects with `path` = the real source folder, so `launch CipherTalk` opens a Claude pane in `D:\Dev\CipherTalk`. Obsidian vault and workspace matching stay as they are.
- Welcome text: "Project vault", "N files across N projects".

### Tests and docs for feature 1
- Rewrite `tests/vault.test.ts`: filter cases (skipped dir names, `pyvenv.cfg` rule, extension and name allowlist, 2 MB cap), name collision across roots, mirror sync against a temp tree (new file copied, changed file re-copied, deleted file removed, empty dir pruned, vanished project removed, non-generated hub left alone, junction inside a project not followed).
- Update `tests/vault-pane.test.ts` for the new `NoteMeta` shape and graph rules, and `tests/e2e.spec.ts` strings.
- Update `README.md` sections "Sidebar: Claude memory", "Vault pane", and "Claude memory vault" to describe the project vault. Add a line at the top of `docs/superpowers/specs/2026-10-09-claude-memory-vault-design.md` saying it is superseded by the project vault.

## 3. Feature 2: always-on voice launcher with a brain widget

### Always on
- In `main.ts`: call `app.setLoginItemSettings({ openAtLogin: true })` once per launch (skip when `!app.isPackaged` so dev runs do not register). Add a `Tray` with menu items Show AlphaCode, Mute microphone (checkbox), Quit. Closing the main window hides it (`event.preventDefault(); win.hide()`) unless the app is quitting; `window-all-closed` must not quit the app.
- Create a second `BrowserWindow` for the brain: `frameless`, `transparent`, `alwaysOnTop`, `skipTaskbar`, `resizable: false`, about 220×220, default position bottom-right of the primary display with a 24 px margin, draggable via `-webkit-app-region: drag` on its root. Remember its last position in the app state. Load the same renderer with `#brain` in the hash; `App.tsx` renders `<Brain/>` instead of the normal UI when `location.hash === '#brain'`. Left click shows and focuses the main window. Right click opens a context menu (Mute, Open AlphaCode, Quit) through IPC.

### Hearing (PowerShell sidecar, no npm dependency)
- Add `electron/voice.ps1` and `electron/voice.ts`. `voice.ts` spawns `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File voice.ps1` and passes the grammar as a JSON file path argument. The script uses `System.Speech.Recognition.SpeechRecognitionEngine` (offline, built into Windows) with `SetInputToDefaultAudioDevice()` and a `GrammarBuilder`: `Choices("open","launch","start")` followed by `Choices(<all spoken names>)`. Each spoken name carries a `SemanticResultValue` naming the target id.
- The script writes one JSON object per line to stdout: `{"event":"ready"}`, `{"event":"level","value":0-100}` (from `AudioLevelUpdated`, throttle to ~15 per second), `{"event":"speech-start"}`, `{"event":"heard","text":"open peptide sciences","target":"project:PeptideSciences101","confidence":0.93}`, `{"event":"rejected"}`, `{"event":"speech-end"}`, `{"event":"error","message":"..."}`. Ignore results with confidence below 0.6. `voice.ts` parses lines, forwards them to both renderer windows over IPC (`bridge:voice-event`), and restarts the sidecar with backoff if it exits.
- Spoken forms: a pure tested helper `spokenForms(name): string[]` in `shared/voice.ts`. Split camelCase and digits, replace `_ - .` with spaces, collapse spaces, lower-case. Emit the full form, the form without trailing digits, the form without a `_JB` suffix, and the form without a domain TLD. Examples: `PeptideSciences101` → `peptide sciences 101`, `peptide sciences`; `JABSystems.io` → `jab systems io`, `jab systems`; `CRS_MemberContactLookup` → `crs member contact lookup`; `ProvClaimsTrend_JB` → `prov claims trend jb`, `prov claims trend`. Deduplicate across all targets; when two targets share a spoken form, the project wins over an app.
- Grammar sources: every mirrored project (`project:<name>`), every installed Start-menu app from `Get-StartApps` (`app:<AppID>`, spoken form = app name), and the sites below. Rebuild and restart the sidecar whenever a scan changes the project list. Muting stops the sidecar; unmuting starts it.

### Acting on a heard command
- `project:<name>`: if the project has a site, `shell.openExternal(url)` first. Then show and focus the main window and send `bridge:voice-launch` with a `VaultTarget { kind:'project', name, path }`; the renderer calls the existing `launchProject` so a Claude pane opens in that folder, exactly like typing `launch <name>` in the Vault pane.
- `app:<AppID>`: run `explorer.exe shell:AppsFolder\<AppID>`.
- Sites for now, hardcoded in one small map in `shared/voice.ts`: `PeptideSciences101 → https://peptidesciences101.com`, `JABSystems.io → https://jabsystems.io`. Both are also spoken names on their own ("peptide sciences", "jab systems").
- No match or rejected: the brain shows the heard text for 3 seconds and nothing launches.

### The brain (`src/Brain.tsx`, canvas, reuse the physics from `VaultGraph.tsx`)
- Draw two hemispheres of about sixty nodes laid out inside a brain-shaped outline (two overlapping ellipses with a central fissure), linked to their nearest neighbors, running the same spring/repel simulation. Nodes are the projects from `bridge:vault-graph`; when there are fewer than sixty, pad with unlabeled filler nodes.
- States driven by `bridge:voice-event`:
  - idle: slow breathing glow (4 s period) and a gentle drift;
  - listening (between `speech-start` and `speech-end`): the `level` value scales the whole brain between 1.0 and 1.25 and drives link ripples and node glow, so it visibly swells and flickers with the user's voice;
  - heard: a ring bursts outward from the center, the matching project's node flares and glides to the center for 1.5 s then returns, and the heard phrase fades in beneath the brain for 3 s;
  - acting: a pulse travels along the links hemisphere to hemisphere;
  - rejected or no match: a brief red-tinted shiver and the heard text;
  - muted: grey, still, with a small slashed-mic glyph;
  - error (sidecar dead): amber outline.
- Respect `prefers-reduced-motion`: no breathing, no ripples, states shown by color and label only. Keep the frame loop paused when idle for more than 10 seconds and resume on any event.

### Tests and docs for feature 2
- Unit tests: `spokenForms` examples above; grammar assembly dedup and project-over-app priority; sidecar line parser (valid events, malformed line ignored, confidence threshold); heard-target to action mapping (site + project, app, none).
- The sidecar is verified by hand: run `powershell -File electron/voice.ps1 <grammar.json>` and say "open peptide sciences"; expect a `heard` line with `target: "project:PeptideSciences101"`.
- README: a new "Voice brain" section covering start-with-Windows, the tray, muting, what can be said, the two sites, and the brain's states.

## 4. Acceptance checklist

1. `npm test` and `npm run build` pass. `npm run test:e2e` passes with the updated strings.
2. After launch, `%USERPROFILE%\AlphaCode Vault\Projects\` contains one folder per project on `D:\Dev` and `B:\` holding only files that pass the filter, plus one generated hub per project and `Home.md`. No `node_modules`, `.git`, venv, or binary content appears anywhere in the vault. Opening the vault in Obsidian shows code files in the explorer and search.
3. A second scan a few minutes later copies nothing unless a source file changed, and removes mirror copies of deleted source files.
4. Typing `launch CipherTalk` in a Vault pane opens a Claude pane in `D:\Dev\CipherTalk`.
5. Closing the main window leaves the tray icon and the brain on screen. Saying "open peptide sciences" opens `https://peptidesciences101.com` in the default browser, brings AlphaCode forward, and opens a Claude pane in `D:\Dev\PeptideSciences101`, while the brain swells during speech, bursts on recognition, and shows the phrase. Saying "open notepad" launches Notepad. Mute from the tray greys the brain and stops recognition.
6. Nothing under `%USERPROFILE%\.claude` is read, written, or linked.
