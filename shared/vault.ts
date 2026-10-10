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
  const m = /\n?[\s*_]*notes used[\s*_:]*(.*?)\s*$/i.exec(text);
  if (!m) return { answer: text.trim(), notes: contextNames };
  const named = m[1].split(/[,;]/).map(s => s.trim().replace(/^[\[*_`]+|[\]*_`]+$/g, '').toLowerCase()).filter(Boolean);
  return { answer: text.slice(0, m.index).trim(), notes: contextNames.filter(c => named.includes(c.toLowerCase())) };
}
/** A launch command: an action word, a name, and no question mark, so "Open questions about auth?" still reaches the model. */
export const COMMAND = /^\s*(launch|open|start)\s+([^?]+?)\s*$/i;
export const nameKey = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');
/** Per kind, only the best tier survives: exact beats prefix beats contains. Keys shorter than three characters match nothing. */
export function matchTargets(query: string, candidates: VaultTarget[]): VaultTarget[] {
  const q = nameKey(query); if (q.length < 3) return [];
  const tier = (c: VaultTarget): 0 | 1 | 2 | 3 => { const k = nameKey(c.name); return k === q ? 0 : k.startsWith(q) ? 1 : k.includes(q) ? 2 : 3; };
  const out: VaultTarget[] = [];
  for (const kind of ['project', 'obsidian', 'workspace'] as const) { const mine = candidates.filter(c => c.kind === kind).map(c => ({ c, t: tier(c) })).filter(x => x.t < 3), best = Math.min(...mine.map(x => x.t)); out.push(...mine.filter(x => x.t === best).map(x => ({ ...x.c, tier: x.t as 0 | 1 | 2 }))); }
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
export type { ChatMessage, VaultGraph, VaultTarget };
