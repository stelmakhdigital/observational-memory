import { describe, expect, it } from 'vitest';
import { nextObservationId, newRunId, observationSeq } from '../../src/core/ids.js';

describe('nextObservationId', () => {
  it('is deterministic for the same second and increments seq', () => {
    const ctx = { lastSeq: 1, now: () => new Date('2025-09-21T12:00:00Z').getTime() };
    const a = nextObservationId(ctx);
    expect(a).toBe('om-20250921120000-2');
    expect(observationSeq(a)).toBe(2);
  });

  it('keeps uniqueness when seq is derived from the previous id', () => {
    let lastSeq = 0;
    const seen = new Set<string>();
    const now = () => new Date('2025-09-21T12:00:00Z').getTime(); // same second
    for (let i = 0; i < 50; i++) {
      const id = nextObservationId({ lastSeq, now });
      lastSeq = observationSeq(id);
      expect(observationSeq(id)).toBe(lastSeq);
      expect(seen.has(id)).toBe(false);
      seen.add(id);
    }
  });
});

describe('observationSeq', () => {
  it('parses valid ids', () => {
    expect(observationSeq('om-20250921120000-7')).toBe(7);
  });
  it('returns -1 for malformed ids', () => {
    expect(observationSeq('garbage')).toBe(-1);
    expect(observationSeq('')).toBe(-1);
  });
});

describe('newRunId', () => {
  it('is unique across calls', () => {
    const a = newRunId();
    const b = newRunId();
    expect(a).not.toBe(b);
    expect(a.startsWith('run-')).toBe(true);
  });
});
