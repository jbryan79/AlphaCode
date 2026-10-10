# Vault Pane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new `vault` pane type that answers questions from the Claude memory vault through a local model, resolves "launch X" commands into Claude panes and Obsidian vaults, and shows a live force-directed graph of the vault that animates while it works.

**Architecture:** Pure helpers (tokenizing, scoring, prompt building, answer parsing, command matching, graph building) are appended to `shared/vault.ts` so the renderer and main process share them and tests need no filesystem. `MemoryVault` gains `graph()`, `ask()`, `resolve()`, and `obsidianUrl()`. The renderer gets `VaultPane.tsx` (transcript and composer, modeled on `LocalPane.tsx`) and `VaultGraph.tsx` (canvas simulation), and `App.tsx` treats `vault` like `local-model` wherever it branches on pane type.

**Tech Stack:** TypeScript, Electron 44, React 19, Canvas 2D, Vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-09-vault-pane-design.md`
**Depends on:** `docs/superpowers/plans/2026-10-09-claude-memory-vault.md` fully executed (it creates `shared/vault.ts`, `electron/vault.ts`, the `vault` instance in `main.ts`, and the `VaultGraph`/`VaultTarget` types if the type-check in its Task 1 needed them).

## Global Constraints

- The model is always a saved local profile (Ollama or LM Studio); the profile's own system prompt is not used for vault questions.
- Retrieval is keyword scoring: title or name 3 points per token, description 2, body 1; top 8 notes with a positive score; combined body size at most 24,000 characters.
- A message matching `^\s*(launch|open|start)\s+(.+?)\s*$` (case-insensitive) is a command and never reaches the model.
- Matching key is lowercase with every non-letter, non-digit removed; per kind, only the best tier (exact, then prefix, then contains) is returned.
- `openObsidianVault(path)` refuses any path that is not in `%APPDATA%\obsidian\obsidian.json` at that moment.
- The graph honors `prefers-reduced-motion` (layout once, no drift, no pulse) and stops drawing when settled with nothing to show.
- Code style and commit trailer as in the vault plan.

## Review Focus

1. A question made only of stop words or two-letter tokens must still reach the model with the "no notes match" context, not throw. Pinned in Task 1.
2. The model's `Notes used:` line may list names with `[[ ]]`, different case, or names not in the context; only context names survive. Pinned in Task 1.
3. A launch name matching a project exactly and an Obsidian vault only by prefix must return both (per-kind tiers). Pinned in Task 1.
4. A wikilink to a note name that exists in two projects must prefer the same project. Pinned in Task 1.
5. A graph with zero notes (fresh machine) must render the empty welcome and not crash the canvas loop. Pinned in Task 4 (e2e) and guarded in code.

---

### Task 1: Question, command, and graph helpers

**Files:**
- Modify: `shared/vault.ts` (append)
- Modify: `shared/types.ts` (ensure `VaultGraph`, `VaultTarget`)
- Create: `tests/vault-pane.test.ts`

**Interfaces:**
- Produces: `tokens(q)`, `scoreNote(note, toks)`, `pickNotes(notes, question, max?, budget?)`, `SYSTEM`, `buildMessages(context, question)`, `parseAnswer(text, contextNames)`, `COMMAND`, `nameKey(s)`, `matchTargets(query, candidates)`, `buildGraph(notes)`; types `VaultGraph`, `VaultTarget`.

- [ ] **Step 1: Ensure the types exist**

In `shared/types.ts`, if not already present from the vault plan, add after `VaultInfo`:

```ts
export interface VaultGraph { nodes: { id: string; label: string; project: string; type: string }[]; edges: { from: string; to: string }[]; }
export interface VaultTarget { kind: 'project' | 'obsidian' | 'workspace'; name: string; path: string; }
```

- [ ] **Step 2: Write the failing tests**

Create `tests/vault-pane.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildGraph, buildMessages, COMMAND, matchTargets, nameKey, parseAnswer, pickNotes, scoreNote, tokens, type NoteMeta } from '../shared/vault';
import type { VaultTarget } from '../shared/types';

const note = (over: Partial<NoteMeta>): NoteMeta => ({ name: 'n', description: '', type: 'other', modified: '', project: 'P', file: '', links: [], body: '', ...over });

describe('vault questions', () => {
  it('tokenizes with stop words and short tokens removed', () => {
    expect(tokens('What did I decide about the NaviStation fonts?')).toEqual(['decide', 'navistation', 'fonts']);
    expect(tokens('is it ok')).toEqual([]);
  });
  it('ranks title over description over body and respects caps', () => {
    const a = note({ name: 'fonts-navistation', body: 'x' }), b = note({ name: 'b', description: 'fonts for the site', body: 'x' }), c = note({ name: 'c', body: 'fonts fonts fonts' }), d = note({ name: 'd', body: 'unrelated' });
    const toks = tokens('fonts');
    expect(scoreNote(a, toks)).toBe(3); expect(scoreNote(b, toks)).toBe(2); expect(scoreNote(c, toks)).toBe(1); expect(scoreNote(d, toks)).toBe(0);
    expect(pickNotes([d, c, b, a], 'fonts').map(n => n.name)).toEqual(['fonts-navistation', 'b', 'c']);
    const many = Array.from({ length: 12 }, (_, i) => note({ name: `fonts-${i}`, body: 'x'.repeat(5000) }));
    expect(pickNotes(many, 'fonts').length).toBe(4);
    expect(pickNotes(many, 'fonts', 8, 1_000_000).length).toBe(8);
  });
  it('builds a system prompt plus one user message with notes and the question', () => {
    const m = buildMessages([note({ name: 'a', project: 'P', type: 'feedback', body: 'body a' })], 'why?');
    expect(m[0].role).toBe('system'); expect(m[0].content).toContain('Notes used:');
    expect(m[1].content).toContain('### a (P, feedback)\nbody a'); expect(m[1].content.endsWith('Question: why?')).toBe(true);
    expect(buildMessages([], 'why?')[1].content).toContain('No notes in the vault match');
  });
  it('parses the trailing Notes used line and filters to context names', () => {
    expect(parseAnswer('Use Segoe UI.\n\nNotes used: [[Fonts-A]], ghost, b', ['fonts-a', 'b', 'c'])).toEqual({ answer: 'Use Segoe UI.', notes: ['fonts-a', 'b'] });
    expect(parseAnswer('No idea.\nNotes used: none', ['a'])).toEqual({ answer: 'No idea.', notes: [] });
    expect(parseAnswer('Plain answer', ['a', 'b'])).toEqual({ answer: 'Plain answer', notes: ['a', 'b'] });
  });
});

