# Claude Memory Vault Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gather every Claude Code memory folder into one Obsidian vault of live junctions plus generated hub notes, kept current by AlphaCode's main process, with a sidebar section to open it.

**Architecture:** Pure helpers (frontmatter parsing, naming, note rendering) live in `shared/vault.ts` so both processes and tests can use them with no Node imports. `electron/vault.ts` owns the filesystem work in a `MemoryVault` class that scans on launch and every five minutes. Three new bridge calls expose vault info and two open actions to a new sidebar section.

**Tech Stack:** TypeScript, Electron 44 main process (`node:fs/promises`, `shell`), React 19 renderer, Vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-09-claude-memory-vault-design.md`

## Global Constraints

- Windows only; junctions are created with `fs.symlink(target, path, 'junction')` and need no admin.
- Vault root is `%USERPROFILE%\AlphaCode Vault`. Claude config dir is `%USERPROFILE%\.claude`, or `CLAUDE_CONFIG_DIR` when set.
- Generated notes start with frontmatter containing exactly `generated: alphacode`; a scan overwrites a file only if it carries that marker.
- The scan never throws; errors land in `VaultInfo.message`.
- Nothing inside a Claude memory folder is ever written by AlphaCode.
- Code style follows the repo: dense single-line statements, no new abstractions, `ponytail:` comments on deliberate ceilings.
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Review Focus

1. A project whose cwd is a drive root (`B:\`) must produce a usable folder name, not an empty one or `B:` (invalid on Windows). Pinned in Task 1 (`sanitizeName`, `uniqueNames`).
2. A junction that exists but points at a stale folder (project moved) must be replaced, not left broken. Pinned in Task 2.
3. The vault folder deleted while the app runs must be rebuilt on the next scan with no error. Pinned in Task 2.
4. A memory note with no frontmatter at all must still be listed, with empty description and type `other`. Pinned in Task 1 and Task 2.
5. Two concurrent `scan()` calls (timer tick during the launch scan) must not race on the same files. Pinned in Task 2 (single in-flight promise).

---

### Task 1: Pure vault helpers

**Files:**
- Create: `shared/vault.ts`
- Create: `tests/vault.test.ts`
- Modify: `shared/types.ts` (add `VaultInfo`)

**Interfaces:**
- Produces: `NoteMeta`, `MARKER`, `TYPES`, `parseFrontmatter(text)`, `wikilinks(text)`, `isGenerated(text)`, `sanitizeName(s)`, `cwdFromTranscript(text)`, `uniqueNames(entries)`, `hubNote(title, notes, intro?)`, `homeNote(projects, types, projectsDir, scannedAt)`; `VaultInfo` in `shared/types.ts`.

- [ ] **Step 1: Add the `VaultInfo` type**

In `shared/types.ts`, after the `AppInfo` line, add:

```ts
export interface VaultInfo { path: string; projects: number; notes: number; obsidian: boolean; scannedAt: string; message: string; }
```

- [ ] **Step 2: Write the failing tests**

Create `tests/vault.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { cwdFromTranscript, homeNote, hubNote, isGenerated, parseFrontmatter, sanitizeName, uniqueNames, wikilinks, MARKER, type NoteMeta } from '../shared/vault';

const note = (over: Partial<NoteMeta>): NoteMeta => ({ name: 'n', description: '', type: 'other', modified: '', project: 'P', file: '', links: [], body: '', ...over });

