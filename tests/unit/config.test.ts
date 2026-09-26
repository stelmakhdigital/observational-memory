import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, resolveConfig, validateConfig, type OmConfig } from '../../src/core/config.js';
import { OmError } from '../../src/core/types.js';

describe('resolveConfig', () => {
  it('returns defaults when no partial given', () => {
    const c = resolveConfig(null);
    expect(c).toEqual(DEFAULT_CONFIG);
  });

  it('deep-merges partial over defaults (nested models preserved)', () => {
    const c = resolveConfig({
      chunkTokens: 2500,
      models: { observer: { thinking: 'medium' } },
      gapMarkers: { thresholdMs: 60_000 },
    } as Partial<OmConfig>);
    expect(c.chunkTokens).toBe(2500);
    expect(c.models.observer.thinking).toBe('medium');
    expect(c.models.observer.id).toBe(DEFAULT_CONFIG.models.observer.id);
    expect(c.models.consolidator.id).toBe(DEFAULT_CONFIG.models.consolidator.id);
    expect(c.gapMarkers.thresholdMs).toBe(60_000);
    expect(c.gapMarkers.enabled).toBe(true);
    expect(c.chunkTokens).toBe(2500);
  });

  it('does not mutate DEFAULT_CONFIG', () => {
    resolveConfig({ chunkTokens: 1 });
    expect(DEFAULT_CONFIG.chunkTokens).toBe(5000);
  });

  it('throws config-invalid when consolidateAtPoolTokens <= poolTargetTokens', () => {
    expect(() =>
      resolveConfig({ poolTargetTokens: 20000, consolidateAtPoolTokens: 10000 }),
    ).toThrowError(OmError);
  });

  it('throws config-invalid with all problems listed', () => {
    expect(() =>
      resolveConfig({ chunkTokens: 0, tailTokens: 0, observerConcurrency: 0 } as Partial<OmConfig>),
    ).toThrow(/chunkTokens must be > 0; tailTokens must be > 0; observerConcurrency must be >= 1/);
  });
});

describe('validateConfig', () => {
  it('accepts defaults', () => {
    expect(() => validateConfig(DEFAULT_CONFIG)).not.toThrow();
  });

  it('accepts empty model ids (n11: inherit the host model)', () => {
    expect(DEFAULT_CONFIG.models.observer.id).toBe('');
    expect(DEFAULT_CONFIG.models.consolidator.id).toBe('');
    expect(() =>
      validateConfig({
        ...DEFAULT_CONFIG,
        models: { observer: { id: '' }, consolidator: { id: '', thinking: 'high' } },
      }),
    ).not.toThrow();
  });

  it('rejects missing model refs', () => {
    expect(() =>
      validateConfig({ ...DEFAULT_CONFIG, models: undefined as never }),
    ).toThrow(/models/);
  });
});

describe('M3 derived defaults (poolHardCapTokens / maxCompactBlockTokens)', () => {
  it('re-derives from related thresholds when the user overrides them', () => {
    const c = resolveConfig({ consolidateAtPoolTokens: 40000, compactAtContextTokens: 200000 });
    expect(c.poolHardCapTokens).toBe(120000); // 3 × 40000
    expect(c.maxCompactBlockTokens).toBe(80000); // min(0.4 × 200000, 120000)
    const c2 = resolveConfig({ compactAtContextTokens: 200000 });
    expect(c2.poolHardCapTokens).toBe(60000); // default: 3 × 20000
    expect(c2.maxCompactBlockTokens).toBe(60000); // min(80000, cap)
  });

  it('honors explicit overrides', () => {
    const c = resolveConfig({ poolHardCapTokens: 99999, maxCompactBlockTokens: 1234 });
    expect(c.poolHardCapTokens).toBe(99999);
    expect(c.maxCompactBlockTokens).toBe(1234);
  });

  it('rejects poolHardCapTokens below consolidateAtPoolTokens', () => {
    expect(() => resolveConfig({ consolidateAtPoolTokens: 10000, poolHardCapTokens: 5000 }))
      .toThrow(/poolHardCapTokens/);
  });

  it('rejects non-positive maxCompactBlockTokens', () => {
    expect(() => resolveConfig({ maxCompactBlockTokens: 0 })).toThrow(/maxCompactBlockTokens/);
  });
});
