# Vault pane

Date: 2026-10-09. Status: approved in conversation, awaiting written review.
Depends on: `2026-10-09-claude-memory-vault-design.md` (the vault must exist and be scanned).

## Purpose

Let the user talk to the Claude memory vault from inside AlphaCode: ask a question and get an
answer grounded in the notes, or give a launch command and have AlphaCode open the right
project. A live graph of the vault sits in the pane and animates while the model works, so
the vault reads as a brain rather than a folder.

Success: typing "what did I decide about fonts for NaviStation?" returns the answer with the
notes it came from highlighted in the graph, and typing "launch Peptide Sciences 101" opens a
Claude pane in `D:\Dev\PeptideSciences101` and that project's Obsidian vault.

## Decisions already made

- Thinking is done by a saved local model profile (Ollama or LM Studio). No cloud model, no
  Claude Code pane behind it.
- Retrieval is a keyword lookup over the scanned vault, no embeddings, no vector store, no new
  dependency.
- Launch commands are resolved by AlphaCode deterministically, never by the model.
- The brain animation is a force-directed graph of the vault drawn on a canvas inside the
  pane, with no library.
- Out of scope: editing notes from the pane, commands other than launch, cloud models,
  streaming answers.

## Pane

New `PaneType` value `vault`. Like `local-model` it spawns no process, carries a `profileId`,
and can never auto-start anything. It appears in the Add pane menu as **Vault** and in the
help pane-type table. Its header icon is a brain.

Layout, top to bottom:

1. **Profile strip**, identical to the Local Model pane's: pick a profile, Configure.
2. **Graph canvas**, fixed height of 40% of the pane, see below.
3. **Transcript**: user messages, assistant answers, and command results. An answer ends
   with a line of the note names used, each rendered as a chip; clicking a chip pulses that
   node in the graph.
4. **Composer**, identical to the Local Model pane's: Enter sends, Shift+Enter newlines, the
   send button becomes Stop while busy. Footer has Clear.

Transcript is in memory only, like the Local Model pane.

## Graph canvas

Renderer-side component `VaultGraph` fed by `bridge.vaultGraph()`:

`VaultGraph = { nodes: { id: string; label: string; project: string; type: string }[];
edges: { from: string; to: string }[] }`. Node id is the note basename. Edges are every
`[[wikilink]]` whose target exists as a note, plus one edge from each note to its project
hub node. Hub nodes are included with `type: 'hub'`.

Force simulation: nodes repel with an inverse-square term, edges attract as springs, a weak
pull toward center, velocity damping. Integrated with `requestAnimationFrame`, about 60
nodes per millisecond is the budget; the renderer stops integrating once total movement
falls under a threshold and resumes on any interaction or data change. Nodes are drawn as
discs colored by `type` using the existing pane accent palette, hubs larger. Labels appear on
hover and for highlighted nodes.

States:

- **Rest**: after settling, nodes drift with a slow sinusoidal offset so the graph breathes.
- **Thinking**: while a question is pending, every node pulses in brightness with a traveling
  phase so the pulse looks like it moves across the graph.
- **Answered**: nodes named in the answer glow steadily and their edges brighten for ten
  seconds, then fade back to rest.

If `prefers-reduced-motion` is set, the simulation still lays out once but there is no drift,
no pulse, and highlight is a static color change. Hidden panes (not maximized away, actually
unmounted) do not animate.

The graph refreshes when the pane mounts, after every answer, and when the window regains
focus.

## Questions

`bridge.vaultAsk(paneId, profile, question): Promise<{ answer: string; notes: string[] }>`.

Main process, in `electron/vault.ts`:

1. Validate `paneId` and `profile` with the existing validators; `question` is a string of
   1 to 4000 characters.
2. Tokenize the question: lowercase, split on non-alphanumerics, drop tokens shorter than
   three characters and a small stop-word list.
3. Score every note from the last scan: 3 points per token found in the title or `name`,
   2 per token in `description`, 1 per token in the body, body read lazily and capped at
   16 KB. Ties broken by newer `modified` frontmatter then by name.
4. Take the top 8 notes with a positive score, dropping any that would push the combined
   body size over 24,000 characters.