describe('vault commands', () => {
  const c = (kind: VaultTarget['kind'], name: string): VaultTarget => ({ kind, name, path: `path:${name}` });
  it('recognizes launch, open, start commands only at the start', () => {
    expect(COMMAND.exec('Launch Peptide Sciences 101')![2]).toBe('Peptide Sciences 101');
    expect(COMMAND.exec('  open  x ')![2]).toBe('x');
    expect(COMMAND.exec('start x')).not.toBeNull();
    expect(COMMAND.exec('how do I launch x')).toBeNull();
    expect(COMMAND.exec('launch')).toBeNull();
  });
  it('matches per kind with exact beating prefix beating contains', () => {
    const all = [c('project', 'PeptideSciences101'), c('project', 'Peptides'), c('obsidian', 'PeptideSciences101-Graph'), c('obsidian', 'Brain'), c('workspace', 'Development')];
    expect(nameKey('Peptide Sciences 101!')).toBe('peptidesciences101');
    expect(matchTargets('Peptide Sciences 101', all).map(t => t.name)).toEqual(['PeptideSciences101', 'PeptideSciences101-Graph']);
    expect(matchTargets('pept', all).map(t => t.name)).toEqual(['PeptideSciences101', 'Peptides', 'PeptideSciences101-Graph']);
    expect(matchTargets('sciences', all).map(t => t.name)).toEqual(['PeptideSciences101', 'PeptideSciences101-Graph']);
    expect(matchTargets('dev', all).map(t => t.name)).toEqual(['Development']);
    expect(matchTargets('???', all)).toEqual([]);
    expect(matchTargets('nothing', [])).toEqual([]);
  });
});

