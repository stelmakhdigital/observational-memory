import { describe, expect, it } from 'vitest';
import { estimateTokens, estimateTokensOf } from '../../src/core/tokens.js';

describe('estimateTokens', () => {
  it('returns 0 for empty text and >=1 for non-empty', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('x')).toBeGreaterThanOrEqual(1);
  });

  it('is roughly chars/4 for prose', () => {
    const prose = 'The quick brown fox jumps over the lazy dog. '.repeat(10);
    const est = estimateTokens(prose);
    expect(est).toBeGreaterThan(prose.length / 4 / 1.3);
    expect(est).toBeLessThan(prose.length / 4 * 1.3);
  });

  it('estimates long code runs denser than prose (per char)', () => {
    const code = 'a'.repeat(400); // one unbroken 400-char run
    const prose = 'a b c d e f '.repeat(66); // ~400 chars with boundaries
    expect(estimateTokens(code)).toBeLessThan(estimateTokens(prose));
  });

  it('is deterministic', () => {
    const s = 'mix of text 123 и кириллица const x = () => 42;';
    expect(estimateTokens(s)).toBe(estimateTokens(s));
  });

  it('sums for arrays', () => {
    expect(estimateTokensOf(['abcd', 'efgh'])).toBe(estimateTokens('abcdefgh'));
  });
});
