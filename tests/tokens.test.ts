import { describe, expect, it } from 'vitest';
import { transcriptPath, transcriptTokens } from '../electron/terminals';

describe('transcript tokens', () => {
  it('sums input, cache and output tokens over assistant lines and skips everything else', () => {
    const lines = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }),
      JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 2, cache_creation_input_tokens: 10, cache_read_input_tokens: 100, output_tokens: 5, output_tokens_details: { thinking_tokens: 0 } } } }),
      '{"usage": broken json',
      JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 1, output_tokens: 1 } } }),
    ].join('\n') + '\n';
    expect(transcriptTokens(lines)).toBe(119);
    expect(transcriptTokens('')).toBe(0);
  });
  it('names the transcript the way Claude Code does: every non-alphanumeric in the folder becomes a dash', () => {
    expect(transcriptPath('D:\\Dev\\ACO\\.claude\\worktrees\\task-p4-t8', 'abc')).toMatch(/[\\/]projects[\\/]D--Dev-ACO--claude-worktrees-task-p4-t8[\\/]abc\.jsonl$/);
  });
});
