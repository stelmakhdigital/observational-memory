import { describe, expect, it } from 'vitest';
import {
  detectGap,
  humanDuration,
  renderGapMarkers,
} from '../../src/core/gap-markers.js';
import { sumCosts } from '../../src/core/cost.js';
import type { Role, TypedLedgerEntry } from '../../src/core/types.js';

const D = (s: string) => new Date(s);

describe('detectGap', () => {
  const opts = { enabled: true, thresholdMs: 10 * 60 * 1000 };

  it('returns null when disabled or no prior activity', () => {
    expect(detectGap(null, D('2025-09-21T12:00:00Z'), opts)).toBeNull();
    expect(
      detectGap(D('2025-09-21T11:00:00Z'), D('2025-09-21T12:00:00Z'), { ...opts, enabled: false }),
    ).toBeNull();
  });

  it('returns null below threshold', () => {
    expect(detectGap(D('2025-09-21T11:55:00Z'), D('2025-09-21T12:00:00Z'), opts)).toBeNull();
  });

  it('detects a gap with ms and human duration', () => {
    const g = detectGap(D('2025-09-19T09:00:00Z'), D('2025-09-21T12:00:00Z'), opts);
    expect(g).not.toBeNull();
    expect(g!.ms).toBe(2 * 86_400_000 + 3 * 3_600_000);
    expect(g!.humanDuration).toBe('2 дня 3 часа');
  });
});

describe('humanDuration', () => {
  it('picks the two largest units', () => {
    expect(humanDuration(90 * 60_000)).toBe('1 час 30 минут');
    expect(humanDuration(3 * 86_400_000)).toBe('3 дня');
    expect(humanDuration(5000)).toBe('5 секунд');
  });

  it('handles pluralization edge cases (11-14)', () => {
    expect(humanDuration(11 * 60_000)).toBe('11 минут');
    expect(humanDuration(11 * 3_600_000)).toBe('11 часов');
    // unit ladder: 11 days renders as the two largest units
    expect(humanDuration(11 * 86_400_000)).toBe('1 неделя 4 дня');
    expect(humanDuration(2 * 60_000)).toBe('2 минуты');
  });

  it('sub-second → phrase', () => {
    expect(humanDuration(500)).toBe('меньше секунды');
  });
});

describe('renderGapMarkers', () => {
  it('renders list, empty → empty string', () => {
    const g = detectGap(D('2025-09-19T09:00:00Z'), D('2025-09-21T12:00:00Z'), {
      enabled: true,
      thresholdMs: 10 * 60 * 1000,
    })!;
    const s = renderGapMarkers([g]);
    expect(s).toContain('resumed after 2 дня 3 часа');
    expect(renderGapMarkers([])).toBe('');
  });
});

describe('sumCosts', () => {
  const cost = (runId: string, role: Role, usd: number): TypedLedgerEntry<'om.cost'> => ({
    type: 'om.cost',
    data: { runId, role, usd, at: '2025-09-21T00:00:00Z' },
    at: '2025-09-21T00:00:00Z',
    meta: { runId },
  });

  it('sums across roles and skips non-finite values', () => {
    const entries = [cost('r1', 'observer', 0.01), cost('r2', 'consolidator', 0.02), cost('r3', 'observer', NaN)];
    const s = sumCosts(entries);
    expect(s.totalUsd).toBeCloseTo(0.03);
    expect(s.runs).toBe(2); // NaN entry skipped
    expect(s.byRole.observer.usd).toBeCloseTo(0.01);
    expect(s.byRole.consolidator.usd).toBeCloseTo(0.02);
    expect(s.byRole.observer.runs).toBe(1); // NaN observer run not counted
  });

  it('empty → zero summary', () => {
    const s = sumCosts([]);
    expect(s.totalUsd).toBe(0);
    expect(s.runs).toBe(0);
  });
});
