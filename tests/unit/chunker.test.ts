import { describe, expect, it } from 'vitest';
import { MessageChunker, type OmMessage } from '../../src/core/chunker.js';

// 1 token per char — deterministic and easy to reason about.
const est = (t: string) => t.length;
const msgs = (...pairs: [string, string][]) =>
  pairs.map(([id, text]) => ({ id, text, tokens: text.length })) as OmMessage[];

const chunker = new MessageChunker({ chunkTokens: 10, estimate: est });
const chunkerOverlap = new MessageChunker({
  chunkTokens: 10,
  overlapTokens: 6,
  estimate: est,
});

describe('MessageChunker.next', () => {
  it('returns null when fresh history < chunkTokens', () => {
    const m = msgs(['m1', 'abcd'], ['m2', 'efgh']);
    expect(chunker.next(m, { coversUpToId: '', observedTokens: 0 })).toBeNull();
  });

  it('cuts the earliest message boundary reaching chunkTokens', () => {
    const m = msgs(['m1', 'abc'], ['m2', 'defghij'], ['m3', 'jklm']); // 3+7+4
    const c = chunker.next(m, { coversUpToId: '', observedTokens: 0 })!;
    expect(c.coversUpToId).toBe('m2'); // 3 <10, 3+7=10
    expect(c.text).toBe('abc\ndefghij');
    expect(c.tokens).toBe(10); // per-message sum (3+7)
  });

  it('includes a trailing small message when the boundary overshoots the budget', () => {
    const m = msgs(['m1', 'abc'], ['m2', 'def'], ['m3', 'ghij']); // 3+3+4
    const c = chunker.next(m, { coversUpToId: '', observedTokens: 0 })!;
    // 3+3=6 <10 → next boundary is after m3 (total 10); message is never split.
    expect(c.coversUpToId).toBe('m3');
    expect(c.text).toBe('abc\ndef\nghij');
    expect(c.tokens).toBe(10);
  });

  it('never splits a message: single oversized message is a whole slice', () => {
    const m = msgs(['m1', 'x'.repeat(30)]);
    const c = chunker.next(m, { coversUpToId: '', observedTokens: 0 })!;
    expect(c.coversUpToId).toBe('m1');
    expect(c.tokens).toBe(30);
  });

  it('resumes from the watermark', () => {
    const m = msgs(['m1', 'abc'], ['m2', 'def'], ['m3', 'ghijkl'], ['m4', 'mnopqrs']); // 3+3+6+7
    const c = chunker.next(m, { coversUpToId: 'm2', observedTokens: 6 })!;
    expect(c.coversUpToId).toBe('m4'); // 6 <10, 6+7=13
    expect(c.text).toBe('ghijkl\nmnopqrs');
  });

  it('returns null when post-watermark history < chunkTokens', () => {
    const m = msgs(['m1', 'abc'], ['m2', 'def'], ['m3', 'ghij']);
    expect(chunker.next(m, { coversUpToId: 'm2', observedTokens: 6 })).toBeNull(); // 4 < 10
  });

  it('re-observes from the beginning when watermark id is unknown (tree rollback)', () => {
    const m = msgs(['m3', 'ghij'], ['m4', 'mnopqrs']); // 4 + 7 = 11
    const c = chunker.next(m, { coversUpToId: 'm999', observedTokens: 99 })!;
    expect(c.coversUpToId).toBe('m4');
  });

  it('provides overlap context bounded by overlapTokens', () => {
    const m = msgs(['m1', 'abcdef'], ['m2', 'ghijkl'], ['m3', 'mnopqrs']);
    const c = chunkerOverlap.next(m, { coversUpToId: 'm1', observedTokens: 6 })!;
    expect(c.coversUpToId).toBe('m3'); // 6+7=13 >=10
    expect(c.overlapContext).toBe('abcdef'); // tail of pre-slice history, <= 6 tokens
  });

  it('has empty overlap when nothing before the slice', () => {
    const m = msgs(['m1', 'abcdef'], ['m2', 'ghijkl']);
    const c = chunkerOverlap.next(m, { coversUpToId: '', observedTokens: 0 })!;
    expect(c.overlapContext).toBe('');
  });
});
