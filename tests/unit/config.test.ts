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

  it('rejects missing model ids', () => {
    expect(() =>
      validateConfig({ ...DEFAULT_CONFIG, models: { observer: { id: '' }, consolidator: { id: 'x' } } }),
    ).toThrow(/models/);
  });
});