describe('vault graph', () => {
  it('links notes to hubs and resolves wikilinks within the same project first', () => {
    const g = buildGraph([
      note({ name: 'a', project: 'P', links: ['b', 'missing'] }), note({ name: 'b', project: 'P' }),
      note({ name: 'b', project: 'Q' }), note({ name: 'c', project: 'Q', links: ['b', 'a'] }),
    ]);
    expect(g.nodes.filter(n => n.type === 'hub').map(n => n.id)).toEqual(['hub:P', 'hub:Q']);
    expect(g.edges).toContainEqual({ from: 'P/a', to: 'hub:P' });
    expect(g.edges).toContainEqual({ from: 'P/a', to: 'P/b' });
    expect(g.edges).toContainEqual({ from: 'Q/c', to: 'Q/b' });
    expect(g.edges).toContainEqual({ from: 'Q/c', to: 'P/a' });
    expect(g.edges.some(e => e.to.endsWith('/missing'))).toBe(false);
    expect(buildGraph([])).toEqual({ nodes: [], edges: [] });
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/vault-pane.test.ts`
Expected: FAIL, `tokens` and friends are not exported.

- [ ] **Step 4: Append the helpers to `shared/vault.ts`**

```ts

const STOP = new Set('the and for that this with what how did does about from have are was were you your can not but all any when where which who why will into out its our they them then than also just more some should would could there their been has had one two use used using tell show give know want need'.split(' '));
export const tokens = (q: string): string[] => [...new Set(q.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 3 && !STOP.has(t)))];
export const scoreNote = (n: NoteMeta, toks: string[]): number => { const name = n.name.toLowerCase(), desc = n.description.toLowerCase(), body = n.body.toLowerCase(); return toks.reduce((s, t) => s + (name.includes(t) ? 3 : 0) + (desc.includes(t) ? 2 : 0) + (body.includes(t) ? 1 : 0), 0); };
/** Top `max` positively scored notes whose bodies fit in `budget` characters; newer and alphabetically earlier notes break ties. */
export function pickNotes(notes: NoteMeta[], question: string, max = 8, budget = 24000): NoteMeta[] {
  const toks = tokens(question);
  const scored = notes.map(n => ({ n, s: scoreNote(n, toks) })).filter(x => x.s > 0).sort((a, b) => b.s - a.s || b.n.modified.localeCompare(a.n.modified) || a.n.name.localeCompare(b.n.name));
  const out: NoteMeta[] = []; let size = 0;
  for (const { n } of scored) { if (out.length >= max) break; if (size + n.body.length > budget) continue; out.push(n); size += n.body.length; }
  return out;
}
export const SYSTEM = 'You answer questions about the user\'s own notes. Use only the notes provided. If they do not cover the question, say so plainly. End your reply with one line "Notes used: name, name" naming only the notes you relied on, or "Notes used: none".';
export function buildMessages(context: NoteMeta[], question: string): ChatMessage[] {
  const notes = context.length ? context.map(n => `### ${n.name} (${n.project}, ${n.type})\n${n.body.trim()}`).join('\n\n') : '(No notes in the vault match this question.)';
  return [{ role: 'system', content: SYSTEM }, { role: 'user', content: `${notes}\n\n---\nQuestion: ${question}` }];
}
export function parseAnswer(text: string, contextNames: string[]): { answer: string; notes: string[] } {
  const m = /\n?\s*notes used:\s*(.*)\s*$/i.exec(text);
  if (!m) return { answer: text.trim(), notes: contextNames };
  const named = m[1].split(/[,;]/).map(s => s.trim().replace(/^\[\[|\]\]$/g, '').toLowerCase()).filter(Boolean);
  return { answer: text.slice(0, m.index).trim(), notes: contextNames.filter(c => named.includes(c.toLowerCase())) };
}
export const COMMAND = /^\s*(launch|open|start)\s+(.+?)\s*$/i;
export const nameKey = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');
/** Per kind, only the best tier survives: exact beats prefix beats contains. */
export function matchTargets(query: string, candidates: VaultTarget[]): VaultTarget[] {
  const q = nameKey(query); if (!q) return [];
  const tier = (c: VaultTarget) => { const k = nameKey(c.name); return k === q ? 0 : k.startsWith(q) ? 1 : k.includes(q) ? 2 : 3; };
  const out: VaultTarget[] = [];
  for (const kind of ['project', 'obsidian', 'workspace'] as const) { const mine = candidates.filter(c => c.kind === kind).map(c => ({ c, t: tier(c) })).filter(x => x.t < 3), best = Math.min(...mine.map(x => x.t)); out.push(...mine.filter(x => x.t === best).map(x => x.c)); }
  return out;
}
export function buildGraph(notes: NoteMeta[]): VaultGraph {
  const hubs = [...new Set(notes.map(n => n.project))].map(p => ({ id: `hub:${p}`, label: p, project: p, type: 'hub' }));
  const nodes = [...hubs, ...notes.map(n => ({ id: `${n.project}/${n.name}`, label: n.name, project: n.project, type: n.type }))];
  const byName = new Map<string, string[]>(); for (const n of notes) byName.set(n.name, [...(byName.get(n.name) || []), `${n.project}/${n.name}`]);
  const edges: { from: string; to: string }[] = [];
  for (const n of notes) { const id = `${n.project}/${n.name}`; edges.push({ from: id, to: `hub:${n.project}` }); for (const l of n.links) { const t = byName.get(l) || [], to = t.find(x => x.startsWith(`${n.project}/`)) || t[0]; if (to && to !== id) edges.push({ from: id, to }); } }
  return { nodes, edges };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/vault-pane.test.ts tests/vault.test.ts`
Expected: PASS. For the "respects caps" case: twelve 5,000-character bodies fit four under the 24,000 budget; with a huge budget the count cap of 8 applies.

- [ ] **Step 6: Commit**

```bash
git add shared/vault.ts shared/types.ts tests/vault-pane.test.ts
git commit -m "feat(vault): question scoring, command matching and graph helpers

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: `MemoryVault.ask`, `resolve`, `graph`, `obsidianUrl` and the bridge

**Files:**
- Modify: `electron/vault.ts`
- Modify: `shared/types.ts` (`BridgeApi`)
- Modify: `electron/preload.ts`
- Modify: `electron/main.ts`
- Modify: `tests/vault-pane.test.ts` (append)

**Interfaces:**
- Consumes: Task 1 helpers; `MemoryVault` protected fields `notes`, `projects`, `last`, `obsidianRegistry`, `providers`, and `samePath` from the vault plan.
- Produces: `MemoryVault.graph(): VaultGraph`, `ask(paneId, profile, question): Promise<{answer; notes}>`, `resolve(name, workspaces): Promise<VaultTarget[]>`, `obsidianUrl(path): Promise<string>`; bridge `vaultGraph()`, `vaultAsk(paneId, profile, question)`, `vaultResolve(name, workspaces)`, `openObsidianVault(path)`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/vault-pane.test.ts`:

```ts
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryVault } from '../electron/vault';
import type { ChatMessage, LocalProfile } from '../shared/types';

const profile: LocalProfile = { id: 'local', name: 'Local', provider: 'ollama', endpoint: 'http://127.0.0.1:11434', model: 'test', systemPrompt: 'IGNORED', contextSize: 4096, temperature: 0.4 };
async function vaultFixture(reply: string) {
  const root = await mkdtemp(join(tmpdir(), 'alphacode-vp-'));
  const dir = join(root, 'claude', 'projects', 'D--Dev-PeptideSciences101'); await mkdir(join(dir, 'memory'), { recursive: true });
  await writeFile(join(dir, 'a.jsonl'), JSON.stringify({ cwd: 'D:\\Dev\\PeptideSciences101' }) + '\n');
  await writeFile(join(dir, 'memory', 'fonts.md'), '---\nname: fonts\ndescription: Segoe UI everywhere\nmetadata:\n  type: feedback\n---\nUse Segoe UI, headings Semibold.\n');
  await writeFile(join(dir, 'memory', 'stack.md'), '---\nname: stack\ndescription: Razor Pages\nmetadata:\n  type: project\n---\nNo React.\n');
  await writeFile(join(root, 'obsidian.json'), JSON.stringify({ vaults: { a: { path: 'E:\\Brain\\PeptideSciences101-Graph' }, b: { path: 'E:\\Brain\\Brain' } } }));
  const calls: { paneId: string; profile: LocalProfile; messages: ChatMessage[] }[] = [];
  const providers = { chat: async (paneId: string, p: LocalProfile, messages: ChatMessage[]) => { calls.push({ paneId, profile: p, messages }); return reply; } } as any;
  const vault = new MemoryVault(join(root, 'vault'), join(root, 'claude'), 'x', join(root, 'obsidian.json'), providers);
  return { root, vault, calls };
}

describe('MemoryVault questions and commands', () => {
  it('asks the model with matching notes only and without the profile system prompt', async () => {
    const f = await vaultFixture('Segoe UI, Semibold headings.\nNotes used: fonts');
    const r = await f.vault.ask('p1', profile, 'which fonts?');
    expect(r).toEqual({ answer: 'Segoe UI, Semibold headings.', notes: ['fonts'] });
    expect(f.calls[0].profile.systemPrompt).toBe(''); expect(f.calls[0].messages[0].role).toBe('system');
    expect(f.calls[0].messages[1].content).toContain('### fonts'); expect(f.calls[0].messages[1].content).not.toContain('### stack');
    const empty = await f.vault.ask('p1', profile, 'is it ok');
    expect(f.calls[1].messages[1].content).toContain('No notes in the vault match'); expect(empty.notes).toEqual([]);
    await expect(f.vault.ask('bad id!', profile, 'x')).rejects.toThrow();
    await expect(f.vault.ask('p1', profile, '   ')).rejects.toThrow();
    await rm(f.root, { recursive: true, force: true });
  });
  it('resolves launch targets across projects, Obsidian vaults and workspaces', async () => {
    const f = await vaultFixture('');
    const t = await f.vault.resolve('Peptide Sciences 101', [{ id: 'w1', name: 'Peptide Day' }]);
    expect(t).toEqual([{ kind: 'project', name: 'PeptideSciences101', path: 'D:\\Dev\\PeptideSciences101' }, { kind: 'obsidian', name: 'PeptideSciences101-Graph', path: 'E:\\Brain\\PeptideSciences101-Graph' }]);
    expect(await f.vault.resolve('peptide day', [{ id: 'w1', name: 'Peptide Day' }])).toEqual([{ kind: 'workspace', name: 'Peptide Day', path: 'w1' }]);
    await expect(f.vault.resolve('x', [{ id: 'bad id', name: 'n' }])).rejects.toThrow();
    expect(f.vault.graph().nodes.map(n => n.id)).toEqual(['hub:PeptideSciences101', 'PeptideSciences101/fonts', 'PeptideSciences101/stack']);
    await rm(f.root, { recursive: true, force: true });
  });
  it('only opens registered Obsidian vaults', async () => {
    const f = await vaultFixture('');
    expect(await f.vault.obsidianUrl('e:\\brain\\brain\\')).toBe('obsidian://open?path=e%3A%5Cbrain%5Cbrain%5C');
    await expect(f.vault.obsidianUrl('C:\\Windows')).rejects.toThrow(/registered/);
    await rm(f.root, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/vault-pane.test.ts`
Expected: FAIL, `ask` is not a function.

- [ ] **Step 3: Extend `electron/vault.ts`**

Change the imports at the top:

```ts
import type { LocalProfile, VaultGraph, VaultInfo, VaultTarget } from '../shared/types';
import { validateId, validateProfile, string as str } from '../shared/domain';
import { buildGraph, buildMessages, cwdFromTranscript, homeNote, hubNote, isGenerated, matchTargets, parseAnswer, parseFrontmatter, pickNotes, TYPES, uniqueNames, wikilinks, type NoteMeta } from '../shared/vault';
```

Add these methods inside `MemoryVault`, after `syncJunctions`:

```ts
  graph(): VaultGraph { return buildGraph(this.notes); }
  async ask(paneId: string, profile: LocalProfile, question: string): Promise<{ answer: string; notes: string[] }> {
    validateId(paneId); const p = validateProfile(profile), q = str(question, 'question', 4000); if (!q.trim()) throw new Error('Ask something first.');
    if (!this.last) await this.scan();
    const context = pickNotes(this.notes, q);
    const text = await this.providers.chat(paneId, { ...p, systemPrompt: '' }, buildMessages(context, q));
    return parseAnswer(text, context.map(n => n.name));
  }
  private async obsidianVaults(): Promise<{ name: string; path: string }[]> {
    try { const reg = JSON.parse(await readFile(this.obsidianRegistry, 'utf8')); return Object.values(reg.vaults || {}).flatMap((v: any) => typeof v?.path === 'string' && v.path ? [{ name: basename(v.path), path: v.path }] : []); } catch { return []; }
  }
  async resolve(name: string, workspaces: { id: string; name: string }[]): Promise<VaultTarget[]> {
    const query = str(name, 'target name', 200); if (!Array.isArray(workspaces) || workspaces.length > 50) throw new Error('Invalid workspace list');
    if (!this.last) await this.scan();
    return matchTargets(query, [
      ...this.projects.filter(p => p.cwd).map(p => ({ kind: 'project' as const, name: p.name, path: p.cwd })),
      ...(await this.obsidianVaults()).map(v => ({ kind: 'obsidian' as const, ...v })),
      ...workspaces.map(w => ({ kind: 'workspace' as const, name: str(w.name, 'workspace name', 100), path: validateId(w.id) })),
    ]);
  }
  async obsidianUrl(path: string): Promise<string> {
    const p = str(path, 'vault path', 32768); if (!(await this.obsidianVaults()).some(v => samePath(v.path, p))) throw new Error('That folder is not a registered Obsidian vault.');
    return `obsidian://open?path=${encodeURIComponent(p)}`;
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/vault-pane.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Bridge**

`shared/types.ts`, inside `BridgeApi` after `showVaultFolder`:
```ts
  vaultGraph(): Promise<VaultGraph>;
  vaultAsk(paneId: string, profile: LocalProfile, question: string): Promise<{ answer: string; notes: string[] }>;
  vaultResolve(name: string, workspaces: { id: string; name: string }[]): Promise<VaultTarget[]>;
  openObsidianVault(path: string): Promise<void>;
```
`electron/preload.ts`, after `showVaultFolder`:
```ts
  vaultGraph:()=>ipcRenderer.invoke('bridge:vault-graph'),
  vaultAsk:(paneId,profile,question)=>ipcRenderer.invoke('bridge:vault-ask',paneId,profile,question),
  vaultResolve:(name,workspaces)=>ipcRenderer.invoke('bridge:vault-resolve',name,workspaces),
  openObsidianVault:path=>ipcRenderer.invoke('bridge:open-obsidian-vault',path),
```
`electron/main.ts`, at the end of `registerIpc()`:
```ts
  handle('bridge:vault-graph',()=>vault.graph());
  handle('bridge:vault-ask',(id,profile,question)=>vault.ask(id,profile,question));
  handle('bridge:vault-resolve',(name,workspaces)=>vault.resolve(name,workspaces));
  handle('bridge:open-obsidian-vault',async(path:string)=>{await shell.openExternal(await vault.obsidianUrl(path));});
```
Also in `main.ts`, the `bridge:stop-session` handler already calls `providers.cancel(paneId)`, which cancels an in-flight vault question too; no change needed there.

- [ ] **Step 6: Type-check**

Run: `npx tsc --noEmit -p tsconfig.json && npx tsc --noEmit -p tsconfig.electron.json`
Expected: no output.

- [ ] **Step 7: Commit**

```bash
git add electron/vault.ts shared/types.ts electron/preload.ts electron/main.ts tests/vault-pane.test.ts
git commit -m "feat(vault): ask, resolve and graph over the memory vault with bridge calls

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: The `vault` pane type and `VaultPane` component

**Files:**
- Modify: `shared/types.ts` (`PaneType`)
- Modify: `shared/domain.ts` (`PANE_TYPES`, `createPane`)
- Modify: `src/PaneEditor.tsx`
- Modify: `src/App.tsx`
- Create: `src/VaultPane.tsx`
- Create: `src/VaultGraph.tsx` (placeholder in this task, real canvas in Task 4)
- Modify: `src/styles.css`
- Modify: `tests/domain.test.ts` (one assertion)

**Interfaces:**
- Consumes: bridge from Task 2, `COMMAND` from Task 1.
- Produces: `VaultPane` props `{ pane, profiles, workspaces, onProfile, onEditProfile, onStatus, onLaunch, onLoadWorkspace }`; `VaultGraph` props `{ graph, thinking, highlight, pulse }`.

- [ ] **Step 1: Write the failing domain test**

In `tests/domain.test.ts`, add inside the first `describe` (any position):
```ts
  it('vault panes carry a profile and never auto-start', () => {
    const pane = createPane('vault', 'D:\\x', 'prof');
    expect(pane.type).toBe('vault'); expect(pane.profileId).toBe('prof'); expect(pane.autoStart).toBe(false); expect(pane.title).toBe('Vault');
  });
```
Ensure `createPane` is imported at the top of that file (add it to the existing import from `../shared/domain` if missing).

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/domain.test.ts`
Expected: FAIL on type `'vault'` (type-check) or on `title`.

- [ ] **Step 3: Add the pane type**

`shared/types.ts`: `export type PaneType = 'claude' | 'powershell' | 'powershell-admin' | 'local-model' | 'vault' | 'codex' | 'gemini' | 'wsl' | 'cmd' | 'git-bash' | 'custom';`

`shared/domain.ts`: in `PANE_TYPES` insert `{type:'vault',label:'Vault'},` directly after the `local-model` entry. In `createPane`, change the `autoStart` expression to `type!=='powershell-admin' && type!=='local-model' && type!=='vault' && type!=='custom'`.

`src/PaneEditor.tsx`: change `draft.type==='local-model'?` to `draft.type==='local-model'||draft.type==='vault'?`.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/domain.test.ts`
Expected: PASS.

- [ ] **Step 5: Placeholder `VaultGraph`**

Create `src/VaultGraph.tsx` (replaced wholesale in Task 4):
```tsx
import type { VaultGraph as Graph } from '../shared/types';
export default function VaultGraph({ graph }: { graph: Graph | null; thinking: boolean; highlight: string[]; pulse: string }) {
  return <canvas className="vault-graph" aria-label="Vault graph" role="img" data-nodes={graph?.nodes.length ?? 0} />;
}
```

- [ ] **Step 6: `VaultPane.tsx`**

```tsx
import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Square, Trash2, Brain } from 'lucide-react';
import type { LocalProfile, PaneConfig, VaultGraph as Graph, VaultTarget } from '../shared/types';
import { COMMAND } from '../shared/vault';
import VaultGraph from './VaultGraph';

interface Entry { role: 'user' | 'assistant' | 'system'; content: string; notes?: string[] }
export default function VaultPane({pane,profiles,workspaces,onProfile,onEditProfile,onStatus,onLaunch,onLoadWorkspace}: {pane:PaneConfig;profiles:LocalProfile[];workspaces:{id:string;name:string}[];onProfile:(id:string)=>void;onEditProfile:(id:string)=>void;onStatus:(status:'idle'|'busy'|'error'|'running',message?:string)=>void;onLaunch:(target:VaultTarget)=>void;onLoadWorkspace:(id:string)=>void}) {
  const [entries,setEntries]=useState<Entry[]>([]),[prompt,setPrompt]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[graph,setGraph]=useState<Graph|null>(null),[highlight,setHighlight]=useState<string[]>([]),[pulse,setPulse]=useState('');
  const scroll=useRef<HTMLDivElement>(null),sequence=useRef(0); const profile=profiles.find(p=>p.id===pane.profileId);
  const refresh=()=>{window.bridge.vaultGraph().then(setGraph).catch(()=>{});};
  useEffect(()=>{refresh();window.addEventListener('focus',refresh);return()=>{window.removeEventListener('focus',refresh);sequence.current++;void window.bridge.cancelChat(pane.id);};},[]);
  useEffect(()=>{scroll.current?.scrollTo({top:scroll.current.scrollHeight});},[entries,busy]);
  const say=(content:string)=>setEntries(e=>[...e,{role:'system',content}]);
  const command=async(name:string)=>{
    const targets=await window.bridge.vaultResolve(name,workspaces);
    const projects=targets.filter(t=>t.kind==='project'),vaults=targets.filter(t=>t.kind==='obsidian'),spaces=targets.filter(t=>t.kind==='workspace');
    if(projects.length===1){onLaunch(projects[0]);say(`Opened a Claude pane in ${projects[0].path}.`);if(vaults.length===1){await window.bridge.openObsidianVault(vaults[0].path);say(`Opened Obsidian vault ${vaults[0].name}.`);}return;}
    if(!projects.length&&vaults.length===1){await window.bridge.openObsidianVault(vaults[0].path);say(`Opened Obsidian vault ${vaults[0].name}.`);return;}
    if(!projects.length&&!vaults.length&&spaces.length===1){onLoadWorkspace(spaces[0].path);say(`Loading workspace ${spaces[0].name}.`);return;}
    say(targets.length?`More than one match for "${name}":\n${targets.map(t=>`- ${t.kind}: ${t.name}`).join('\n')}\nBe more specific.`:`Nothing in the vault, Obsidian, or your workspaces matches "${name}".`);
  };
  const send=async()=>{
    if(busy||!prompt.trim())return; const text=prompt.trim(),m=COMMAND.exec(text); setPrompt('');setError('');setEntries(e=>[...e,{role:'user',content:text}]);
    if(m){try{await command(m[2]);}catch(e){setError(String(e));}return;}
    if(!profile?.model){setError('Choose a model in this profile before asking.');return;}
    const mine=++sequence.current;setBusy(true);setHighlight([]);onStatus('busy');
    try{const r=await window.bridge.vaultAsk(pane.id,profile,text);if(sequence.current===mine){setEntries(e=>[...e,{role:'assistant',content:r.answer,notes:r.notes}]);setHighlight(r.notes);onStatus('running');refresh();}}
    catch(e){if(sequence.current===mine){setError(String(e));onStatus('error',String(e));}}
    finally{if(sequence.current===mine)setBusy(false);}
  };
  const stop=()=>{sequence.current++;void window.bridge.cancelChat(pane.id);setBusy(false);onStatus('idle');};
  const notes=graph?graph.nodes.filter(n=>n.type!=='hub').length:0,hubs=graph?graph.nodes.length-notes:0;
  return <div className="local-content vault-content">
    <div className="profile-strip"><Brain size={13}/><select aria-label={`Profile for ${pane.title}`} value={pane.profileId} disabled={busy} onChange={e=>onProfile(e.target.value)}><option value="">Choose a profile</option>{profiles.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select><button aria-label={`Edit profile for ${pane.title}`} onClick={()=>profile&&onEditProfile(profile.id)}>Configure</button></div>
    <VaultGraph graph={graph} thinking={busy} highlight={highlight} pulse={pulse}/>
    <div className="chat-transcript" ref={scroll}>
      {!entries.length&&<div className="local-welcome"><Brain size={22}/><strong>Claude memory vault</strong><span>{graph?`${notes} notes across ${hubs} projects`:'Loading vault…'}</span><p>Ask about anything Claude remembers, or type "launch &lt;project&gt;".</p></div>}
      {entries.map((m,i)=><div className={`chat-message ${m.role}`} key={i}><span className="speaker">{m.role==='user'?'You':m.role==='system'?'AlphaCode':'Vault'}</span><pre>{m.content}</pre>{m.notes?.length?<div className="note-chips">{m.notes.map(n=><button type="button" key={n} className="note-chip" onClick={()=>setPulse(`${n}:${Date.now()}`)}>{n}</button>)}</div>:null}</div>)}
      {busy&&<div className="thinking">Reading the vault…</div>}
      {error&&<div className="inline-error" role="alert">{error}</div>}
    </div>
    <form className="composer" onSubmit={e=>{e.preventDefault();void send();}}><textarea aria-label={`Message ${pane.title}`} placeholder="Ask the vault, or: launch <project>" value={prompt} onChange={e=>setPrompt(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();void send();}}}/>{busy?<button type="button" aria-label={`Cancel response ${pane.title}`} onClick={stop}><Square size={14}/></button>:<button type="submit" aria-label={`Send to ${pane.title}`} disabled={!prompt.trim()}><ArrowUp size={16}/></button>}</form>
    <div className="terminal-footer"><span>{profile?.model||'No model selected'} · Vault</span><button disabled={busy} aria-label={`Clear conversation ${pane.title}`} onClick={()=>{setEntries([]);setError('');setHighlight([]);onStatus('idle');}}><Trash2 size={11}/>Clear</button></div>
  </div>;
}
```

- [ ] **Step 7: Wire `App.tsx`**

Five existing `local-model` branches plus two new helpers. Apply each edit exactly:

1. Imports: add `import VaultPane from './VaultPane';` after the `LocalPane` import; add `VaultTarget` to the type import from `../shared/types` (`Brain` was added to the lucide import by the vault plan).
2. `PaneIcon`: replace `type==='local-model'?<Cpu size={size}/>` with `type==='local-model'?<Cpu size={size}/>:type==='vault'?<Brain size={size}/>`.
3. `stopAll`: replace `p.type==='local-model'?window.bridge.cancelChat(p.id)` with `p.type==='local-model'||p.type==='vault'?window.bridge.cancelChat(p.id)`.
4. `savePane`: replace `restartable=p.type!=='powershell-admin'&&p.type!=='local-model'` with `restartable=p.type!=='powershell-admin'&&p.type!=='local-model'&&p.type!=='vault'`.
5. `add`: replace `type==='local-model'?state?.profiles[0]?.id:''` with `type==='local-model'||type==='vault'?state?.profiles[0]?.id:''`.
6. Add after the `add` function:
```tsx
  const launchProject=(t:VaultTarget)=>{if(!workspace||workspace.panes.length>=32){report('A workspace supports up to 32 panes.');return;}const pane={...createPane('claude',t.path),title:t.name,autoStart:true};update(w=>addPane(w,pane));setFocused(pane.id);};
```
7. Pane body: replace `{p.type==='local-model'?<LocalPane ` with `{p.type==='vault'?<VaultPane pane={p} profiles={state.profiles} workspaces={state.workspaces.map(w=>({id:w.id,name:w.name}))} onProfile={profileId=>update(w=>({...w,panes:w.panes.map(x=>x.id===p.id?{...x,profileId}:x)}))} onEditProfile={profileId=>setProfileEditor(state.profiles.find(x=>x.id===profileId)||null)} onStatus={(status,message)=>setStatuses(prev=>({...prev,[p.id]:{paneId:p.id,kind:'status',status,message}}))} onLaunch={launchProject} onLoadWorkspace={id=>void switchWorkspace(id)}/>:p.type==='local-model'?<LocalPane ` leaving the rest of the line unchanged.

Note: `autoStart:true` on the launched Claude pane means it also starts on the next workspace load, the same as the default Claude panes. That is the intended "launch" behavior and is documented in the README step below.

- [ ] **Step 8: Styles**

Append to `src/styles.css`:
```css
.vault-content{display:flex;flex-direction:column;min-height:0}.vault-graph{display:block;width:100%;flex:0 0 40%;min-height:120px;background:#0f1215;border-bottom:1px solid #262c33;cursor:crosshair}.vault-content .chat-transcript{flex:1 1 auto;min-height:0}.chat-message.system .speaker{color:#8c99a8}.note-chips{display:flex;flex-wrap:wrap;gap:4px;margin-top:6px}.note-chip{font-size:10px;line-height:1.2;padding:2px 7px;min-height:0;border-radius:10px;border:1px solid #3a434d;background:transparent;color:#a9b4c1}.note-chip:hover{border-color:#8c99a8;color:#e6edf3}
```

- [ ] **Step 9: Build and smoke in the app**

Run: `npm run build && npm test`
Expected: clean build, all suites pass.

Run `npm start`. Add pane, choose **Vault**, pick the Ollama profile with a model loaded. Type `launch Peptide Sciences 101` (or any project name from your vault) and confirm a Claude pane appears in that folder and starts, and Obsidian opens the matching vault if one is registered. Ask a question that matches a note and confirm the answer and note chips appear. Close the app.

- [ ] **Step 10: Commit**

```bash
git add shared/types.ts shared/domain.ts src/PaneEditor.tsx src/App.tsx src/VaultPane.tsx src/VaultGraph.tsx src/styles.css tests/domain.test.ts
git commit -m "feat(vault): Vault pane answers questions from memory notes and launches projects

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Force-directed graph canvas, README, end-to-end render check

**Files:**
- Replace: `src/VaultGraph.tsx`
- Modify: `README.md`
- Modify: `tests/e2e.spec.ts`

**Interfaces:**
- Consumes: `VaultGraph` type, props from Task 3.

- [ ] **Step 1: Write the end-to-end check**

In `tests/e2e.spec.ts`, in the test `'local models, optional pane menu, named workspaces and preset counts'`, change the pane-menu name list to include `'Vault'` after `'Local Model'`, and directly after that `for` loop add:
```ts
    await page.locator('.dropdown').getByRole('button',{name:'Vault',exact:true}).click();await page.getByRole('button',{name:'Apply changes',exact:true}).click();
    await expect(page.locator('.pane[data-pane-title="Vault"] canvas.vault-graph')).toBeVisible();
    await expect(page.locator('.pane[data-pane-title="Vault"] .local-welcome')).toContainText(/\d+ notes across \d+ projects/);
    await page.getByLabel('Message Vault',{exact:true}).fill('launch zzz-no-such-project');await page.getByRole('button',{name:'Send to Vault',exact:true}).click();
    await expect(page.locator('.pane[data-pane-title="Vault"] .chat-transcript')).toContainText('Nothing in the vault');
    await page.getByRole('button',{name:'Add pane',exact:true}).click();
```
Then every later `.pane` count in that test is one higher: `toHaveCount(9)` becomes `toHaveCount(10)` for the CMD step. The preset steps (4, 6, 1) are unaffected.

- [ ] **Step 2: Run to verify it fails**

Run: `npx playwright test -g "local models"`
Expected: PASS against the Task 3 placeholder canvas. This run proves the pane wiring before the canvas is replaced; a failure here means Task 3 is incomplete and must be fixed first.

- [ ] **Step 3: Replace `src/VaultGraph.tsx` with the canvas simulation**

```tsx
import { useEffect, useRef } from 'react';
import type { VaultGraph as Graph } from '../shared/types';

interface Body { id: string; label: string; type: string; x: number; y: number; vx: number; vy: number; r: number; }
const COLORS: Record<string, string> = { hub: '#e6edf3', user: '#58a6ff', feedback: '#f0883e', project: '#3fb950', reference: '#a371f7', other: '#8b949e' };

/** Force-directed vault graph. Rest: slow breathing. Thinking: a brightness wave. Answered: named notes glow. */
export default function VaultGraph({ graph, thinking, highlight, pulse }: { graph: Graph | null; thinking: boolean; highlight: string[]; pulse: string }) {
  const canvas = useRef<HTMLCanvasElement>(null), bodies = useRef(new Map<string, Body>());
  const s = useRef({ thinking, highlight, pulse, pulseAt: 0, hot: 1, settled: false, edges: [] as { from: string; to: string }[], hover: '' });
  s.current.thinking = thinking;
  if (s.current.highlight !== highlight) { s.current.highlight = highlight; s.current.hot = 1; }
  if (s.current.pulse !== pulse) { s.current.pulse = pulse; s.current.pulseAt = performance.now(); s.current.hot = 1; }
  useEffect(() => {
    if (!graph) return; const map = bodies.current, seen = new Set<string>();
    graph.nodes.forEach((n, i) => { seen.add(n.id); const b = map.get(n.id); if (b) { b.label = n.label; b.type = n.type; return; } const a = i * 2.4, d = 20 + Math.sqrt(i) * 14; map.set(n.id, { id: n.id, label: n.label, type: n.type, x: Math.cos(a) * d, y: Math.sin(a) * d, vx: 0, vy: 0, r: n.type === 'hub' ? 7 : 3.5 }); });
    for (const id of [...map.keys()]) if (!seen.has(id)) map.delete(id);
    s.current.edges = graph.edges; s.current.settled = false; s.current.hot = 1;
  }, [graph]);
  useEffect(() => {
    const el = canvas.current!, ctx = el.getContext('2d')!, reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches; let frame = 0;
    const move = (e: MouseEvent) => { const b = el.getBoundingClientRect(), x = e.clientX - b.left - b.width / 2, y = e.clientY - b.top - b.height / 2; let best = '', d = 12; for (const n of bodies.current.values()) { const dd = Math.hypot(n.x - x, n.y - y); if (dd < d) { d = dd; best = n.id; } } if (best !== s.current.hover) { s.current.hover = best; s.current.hot = 1; } };
    el.addEventListener('mousemove', move);
    const step = (now: number) => {
      frame = requestAnimationFrame(step);
      const st = s.current, nodes = [...bodies.current.values()], w = el.clientWidth, h = el.clientHeight; if (!w || !h) return;
      const dpr = window.devicePixelRatio || 1; if (el.width !== Math.round(w * dpr) || el.height !== Math.round(h * dpr)) { el.width = Math.round(w * dpr); el.height = Math.round(h * dpr); st.hot = 1; }
      const animate = st.hot > 0 || !st.settled || (!reduce && (st.thinking || st.highlight.length > 0 || now - st.pulseAt < 1500));
      if (!animate) return;
      if (!st.settled && nodes.length) {
        // ponytail: O(n²) repulsion each frame; fine for a few hundred notes, use a grid or Barnes-Hut past a few thousand.
        let energy = 0;
        for (const a of nodes) { let fx = -a.x * 0.002, fy = -a.y * 0.002; for (const b of nodes) { if (a === b) continue; const dx = a.x - b.x, dy = a.y - b.y, d2 = dx * dx + dy * dy + 1, f = 60 / d2; fx += dx * f; fy += dy * f; } a.vx = (a.vx + fx) * 0.85; a.vy = (a.vy + fy) * 0.85; }
        for (const e of st.edges) { const a = bodies.current.get(e.from), b = bodies.current.get(e.to); if (!a || !b) continue; const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1, f = (d - 40) * 0.01; a.vx += dx / d * f; a.vy += dy / d * f; b.vx -= dx / d * f; b.vy -= dy / d * f; }
        for (const n of nodes) { n.x += n.vx; n.y += n.vy; energy += Math.abs(n.vx) + Math.abs(n.vy); }
        if (energy < 0.02 * nodes.length) st.settled = true;
      } else if (!nodes.length) st.settled = true;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
      const t = now / 1000, breathe = (i: number) => reduce ? 0 : Math.sin(t * 0.6 + i) * 1.5;
      const pos = new Map(nodes.map((n, i) => [n.id, { x: w / 2 + n.x + breathe(i), y: h / 2 + n.y + breathe(i * 1.7) }]));
      const lit = (n: Body) => st.highlight.includes(n.label) || (st.pulse.startsWith(n.label + ':') && now - st.pulseAt < 1500);
      ctx.lineWidth = 1;
      for (const e of st.edges) { const a = pos.get(e.from), b = pos.get(e.to), na = bodies.current.get(e.from), nb = bodies.current.get(e.to); if (!a || !b || !na || !nb) continue; ctx.strokeStyle = lit(na) || lit(nb) ? 'rgba(230,237,243,0.55)' : 'rgba(140,153,168,0.18)'; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); }
      nodes.forEach(n => { const p = pos.get(n.id)!, glow = lit(n) ? 1 : st.thinking && !reduce ? 0.5 + 0.5 * Math.sin(t * 4 - (p.x / w) * 6) : 0; ctx.beginPath(); ctx.arc(p.x, p.y, n.r + glow * 2, 0, Math.PI * 2); ctx.fillStyle = COLORS[n.type] || COLORS.other; ctx.globalAlpha = 0.55 + glow * 0.45; ctx.fill(); ctx.globalAlpha = 1; if (lit(n) || n.id === st.hover || n.type === 'hub') { ctx.fillStyle = '#c9d1d9'; ctx.font = '10px Inter, system-ui, sans-serif'; ctx.fillText(n.label, p.x + n.r + 3, p.y + 3); } });
      if (!nodes.length) { ctx.fillStyle = '#6f7b88'; ctx.font = '11px Inter, system-ui, sans-serif'; ctx.fillText('No memories yet', 12, 20); }
      st.hot = Math.max(0, st.hot - 0.02);
    };
    frame = requestAnimationFrame(step);
    return () => { cancelAnimationFrame(frame); el.removeEventListener('mousemove', move); };
  }, []);
  return <canvas className="vault-graph" ref={canvas} aria-label="Vault graph" role="img" />;
}
```

- [ ] **Step 4: Build, unit tests, end-to-end**

Run: `npm run build && npm test && npx playwright test -g "local models"`
Expected: all pass.

- [ ] **Step 5: README**

In `README.md`:

Pane types table, after the **Local Model** row:
```markdown
| **Vault** | none | Talks to the Claude memory vault through a local model profile. Ask questions, or type `launch <project>`. No process is spawned. |
```
After the `### Local model panes` section (before `### Local model profile dialog`), add:
```markdown
### Vault pane

A Vault pane talks to the [Claude memory vault](#claude-memory-vault) using one of your local
model profiles, so nothing leaves your machine.

- The **graph** at the top is every note in the vault: discs are notes, colored by memory type,
  larger discs are projects, lines are links between notes. It drifts gently at rest, pulses
  while a question is being answered, and lights up the notes an answer came from. Hover a disc
  to read its name. If Windows is set to reduce motion, the graph is still.
- **Ask a question** in the composer. AlphaCode picks the notes whose names, descriptions, and
  text best match your words, sends only those to the model, and shows the answer with a chip
  for each note it used. Clicking a chip flashes that note in the graph. If nothing matches,
  the model says so.
- **Give a launch command**: a message starting with `launch`, `open`, or `start` followed by a
  name. The name is matched, ignoring case, spaces, and punctuation, against the projects in
  the vault, the vaults in your Obsidian vault list, and your saved workspaces. A single
  project match adds a Claude pane in that project's folder and starts it (the pane is saved
  with auto-start on, like the default Claude panes); a matching Obsidian vault is opened as
  well. A lone Obsidian match just opens that vault; a lone workspace match loads it. Several
  matches, or none, are listed instead so nothing opens by guesswork. Commands never go to the
  model.
- Conversations are kept in memory only, like Local Model panes. **Clear** empties the
  transcript.
```
In the Contents list, after the Local model panes entry, add `   - [Vault pane](#vault-pane)`.

- [ ] **Step 6: Run the app once more**

Run `npm start`, open the Vault pane, watch the graph settle, ask a question, confirm the pulse during the wait and the glow after. Close the app.

- [ ] **Step 7: Commit**

```bash
git add src/VaultGraph.tsx README.md tests/e2e.spec.ts
git commit -m "feat(vault): force-directed vault graph with thinking and highlight states; docs

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```
