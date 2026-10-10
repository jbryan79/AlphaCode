# Claude memory vault

Date: 2026-10-09. Status: approved in conversation, awaiting written review.

## Purpose

Claude Code already keeps a per-project memory: small Markdown notes with frontmatter and
`[[wikilinks]]` under `%USERPROFILE%\.claude\projects\<slug>\memory\`. Nobody sees them unless
they open hidden folders by hand. AlphaCode gathers every one of those folders into a single
Obsidian vault so the user can browse, search, and graph everything Claude remembers across all
projects, with no action beyond installing Obsidian. The files never move and nothing is copied.

Success: a user installs Obsidian, presses one button in AlphaCode, and sees a vault that keeps
growing on its own as they work with Claude in AlphaCode panes.

## Decisions already made

- Source is Claude Code's own memory folders only. No transcript capture, no local model
  summaries, no workspace metadata notes.
- Organization is built in: generated hub notes plus Obsidian's native graph view. No graphify,
  no Python, no new npm dependency.
- The vault holds directory junctions to the real memory folders, so it is live and two-way.
  Edits made in Obsidian are what Claude reads next session.
- Ships inside AlphaCode for every user and is optional by nature. **AlphaCode runs identically
  with or without Obsidian.** Without it the vault folder still exists and is kept current, and
  the sidebar offers the free download link. Obsidian needs no account. No settings toggle.
- Out of scope: an Obsidian plugin, an opt-in pointer from the global Claude instructions to
  the vault, Linux, graphify, digests by local model.

## Vault layout

Root: `%USERPROFILE%\AlphaCode Vault\`, created on first launch.

```
AlphaCode Vault\
  Home.md                      generated: links to every project hub and every type hub
  Projects\
    AlphaCode.md               generated hub: every note in this project, with descriptions
    AlphaCode\                 junction -> %USERPROFILE%\.claude\projects\D--Dev-AlphaCode\memory
    NaviStation_JB.md
    NaviStation_JB\            junction
  Types\
    user.md                    generated hub: every note whose frontmatter type is user
    feedback.md
    project.md
    reference.md
  .obsidian\
    app.json                   written once if absent; never overwritten
    graph.json                 written once if absent; colors nodes by folder
```

A file `Projects\AlphaCode.md` and a folder `Projects\AlphaCode\` coexist on Windows and in
Obsidian.

### Project names

A memory folder's project name is the last path segment of the `cwd` recorded in the newest
transcript (`*.jsonl`) in the same project folder, read from the first 64 KB only. If no
transcript names a cwd, the folder slug is used. If two projects resolve to the same name, the
parent folder name is appended in parentheses, for example `AlphaCode (Dev)`, and if still equal
the slug is used. Names are sanitized to Windows file-name rules.

### Generated notes

Every generated note starts with frontmatter containing `generated: alphacode`. A scan
overwrites a note only if the existing file carries that marker; any other file with the same
name is left untouched and the scan reports it in its status message.

Hub body: a title line, then one bullet per member note as `[[name]] - description`, where
`name` is the file basename and `description` is the frontmatter `description`, blank if
missing. `MEMORY.md` is Claude's own index and is listed on the project hub but not counted as
a memory. Home lists project hubs with note counts, then type hubs with note counts, then a
one-line footer naming the Claude projects directory and the time of the last scan.

Notes with no recognized `type` go under a fifth hub `Types\other.md`, written only if any
exist.

## Scan

Module: `electron/vault.ts`, class `MemoryVault` with `scan(): Promise<VaultInfo>`.

Runs once after the window is created and then every five minutes on a timer, in the main
process. Each run:

1. Lists `<claudeDir>\projects\*\memory` where `claudeDir` is `%USERPROFILE%\.claude`, or
   `CLAUDE_CONFIG_DIR` when that variable is set, matching Claude Code's own rule.
2. For each memory folder ensures `Projects\<name>` is a junction to it. Creates missing ones
   with `fs.symlink(target, path, 'junction')`. Removes any entry under `Projects\` that is a
   junction whose target no longer exists. Never removes a real folder or a file.
3. Reads frontmatter (`name`, `description`, `type`) of every `*.md` in every memory folder,
   skipping `MEMORY.md`, reading at most the first 8 KB of each file.
4. Rewrites Home, project hubs, and type hubs, deleting generated hubs for projects that no
   longer exist.
5. Writes `.obsidian\app.json` and `graph.json` only when absent.

The scan never throws out of `scan()`. Any error is caught, the vault info carries it as
`message`, and the next timer tick retries. A missing Claude projects directory is not an
error: the vault gets a Home note saying no memories exist yet.

`VaultInfo`: `{ path: string; projects: number; notes: number; obsidian: boolean;
scannedAt: string; message: string }`. `obsidian` is true when
`%LOCALAPPDATA%\Programs\Obsidian\Obsidian.exe` exists.

## Bridge and UI

Additions to `BridgeApi` in `shared/types.ts`, wired through `preload.ts` and `registerIpc()`
in `main.ts` like every other call:

- `vaultInfo(): Promise<VaultInfo>` returns the result of the latest scan, running one first if
  none has completed.
- `openVault(): Promise<void>` opens `obsidian://open?path=<vault>` through
  `shell.openExternal` when Obsidian is installed; otherwise opens
  `https://obsidian.md/download`.
- `showVaultFolder(): Promise<void>` opens the vault folder in Explorer via `shell.openPath`.

None of the three takes arguments from the renderer, so the main process computes every path
itself and the only check is the existing trusted-caller check applied to every channel.

Sidebar: a section titled **Claude memory** directly under **Local model profiles**, using the
existing `section-heading` pattern. Contents, top to bottom: a line `N projects · M notes`,
the vault path in the same muted style as the state path, and the button. Button label is
**Open in Obsidian** when `obsidian` is true, **Get Obsidian** otherwise, with a small
**Show folder** text link beside it in both cases. When `message` is non-empty it shows under
the button in the same style as a pane status message. The renderer asks for `vaultInfo()` on
mount and again whenever the window regains focus, so counts stay current after a session.

## Documentation

README gains a short **Claude memory vault** subsection under *Where your data lives*: what
the vault is, that the files stay in Claude's folders, that edits in Obsidian are what Claude
reads next, that Obsidian is free, optional, and needs no account, and the vault path. The
Help contents list and the sidebar part of the help gain one line each.

## Testing

Unit tests in `tests/vault.test.ts` run the scan against temporary directories:

- Two fake projects with transcripts and memory notes produce two junctions, two project hubs,
  the type hubs, and a Home with correct counts.
- A project whose transcript is missing uses its slug as name.
- Two projects resolving to the same name get disambiguated.
- A user-written `Projects\AlphaCode.md` without the marker survives a scan and is reported.
- Removing a memory folder removes its junction and hub on the next scan.
- A missing projects directory yields the empty Home and no error.

No end-to-end test: opening Obsidian is an external process, and the sidebar section is covered
by the existing Playwright run only to the extent that it renders without error.

## Security notes

The vault lives entirely under the user profile. The renderer cannot pass paths. Junction
targets are always inside the Claude config directory. The only external launches are
Obsidian's registered URL scheme, the Obsidian download page, and Explorer on the vault folder.
