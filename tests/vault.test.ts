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
