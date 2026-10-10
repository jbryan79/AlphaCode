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
export type { ChatMessage, VaultGraph, VaultTarget };