5. Build the messages: a system prompt stating that the assistant answers only from the
   notes provided, says so when the notes do not cover the question, and ends its reply with
   a line `Notes used: name, name` listing only notes it relied on; then one user message
   containing each note as `### <name> (project, type)` followed by its body, then the
   question. The profile's own system prompt is not used for vault questions.
6. Call `ProviderClient.chat(paneId, profile, messages)`.
7. Parse the trailing `Notes used:` line into `notes`, keeping only names that were in the
   context, and strip that line from `answer`. If the line is absent, `notes` is the full
   context list.

Zero notes with a positive score still sends the question with a note saying the vault has
nothing matching, so the model can say so in its own words.

Cancel uses the existing `cancelChat(paneId)`.

## Commands

A message matching `^\s*(launch|open|start)\s+(.+)$` (case-insensitive) is a command and
never reaches the model. The renderer calls
`bridge.vaultResolve(name): Promise<VaultTarget[]>`.

`VaultTarget = { kind: 'project' | 'obsidian' | 'workspace'; name: string; path: string }`.

Main process builds the candidate list on every call:

- `project`: every project from the last vault scan, `path` is its real working directory
  from the transcript cwd; projects whose cwd is unknown are skipped.
- `obsidian`: every vault in `%APPDATA%\obsidian\obsidian.json`, `name` is the last path
  segment, `path` is the vault path. Missing or invalid file means no candidates.
- `workspace`: every workspace name from the current state, `path` is the workspace id.

Matching key: lowercase, strip every character that is not a letter or digit. A candidate
matches when its key equals the query key, or starts with it, or contains it, in that order
of preference. Within each kind, only the best-preference tier is returned, so an exact
project match hides prefix project matches but never hides the Obsidian vault that matches
by prefix. That is what lets "Peptide Sciences 101" open both the project and its vault.

Renderer behavior on the result:

- One `project` match (plus optionally one `obsidian` match): add a Claude pane titled after
  the project with `cwd` set to the project path, start it, and if there is an `obsidian`
  match call `bridge.openObsidianVault(path)`. Transcript records what was opened.
- Only an `obsidian` match: open it, record it.
- A `workspace` match and nothing else: load that workspace through the existing confirm
  flow.
- Multiple matches of the same kind, or nothing: transcript lists the candidates, or says
  nothing matched, and asks for a more specific name. Nothing is opened.

`bridge.openObsidianVault(path)` validates that `path` is one of the vault paths read from
`obsidian.json` at that moment, then opens `obsidian://open?path=<encoded>`. Any other path
is refused.

## Bridge summary

Additions to `BridgeApi`:

- `vaultGraph(): Promise<VaultGraph>`
- `vaultAsk(paneId, profile, question): Promise<{ answer: string; notes: string[] }>`
- `vaultResolve(name: string): Promise<VaultTarget[]>` with `name` 1 to 200 characters
- `openObsidianVault(path: string): Promise<void>`

All validated in the main process; the renderer never supplies filesystem paths except the
one echoed back from `vaultResolve` and re-checked against the registry.

## Testing

`tests/vault-pane.test.ts`:

- Scorer: a note whose title matches outranks one whose body matches; stop words are
  ignored; the context respects the count and size caps.
- Answer parsing: trailing `Notes used:` is removed and filtered to context names; absent
  line falls back to the full context list.
- Matcher: "Peptide Sciences 101" against `PeptideSciences101`, `PeptideSciences101-Graph`,
  and `Peptides` returns the first two; an exact match hides prefix matches; empty registry
  yields no obsidian candidates.
- Graph builder: wikilinks to missing notes are dropped, every note has an edge to its hub.
- Command regex: "Launch X", "open  x", "start x" are commands; "how do I launch x" is not.

The canvas is covered only by rendering a Vault pane in the existing Playwright run without
console errors.

## Security notes

The model only ever receives note text from the vault and the user's own question. Launch
targets come from the vault scan, the Obsidian registry, and saved workspaces; a free-text
name can select among them but never names a path. Claude panes opened by command go through
the same validation as any pane.
