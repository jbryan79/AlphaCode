import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, readlink, rm, rmdir, symlink, writeFile, lstat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryVault } from '../electron/vault';
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
  it('links to MEMORY.md only when Claude has written one', async () => {
    const f = await fixture(); await f.make().scan();
    expect(await readFile(join(f.vault, 'Projects', 'AlphaCode.md'), 'utf8')).toContain('[[Projects/AlphaCode/MEMORY|');
    expect(await readFile(join(f.vault, 'Projects', 'NaviStation_JB.md'), 'utf8')).not.toContain('MEMORY');
    await rm(f.root, { recursive: true, force: true });
  });
  it('survives a real folder or an odd name under Projects and still refreshes counts', async () => {
    const f = await fixture();
    await mkdir(join(f.vault, 'Projects', 'AlphaCode'), { recursive: true }); await writeFile(join(f.vault, 'Projects', 'AlphaCode', 'keep.md'), 'user data');
    await f.project('odd', 'D:\\odd\\weird.md', { 'w.md': memory('name: w\ndescription: d\nmetadata:\n  type: user') });
    const info = await f.make().scan();
    expect(info.projects).toBe(4); expect(info.notes).toBe(5);
    expect(info.message).toContain('AlphaCode');
    expect(await readFile(join(f.vault, 'Projects', 'AlphaCode', 'keep.md'), 'utf8')).toBe('user data');
    expect((await lstat(join(f.vault, 'Projects', 'NaviStation_JB'))).isSymbolicLink()).toBe(true);
    expect(await readFile(join(f.vault, 'Home.md'), 'utf8')).toContain('- [[Projects/weird.md|weird.md]] (1)');
    await rm(f.root, { recursive: true, force: true });
  });
  it('shares one in-flight scan and serves info() from the last result', async () => {
    const f = await fixture(); const v = f.make();
    const [a, b] = await Promise.all([v.scan(), v.scan()]); expect(a).toBe(b);
    expect(await v.info()).toBe(a);
    await rm(f.root, { recursive: true, force: true });
  });
});
