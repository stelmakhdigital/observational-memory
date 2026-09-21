/**
 * Configuration: defaults, deep merge, invariant validation (FR-9, NFR).
 * See docs/REQUIREMENTS.md §3 FR-9.
 */
import { OmError } from './types.js';
import type { ExtractorSpec } from './types.js';

export interface ModelRef {
  provider?: string;
  id: string;
  thinking?: 'off' | 'low' | 'medium' | 'high';
}

export interface GapMarkersConfig {
  enabled: boolean;
  /** Milliseconds of pause before a gap marker is emitted (default 10 min). */
  thresholdMs: number;
}

export interface OmConfig {
  /** New-history tokens per observer chunk (FR-1.1). */
  chunkTokens: number;
  /** Overlap context tokens passed to the observer for continuity. */
  chunkOverlapTokens: number;
  /** Buffer drains back toward this after consolidation (FR-4.2). */
  poolTargetTokens: number;
  /** Pool size that triggers a consolidation (FR-4.1). */
  consolidateAtPoolTokens: number;
  /** Context usage that triggers compaction (FR-3.1). */
  compactAtContextTokens: number;
  /** Verbatim tail size, snapped to a chunk boundary (FR-3.4). */
  tailTokens: number;
  /** JOURNEY.md pushed size; oldest segments compressed past this (FR-5.2). */
  journeyTargetTokens: number;
  observerConcurrency: number;
  models: {
    observer: ModelRef;
    consolidator: ModelRef;
    /** Optional; defaults to the consolidator model. */
    extractor?: ModelRef;
  };
  /** Structured extractors (Mastra-style, v2). Empty list disables extraction. */
  extractors: ExtractorSpec[];
  /** Power-user: disables all automatic triggers (FR-7.4). */
  passive: boolean;
  debugLog: boolean;
  gapMarkers: GapMarkersConfig;
}

export const DEFAULT_CONFIG: OmConfig = {
  chunkTokens: 5000,
  chunkOverlapTokens: 0,
  poolTargetTokens: 10000,
  consolidateAtPoolTokens: 20000,
  compactAtContextTokens: 100000,
  tailTokens: 20000,
  journeyTargetTokens: 1000,
  observerConcurrency: 4,
  models: {
    observer: { id: 'claude-sonnet-4-6', thinking: 'low' },
    consolidator: { id: 'claude-sonnet-4-6', thinking: 'medium' },
  },
  passive: false,
  debugLog: false,
  gapMarkers: { enabled: true, thresholdMs: 10 * 60 * 1000 },
  extractors: [
    {
      id: 'profile',
      name: 'User profile & preferences',
      description:
        'Stable facts about the user and their preferences that persist across sessions: '
        + 'communication language, coding style, stack, recurring workflows, do/don’t rules.',
    },
  ],
};

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Deep-merge `over` onto `base` (objects merged, arrays/other values replaced). */
export function mergeDeep<T>(base: T, over: unknown): T {
  if (!isObject(over) || !isObject(base)) {
    return (over === undefined ? base : (over as T)) as T;
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over)) {
    const b = (base as Record<string, unknown>)[k];
    out[k] = isObject(v) && isObject(b) ? mergeDeep(b, v) : v === undefined ? b : v;
  }
  return out as T;
}

/**
 * Validate invariants (FR-9.3). Throws OmError('config-invalid') on violation —
 * the extension must fail loudly at init, never silently misconfigure.
 */
export function validateConfig(c: OmConfig): void {
  const problems: string[] = [];
  if (!(c.chunkTokens > 0)) problems.push('chunkTokens must be > 0');
  if (c.chunkOverlapTokens < 0) problems.push('chunkOverlapTokens must be >= 0');
  if (!(c.poolTargetTokens > 0)) problems.push('poolTargetTokens must be > 0');
  if (!(c.consolidateAtPoolTokens > c.poolTargetTokens))
    problems.push('consolidateAtPoolTokens must be > poolTargetTokens');
  if (!(c.compactAtContextTokens > 0)) problems.push('compactAtContextTokens must be > 0');
  if (!(c.tailTokens > 0)) problems.push('tailTokens must be > 0');
  if (!(c.journeyTargetTokens > 0)) problems.push('journeyTargetTokens must be > 0');
  if (!(c.observerConcurrency >= 1)) problems.push('observerConcurrency must be >= 1');
  if (!c.models?.observer?.id || !c.models?.consolidator?.id)
    problems.push('models.observer.id and models.consolidator.id are required');
  if (c.gapMarkers.thresholdMs <= 0) problems.push('gapMarkers.thresholdMs must be > 0');
  if (!Array.isArray(c.extractors)) problems.push('extractors must be an array');
  else {
    const ids = new Set<string>();
    for (const e of c.extractors as ExtractorSpec[]) {
      if (!/^[a-z0-9_-]{1,64}$/.test(e?.id ?? '')) {
        problems.push(`extractor id must match [a-z0-9_-]{1,64}: ${String(e?.id)}`);
      } else if (ids.has(e.id)) {
        problems.push(`duplicate extractor id: ${e.id}`);
      } else {
        ids.add(e.id);
      }
      if (!e?.name || !e?.description) problems.push(`extractor ${String(e?.id)} needs name and description`);
    }
  }
  if (problems.length > 0) {
    throw new OmError(`Invalid observational-memory config: ${problems.join('; ')}`, 'config-invalid');
  }
}

/** Merge partial user config (global, then project) onto defaults and validate. */
export function resolveConfig(partial: Partial<OmConfig> | null | undefined): OmConfig {
  const merged = mergeDeep<OmConfig>(DEFAULT_CONFIG, partial ?? {});
  validateConfig(merged);
  return merged;
}