describe('vault note helpers', () => {
  it('parses flat and nested frontmatter, first key wins, quotes stripped', () => {
    const fm = parseFrontmatter('---\nname: navistation-no-new-stack\ndescription: "NaviStation: \\"vanilla\\" build"\nmetadata:\n  type: feedback\n  modified: 2026-10-05T15:59:44.817Z\n---\nBody type: ignored\n');
    expect(fm.name).toBe('navistation-no-new-stack');
    expect(fm.description).toBe('NaviStation: "vanilla" build');
    expect(fm.type).toBe('feedback');
    expect(fm.modified).toBe('2026-10-05T15:59:44.817Z');
    expect(parseFrontmatter('no frontmatter here')).toEqual({});
  });
  it('collects unique wikilink basenames and ignores aliases and headings', () => {
    expect(wikilinks('see [[a]] and [[b|B]] and [[a#top]] and [[Projects/X/c]]')).toEqual(['a', 'b', 'c']);
  });
  it('recognizes generated notes only by the marker in frontmatter', () => {
    expect(isGenerated(`---\n${MARKER}\n---\n# Home\n`)).toBe(true);
    expect(isGenerated('---\nname: x\n---\ngenerated: alphacode in body')).toBe(false);
    expect(isGenerated('# Home')).toBe(false);
  });
  it('sanitizes names to Windows rules and never returns an empty name', () => {
    expect(sanitizeName('B:')).toBe('B_');
    expect(sanitizeName(' .dots. ')).toBe('dots');
    expect(sanitizeName('')).toBe('project');
    expect(sanitizeName('Ünïcode ok')).toBe('Ünïcode ok');
  });
  it('reads the first cwd from a transcript head', () => {
    expect(cwdFromTranscript('{"type":"x"}\n{"cwd":"D:\\\\Dev\\\\AlphaCode","x":1}')).toBe('D:\\Dev\\AlphaCode');
    expect(cwdFromTranscript('nothing')).toBe('');
  });
  it('names projects by last segment, parent on collision, slug when still equal', () => {
    const names = uniqueNames([
      { slug: 'D--Dev-AlphaCode', cwd: 'D:\\Dev\\AlphaCode' },
      { slug: 'C--Users-james-Dev-AlphaCode', cwd: 'C:\\Users\\james\\Dev\\AlphaCode' },
      { slug: 'E--Other-AlphaCode', cwd: 'E:\\Other\\AlphaCode' },
      { slug: 'B--', cwd: 'B:\\' },
      { slug: 'no-transcript', cwd: '' },
    ]);
    // Both Dev folders collide again after the parent is appended, so both fall back to their slug.
    expect(names.get('D--Dev-AlphaCode')).toBe('D--Dev-AlphaCode');
    expect(names.get('C--Users-james-Dev-AlphaCode')).toBe('C--Users-james-Dev-AlphaCode');
    expect(names.get('E--Other-AlphaCode')).toBe('AlphaCode (Other)');
    expect(names.get('B--')).toBe('B_');
    expect(names.get('no-transcript')).toBe('no-transcript');
  });
  it('renders hub and home notes with the marker and path-qualified links', () => {
    const hub = hubNote('AlphaCode', [note({ name: 'a', description: 'first' }), note({ name: 'b' })], 'intro line');
    expect(hub.startsWith(`---\n${MARKER}\n---\n# AlphaCode\n`)).toBe(true);
    expect(hub).toContain('intro line');
    expect(hub).toContain('- [[Projects/P/a|a]] - first');
    expect(hub).toContain('- [[Projects/P/b|b]] - ');
    const home = homeNote([{ name: 'P', count: 2 }], [{ type: 'feedback', count: 1 }], 'C:\\x\\projects', '2026-10-09T00:00:00.000Z');
    expect(home).toContain('- [[Projects/P|P]] (2)');
    expect(home).toContain('- [[Types/feedback|feedback]] (1)');
    expect(home).toContain('C:\\x\\projects');
    expect(homeNote([], [], 'C:\\x', 'now')).toContain('No memories yet');
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/vault.test.ts`
Expected: FAIL, cannot resolve `../shared/vault`.

- [ ] **Step 4: Write `shared/vault.ts`**

```ts
import type { ChatMessage, VaultGraph, VaultTarget } from './types';

export interface NoteMeta { name: string; description: string; type: string; modified: string; project: string; file: string; links: string[]; body: string; }
export const MARKER = 'generated: alphacode';
export const TYPES = ['user', 'feedback', 'project', 'reference'] as const;

/** Flat map of every `key: value` line in the frontmatter block, nested keys included, first occurrence wins. */
export function parseFrontmatter(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!text.startsWith('---')) return out;
  const end = text.indexOf('\n---', 3); if (end < 0) return out;
  for (const line of text.slice(3, end).split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][\w-]*):\s*(.*?)\s*$/.exec(line); if (!m || m[1] in out) continue;
    let v = m[2];
    if (v.length >= 2 && v[0] === '"' && v.endsWith('"')) { try { v = JSON.parse(v); } catch { v = v.slice(1, -1); } }
    else if (v.length >= 2 && v[0] === "'" && v.endsWith("'")) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}
export const wikilinks = (text: string): string[] => [...new Set([...text.matchAll(/\[\[([^\]|#]+)/g)].map(m => m[1].trim().split('/').pop() || ''))].filter(Boolean);
export const isGenerated = (text: string): boolean => { const end = text.indexOf('\n---', 3); return text.startsWith('---') && end > 0 && text.slice(3, end).includes(MARKER); };
export const sanitizeName = (s: string): string => s.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/^[. ]+|[. ]+$/g, '').slice(0, 100) || 'project';
export const cwdFromTranscript = (text: string): string => { const m = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(text); if (!m) return ''; try { return JSON.parse(`"${m[1]}"`); } catch { return ''; } };
const segments = (cwd: string) => cwd.split(/[\\/]/).filter(Boolean);
/** Project display names: last path segment, parent appended on collision, slug when still equal. */
export function uniqueNames(entries: { slug: string; cwd: string }[]): Map<string, string> {
  const name = (e: { slug: string; cwd: string }, withParent: boolean) => { const s = segments(e.cwd); if (!s.length) return e.slug; return withParent && s.length > 1 ? `${s[s.length - 1]} (${s[s.length - 2]})` : s[s.length - 1]; };
  const count = (names: string[]) => names.reduce((m, n) => m.set(n, (m.get(n) || 0) + 1), new Map<string, number>());
  const first = entries.map(e => sanitizeName(name(e, false))), c1 = count(first);
  const second = entries.map((e, i) => c1.get(first[i])! > 1 ? sanitizeName(name(e, true)) : first[i]), c2 = count(second);
  return new Map(entries.map((e, i) => [e.slug, c2.get(second[i])! > 1 ? sanitizeName(e.slug) : second[i]]));
}
const link = (n: NoteMeta) => `[[Projects/${n.project}/${n.name}|${n.name}]]`;
export const hubNote = (title: string, notes: NoteMeta[], intro = ''): string => `---\n${MARKER}\n---\n# ${title}\n${intro ? `\n${intro}\n` : ''}\n${notes.map(n => `- ${link(n)} - ${n.description}`).join('\n')}\n`;
export const homeNote = (projects: { name: string; count: number }[], types: { type: string; count: number }[], projectsDir: string, scannedAt: string): string =>
  `---\n${MARKER}\n---\n# Home\n\n## Projects\n${projects.length ? projects.map(p => `- [[Projects/${p.name}|${p.name}]] (${p.count})`).join('\n') : '- No memories yet. Work with Claude in an AlphaCode pane and they appear here.'}\n\n## Types\n${types.map(t => `- [[Types/${t.type}|${t.type}]] (${t.count})`).join('\n')}\n\nClaude projects: \`${projectsDir}\` · scanned ${scannedAt}\n`;
```

The `ChatMessage`, `VaultGraph`, `VaultTarget` imports are used by the Vault pane plan; leave the import line as written so that plan only appends.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/vault.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 6: Type-check both targets**

Run: `npx tsc --noEmit -p tsconfig.json && npx tsc --noEmit -p tsconfig.electron.json`
Expected: no output. If `VaultGraph`/`VaultTarget` are reported missing, add temporary stubs to `shared/types.ts`: `export interface VaultGraph { nodes: { id: string; label: string; project: string; type: string }[]; edges: { from: string; to: string }[]; }` and `export interface VaultTarget { kind: 'project' | 'obsidian' | 'workspace'; name: string; path: string; }` (these are the final definitions the Vault pane plan uses).

- [ ] **Step 7: Commit**

```bash
git add shared/vault.ts shared/types.ts tests/vault.test.ts
git commit -m "feat(vault): pure helpers for Claude memory notes

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: `MemoryVault` scan with junctions and hubs

**Files:**
- Create: `electron/vault.ts`
- Modify: `tests/vault.test.ts` (append a `describe`)

**Interfaces:**
- Consumes: everything from Task 1.
- Produces: `class MemoryVault { constructor(path, claudeDir, obsidianExe, obsidianRegistry, providers); path; obsidianInstalled(): boolean; info(): Promise<VaultInfo>; scan(): Promise<VaultInfo> }`. The `obsidianRegistry` and `providers` constructor arguments are unused in this plan and consumed by the Vault pane plan; pass them now so the constructor signature never changes.

- [ ] **Step 1: Write the failing tests**

Append to `tests/vault.test.ts`:

```ts
import { mkdir, mkdtemp, readFile, readlink, rm, rmdir, symlink, writeFile, lstat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryVault } from '../electron/vault';

const memory = (fm: string, body = 'body') => `---\n${fm}\n---\n${body}\n`;
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'alphacode-vault-'));
  const claude = join(root, 'claude'), vault = join(root, 'AlphaCode Vault');
  const project = async (slug: string, cwd: string | null, notes: Record<string, string>) => {
    const dir = join(claude, 'projects', slug); await mkdir(join(dir, 'memory'), { recursive: true });
    if (cwd) await writeFile(join(dir, 'a.jsonl'), JSON.stringify({ type: 'user', cwd }) + '\n');
    for (const [file, text] of Object.entries(notes)) await writeFile(join(dir, 'memory', file), text);
  };
  await project('D--Dev-AlphaCode', 'D:\\Dev\\AlphaCode', { 'MEMORY.md': '# index', 'pick-ponytail.md': memory('name: pick-ponytail\ndescription: Lazy by default\nmetadata:\n  type: feedback'), 'bare.md': 'no frontmatter at all [[pick-ponytail]]' });
  await project('B--NaviStation-JB', 'B:\\NaviStation_JB', { 'stack.md': memory('name: stack\ndescription: Razor Pages only\nmetadata:\n  type: project') });
  await project('no-log', null, { 'x.md': memory('name: x\ndescription: d\nmetadata:\n  type: user') });
  const make = () => new MemoryVault(vault, claude, join(root, 'missing-Obsidian.exe'), join(root, 'obsidian.json'), {} as any);
  return { root, claude, vault, make, project };
}

describe('MemoryVault scan', () => {
  it('builds junctions, hubs, home and obsidian config from the Claude projects folder', async () => {
    const f = await fixture(); const info = await f.make().scan();
    expect(info.message).toBe(''); expect(info.projects).toBe(3); expect(info.notes).toBe(4); expect(info.obsidian).toBe(false);
    expect((await lstat(join(f.vault, 'Projects', 'AlphaCode'))).isSymbolicLink()).toBe(true);
    expect((await readlink(join(f.vault, 'Projects', 'AlphaCode'))).replace(/^\\\\\?\\/, '').toLowerCase()).toBe(join(f.claude, 'projects', 'D--Dev-AlphaCode', 'memory').toLowerCase());
    expect(await readFile(join(f.vault, 'Projects', 'AlphaCode', 'pick-ponytail.md'), 'utf8')).toContain('Lazy by default');
    const hub = await readFile(join(f.vault, 'Projects', 'AlphaCode.md'), 'utf8');
    expect(hub).toContain('[[Projects/AlphaCode/pick-ponytail|pick-ponytail]] - Lazy by default');
    expect(hub).toContain('[[Projects/AlphaCode/bare|bare]] - ');
    expect(hub).not.toContain('[[Projects/AlphaCode/MEMORY|MEMORY]] - ');
    expect(await readFile(join(f.vault, 'Types', 'other.md'), 'utf8')).toContain('[[Projects/AlphaCode/bare|bare]]');
    expect(await readFile(join(f.vault, 'Types', 'feedback.md'), 'utf8')).toContain('pick-ponytail');
    expect(await readFile(join(f.vault, 'Home.md'), 'utf8')).toContain('- [[Projects/NaviStation_JB|NaviStation_JB]] (1)');
    expect(await readFile(join(f.vault, 'Home.md'), 'utf8')).toContain('- [[Projects/no-log|no-log]] (1)');
    expect(JSON.parse(await readFile(join(f.vault, '.obsidian', 'graph.json'), 'utf8')).colorGroups.length).toBe(3);
    await rm(f.root, { recursive: true, force: true });
  });
  it('keeps user-written notes, replaces stale junctions, prunes removed projects', async () => {
    const f = await fixture(); const v = f.make(); await v.scan();
    await writeFile(join(f.vault, 'Projects', 'AlphaCode.md'), '# mine\n');
    // Point the NaviStation junction somewhere else, as if the project had moved; the scan must repoint it.
    await mkdir(join(f.root, 'elsewhere')); await writeFile(join(f.root, 'elsewhere', 'z.md'), 'z');
    await rmdir(join(f.vault, 'Projects', 'NaviStation_JB'));
    await symlink(join(f.root, 'elsewhere'), join(f.vault, 'Projects', 'NaviStation_JB'), 'junction');
    await rm(join(f.claude, 'projects', 'no-log'), { recursive: true, force: true });
    const info = await v.scan();
    expect(info.message).toContain('AlphaCode.md');
    expect(await readFile(join(f.vault, 'Projects', 'AlphaCode.md'), 'utf8')).toBe('# mine\n');
    expect((await readlink(join(f.vault, 'Projects', 'NaviStation_JB'))).toLowerCase()).toContain('b--navistation-jb');
    expect((await readdir(join(f.vault, 'Projects'))).some(n => n.startsWith('no-log'))).toBe(false);
    expect(info.projects).toBe(2);
    await rm(f.root, { recursive: true, force: true });
  });
  it('rebuilds a deleted vault and tolerates a missing projects folder', async () => {
    const f = await fixture(); const v = f.make(); await v.scan();
    await rm(f.vault, { recursive: true, force: true });
    expect((await v.scan()).projects).toBe(3);
    const empty = new MemoryVault(join(f.root, 'v2'), join(f.root, 'no-claude'), 'x', 'y', {} as any); const info = await empty.scan();
    expect(info.message).toBe(''); expect(info.projects).toBe(0);
    expect(await readFile(join(f.root, 'v2', 'Home.md'), 'utf8')).toContain('No memories yet');
    await rm(f.root, { recursive: true, force: true });
  });
  it('shares one in-flight scan and serves info() from the last result', async () => {
    const f = await fixture(); const v = f.make();
    const [a, b] = await Promise.all([v.scan(), v.scan()]); expect(a).toBe(b);
    expect(await v.info()).toBe(a);
    await rm(f.root, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/vault.test.ts`
Expected: FAIL, cannot resolve `../electron/vault`.

- [ ] **Step 3: Write `electron/vault.ts`**

```ts
import { mkdir, readdir, readFile, lstat, stat, symlink, readlink, unlink, rmdir, writeFile, open } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import type { VaultInfo } from '../shared/types';
import { cwdFromTranscript, homeNote, hubNote, isGenerated, parseFrontmatter, TYPES, uniqueNames, wikilinks, type NoteMeta } from '../shared/vault';
import type { ProviderClient } from './providers';

interface Project { slug: string; name: string; cwd: string; memoryDir: string; }
const head = async (file: string, bytes: number): Promise<string> => { const h = await open(file, 'r'); try { const b = Buffer.alloc(bytes); const { bytesRead } = await h.read(b, 0, bytes, 0); return b.toString('utf8', 0, bytesRead); } finally { await h.close(); } };
const norm = (p: string) => p.replace(/^\\\\\?\\/, '').replace(/[\\/]+$/, '').toLowerCase();
export const samePath = (a: string, b: string): boolean => norm(a) === norm(b);
/** Junction removal: unlink works on most Node builds, rmdir on the rest. Never reaches a real directory because callers check lstat first. */
const removeLink = async (p: string) => { try { await unlink(p); } catch { await rmdir(p); } };
const typeOf = (n: NoteMeta) => (TYPES as readonly string[]).includes(n.type) ? n.type : 'other';
const GRAPH_JSON = JSON.stringify({ colorGroups: [{ query: 'path:Projects', color: { a: 1, rgb: 5814783 } }, { query: 'path:Types', color: { a: 1, rgb: 15763518 } }, { query: 'file:Home', color: { a: 1, rgb: 15132390 } }], showTags: false, showAttachments: false, showOrphans: true, centerStrength: 0.5, repelStrength: 12, linkStrength: 1, linkDistance: 120 }, null, 2);

export class MemoryVault {
  protected notes: NoteMeta[] = []; protected projects: Project[] = []; protected last: VaultInfo | null = null; private running: Promise<VaultInfo> | null = null;
  constructor(public path: string, private claudeDir: string, private obsidianExe: string, protected obsidianRegistry: string, protected providers: ProviderClient) {}
  obsidianInstalled(): boolean { return existsSync(this.obsidianExe); }
  info(): Promise<VaultInfo> { return this.last ? Promise.resolve(this.last) : this.scan(); }
  scan(): Promise<VaultInfo> { if (!this.running) this.running = this.doScan().finally(() => { this.running = null; }); return this.running; }
  private async doScan(): Promise<VaultInfo> {
    const info: VaultInfo = { path: this.path, projects: 0, notes: 0, obsidian: this.obsidianInstalled(), scannedAt: new Date().toISOString(), message: '' };
    try {
      const projectsDir = join(this.claudeDir, 'projects'), skipped: string[] = [];
      for (const d of ['Projects', 'Types', '.obsidian']) await mkdir(join(this.path, d), { recursive: true });
      const projects = await this.discover(projectsDir), notes = await this.readNotes(projects);
      await this.syncJunctions(projects);
      const write = async (file: string, text: string) => { try { if (!isGenerated(await readFile(file, 'utf8'))) { skipped.push(basename(file)); return; } } catch { /* absent: write it */ } await writeFile(file, text, 'utf8'); };
      const keep = new Set<string>();
      for (const p of projects) { keep.add(`${p.name}.md`); await write(join(this.path, 'Projects', `${p.name}.md`), hubNote(p.name, notes.filter(n => n.project === p.name), `Working directory: \`${p.cwd || 'unknown'}\` · [[Projects/${p.name}/MEMORY|Claude's own index]]`)); }
      const types = [...TYPES, ...(notes.some(n => typeOf(n) === 'other') ? ['other'] : [])];
      for (const t of types) await write(join(this.path, 'Types', `${t}.md`), hubNote(t, notes.filter(n => typeOf(n) === t)));
      await write(join(this.path, 'Home.md'), homeNote(projects.map(p => ({ name: p.name, count: notes.filter(n => n.project === p.name).length })), types.map(t => ({ type: t, count: notes.filter(n => typeOf(n) === t).length })), projectsDir, info.scannedAt));
      for (const f of await readdir(join(this.path, 'Projects'))) if (f.endsWith('.md') && !keep.has(f)) { const file = join(this.path, 'Projects', f); if (isGenerated(await readFile(file, 'utf8'))) await unlink(file); }
      for (const [f, text] of [['app.json', '{}'], ['graph.json', GRAPH_JSON]] as const) { const file = join(this.path, '.obsidian', f); if (!existsSync(file)) await writeFile(file, text, 'utf8'); }
      this.projects = projects; this.notes = notes; info.projects = projects.length; info.notes = notes.length;
      if (skipped.length) info.message = `Not overwritten (not generated by AlphaCode): ${skipped.join(', ')}`;
    } catch (error) { info.message = (error as Error).message; }
    this.last = info; return info;
  }
  private async discover(projectsDir: string): Promise<Project[]> {
    let slugs: string[] = []; try { slugs = (await readdir(projectsDir, { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name); } catch { return []; }
    const found: { slug: string; cwd: string; memoryDir: string }[] = [];
    for (const slug of slugs) {
      const dir = join(projectsDir, slug), memoryDir = join(dir, 'memory'); try { if (!(await stat(memoryDir)).isDirectory()) continue; } catch { continue; }
      let cwd = '';
      try { const logs = await Promise.all((await readdir(dir)).filter(f => f.endsWith('.jsonl')).map(async f => ({ f, m: (await stat(join(dir, f))).mtimeMs }))); logs.sort((a, b) => b.m - a.m); for (const { f } of logs) { cwd = cwdFromTranscript(await head(join(dir, f), 65536)); if (cwd) break; } } catch { /* no transcript: slug is the name */ }
      found.push({ slug, cwd, memoryDir });
    }
    const names = uniqueNames(found); return found.map(f => ({ ...f, name: names.get(f.slug)! }));
  }
  private async readNotes(projects: Project[]): Promise<NoteMeta[]> {
    const notes: NoteMeta[] = [];
    for (const p of projects) {
      let files: string[] = []; try { files = (await readdir(p.memoryDir)).filter(f => f.endsWith('.md') && f !== 'MEMORY.md'); } catch { continue; }
      // ponytail: whole note bodies (16 KB cap) stay in memory; index to disk if vaults reach tens of thousands of notes.
      for (const f of files) try { const text = await head(join(p.memoryDir, f), 16384), fm = parseFrontmatter(text); notes.push({ name: f.slice(0, -3), description: fm.description || '', type: fm.type || 'other', modified: fm.modified || '', project: p.name, file: join(p.memoryDir, f), links: wikilinks(text), body: text }); } catch { /* unreadable note is skipped this scan */ }
    }
    return notes;
  }
  private async syncJunctions(projects: Project[]): Promise<void> {
    const dir = join(this.path, 'Projects'), wanted = new Map(projects.map(p => [p.name, p.memoryDir]));
    for (const name of await readdir(dir)) {
      const link = join(dir, name); if (!(await lstat(link)).isSymbolicLink()) continue;
      let target = ''; try { target = await readlink(link); } catch { /* broken link */ }
      const want = wanted.get(name); if (want && samePath(target, want) && existsSync(want)) { wanted.delete(name); continue; }
      await removeLink(link);
    }
    for (const [name, target] of wanted) await symlink(target, join(dir, name), 'junction');
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/vault.test.ts`
Expected: PASS, 11 tests. If the stale-junction test fails on `readlink` returning a `\\?\` prefixed path, the `.toLowerCase().toContain(...)` assertion still holds; if `unlink` throws `EPERM` on a junction and `rmdir` also fails, replace `removeLink` with `rmdir` first then `unlink` and rerun.

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit -p tsconfig.electron.json`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add electron/vault.ts tests/vault.test.ts
git commit -m "feat(vault): scan Claude memory folders into an Obsidian vault of junctions and hubs

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Bridge calls, sidebar section, README

**Files:**
- Modify: `shared/types.ts` (`BridgeApi`)
- Modify: `electron/preload.ts`
- Modify: `electron/main.ts`
- Modify: `src/App.tsx`
- Modify: `src/styles.css`
- Modify: `README.md`
- Modify: `tests/e2e.spec.ts`

**Interfaces:**
- Consumes: `MemoryVault` from Task 2, `VaultInfo` from Task 1.
- Produces: bridge methods `vaultInfo(): Promise<VaultInfo>`, `openVault(): Promise<void>`, `showVaultFolder(): Promise<void>`; IPC channels `bridge:vault-info`, `bridge:open-vault`, `bridge:show-vault-folder`; the `vault` instance in `main.ts` that the Vault pane plan extends.

- [ ] **Step 1: Extend `BridgeApi`**

In `shared/types.ts`, add `VaultInfo` to the imports used by `BridgeApi` (same file, no import needed) and append inside the `BridgeApi` interface, after `cancelChat`:

```ts
  vaultInfo(): Promise<VaultInfo>;
  openVault(): Promise<void>;
  showVaultFolder(): Promise<void>;
```

- [ ] **Step 2: Wire preload**

In `electron/preload.ts`, after the `cancelChat` line inside `bridge`:

```ts
  vaultInfo:()=>ipcRenderer.invoke('bridge:vault-info'),
  openVault:()=>ipcRenderer.invoke('bridge:open-vault'),
  showVaultFolder:()=>ipcRenderer.invoke('bridge:show-vault-folder'),
```

- [ ] **Step 3: Wire main**

In `electron/main.ts`:

Change the electron import to include `shell`:
```ts
import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent, type IpcMainEvent } from 'electron';
```
Add after the `ProviderClient` import:
```ts
import { MemoryVault } from './vault';
```
Add after the `stateStore` line:
```ts
const vault=new MemoryVault(join(DEFAULT_ROOT,'AlphaCode Vault'),process.env.CLAUDE_CONFIG_DIR?resolve(process.env.CLAUDE_CONFIG_DIR):join(DEFAULT_ROOT,'.claude'),join(process.env.LOCALAPPDATA||join(DEFAULT_ROOT,'AppData','Local'),'Programs','Obsidian','Obsidian.exe'),join(app.getPath('appData'),'obsidian','obsidian.json'),providers);
```
Add at the end of `registerIpc()`:
```ts
  handle('bridge:vault-info',()=>vault.info());
  handle('bridge:open-vault',()=>shell.openExternal(vault.obsidianInstalled()?`obsidian://open?path=${encodeURIComponent(vault.path)}`:'https://obsidian.md/download'));
  handle('bridge:show-vault-folder',async()=>{const problem=await shell.openPath(vault.path);if(problem)throw new Error(problem);});
```
In the `app.whenReady().then(async()=>{...})` block, after `await createWindow();` add:
```ts
void vault.scan();setInterval(()=>void vault.scan(),5*60*1000);
```

- [ ] **Step 4: Sidebar section**

In `src/App.tsx`:

Add `Brain` to the lucide import list. Add `VaultInfo` to the type import from `../shared/types`.

Inside `App()`, after the `useState` line that declares `statePath`, add:
```tsx
  const [vault,setVault]=useState<VaultInfo|null>(null);
  const refreshVault=()=>{if(!window.bridge)return;window.bridge.vaultInfo().then(setVault).catch(e=>setVault({path:'',projects:0,notes:0,obsidian:false,scannedAt:'',message:String(e)}));};
  useEffect(()=>{refreshVault();window.addEventListener('focus',refreshVault);return()=>window.removeEventListener('focus',refreshVault);},[]);
```
Directly after the closing `</section>` of the `profiles-section` (before `</aside>}`), add:
```tsx
      <section className="vault-section"><div className="section-heading"><span>Claude memory</span></div>
        <div className="vault-meta"><span>{vault?`${vault.projects} projects · ${vault.notes} notes`:'Scanning…'}</span>{vault?.path&&<span title={vault.path}>{vault.path}</span>}</div>
        <div className="vault-actions"><button className="primary" onClick={()=>window.bridge.openVault().catch(e=>report(String(e)))}><Brain size={13}/>{vault?.obsidian?'Open in Obsidian':'Get Obsidian'}</button><button className="ghost" onClick={()=>window.bridge.showVaultFolder().catch(e=>report(String(e)))}>Show folder</button></div>
        {vault?.message&&<div className="vault-message">{vault.message}</div>}
      </section>
```

- [ ] **Step 5: Styles**

Append to `src/styles.css`:
```css
.vault-section{margin-top:18px}.vault-meta{display:flex;flex-direction:column;gap:3px;font-size:11px;color:#8c99a8;margin-bottom:8px}.vault-meta span:last-child{overflow-wrap:anywhere;color:#6f7b88}.vault-actions{display:flex;gap:6px;align-items:center;flex-wrap:wrap}.vault-message{font-size:11px;line-height:1.4;color:#e0a16b;margin-top:6px;overflow-wrap:anywhere}
```

- [ ] **Step 6: README**

In `README.md`:

In the Contents list, after `   - [Sidebar: Local model profiles](#sidebar-local-model-profiles)` add:
```
   - [Sidebar: Claude memory](#sidebar-claude-memory)
```
After the `### Sidebar: Local model profiles` section (before `### Pane header and footer`), add:
```markdown
### Sidebar: Claude memory

Claude Code keeps a small memory for every project it works in: Markdown notes it writes on
its own as it learns your preferences and your projects. AlphaCode gathers all of those folders
into one Obsidian vault so you can read, search, and graph everything Claude remembers. The
section shows how many projects and notes the vault holds and where it lives.

**Open in Obsidian** opens the vault in Obsidian. The first time, Obsidian asks whether to open
the folder as a vault; say yes and it stays in your vault list. If Obsidian is not installed the
button reads **Get Obsidian** and opens the free download page. Obsidian is optional and needs
no account; AlphaCode works exactly the same without it. **Show folder** opens the vault in
Explorer. See [Claude memory vault](#claude-memory-vault) for what is inside.
```
In `## Where your data lives`, after the bullet list and before `## Troubleshooting`, add:
```markdown
### Claude memory vault

```
%USERPROFILE%\AlphaCode Vault\
```

The vault contains no copies. Each folder under `Projects\` is a directory junction to the real
memory folder Claude Code keeps under `%USERPROFILE%\.claude\projects\<project>\memory\`, so a
note Claude writes appears in the vault at once, and a note you edit or delete in Obsidian is
what Claude reads the next time it starts in that project. AlphaCode rescans on launch and every
five minutes: it adds junctions for new projects, removes junctions whose project is gone, and
rewrites its own index notes (`Home.md`, one note per project under `Projects\`, one note per
memory type under `Types\`). Those index notes carry `generated: alphacode` in their frontmatter;
a file without that marker is never overwritten. Nothing inside Claude's own folders is written
by AlphaCode.
```

- [ ] **Step 7: End-to-end check that the section renders**

In `tests/e2e.spec.ts`, inside the first test that inspects the sidebar (the one asserting `.pane-list-name` contents, around line 41), add after that assertion:
```ts
  await expect(page.locator('.vault-section .section-heading')).toHaveText('Claude memory');
  await expect(page.locator('.vault-section .vault-meta')).toContainText(/\d+ projects · \d+ notes/);
```

- [ ] **Step 8: Build, test, run**

Run: `npm run build && npm test`
Expected: build clean, all Vitest suites pass.

Run: `npm run test:e2e`
Expected: PASS. The e2e data dir is isolated, so the scan runs against the real `%USERPROFILE%\.claude`, which exists on the development machine; on a machine without it the vault shows `0 projects · 0 notes` and the regex still matches.

Run: `npm start`, confirm the sidebar shows the section, click **Open in Obsidian**, confirm Obsidian opens the vault and the graph view shows notes clustered around project hubs. Then close the app.

- [ ] **Step 9: Commit**

```bash
git add shared/types.ts electron/preload.ts electron/main.ts src/App.tsx src/styles.css README.md tests/e2e.spec.ts
git commit -m "feat(vault): Claude memory sidebar section with Obsidian open and folder actions

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```
