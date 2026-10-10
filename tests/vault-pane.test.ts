import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildGraph, buildMessages, COMMAND, matchTargets, nameKey, parseAnswer, pickNotes, scoreNote, tokens, type NoteMeta } from '../shared/vault';
import { MemoryVault } from '../electron/vault';
import type { ChatMessage, LocalProfile, VaultTarget } from '../shared/types';

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
