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

/**
 * Early activation (v2, Mastra-style): observe new history before the regular
 * chunk threshold when the situation changes — provider/model switch (prompt
 * cache is invalidated anyway) or user idle (buffer fills while waiting).
 */
export interface EarlyActivationConfig {
  enabled: boolean;
  /** Milliseconds of user silence before an idle early-observation. */
  idleMs: number;
  /** Minimum unobserved tokens for an early slice (below chunkTokens). */
  minUnobservedTokens: number;
}

/** Observation priority tagging (v0.4). */
export interface PriorityConfig {
  enabled: boolean;
}

/**
 * Compaction injection mode (v0.5):
 *  - full: render the whole pre-tail pool (default, cache-friendly);
 *  - topK: deterministic budget trim — critical first, then important,
 *    then routine (newest first within a class), up to topKBudgetTokens.
 */
export interface CompactionConfig {
  inject: 'full' | 'topK';
  topKBudgetTokens: number;
}

/**
 * Reflector (v0.6, sleep-time / Letta-style): a rare background worker that
 * reorganizes durable memory (topic merge/rename, INDEX, JOURNEY compression)
 * while the session is idle. Strictly rate-limited by cost and interval.
 */
export interface ReflectorConfig {
  enabled: boolean;
  /** Milliseconds of idle before a reflect pass is attempted. */
  idleMs: number;
  /** Minimum time between two reflect passes. */
  minIntervalMs: number;
}

/** Shared project-level memory (v0.7): <root>/shared topics, read-only. */
export interface SharedMemoryConfig {
  enabled: boolean;
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
  /**
   * Hard cap for the pool (audit M3). Above this, consolidation is forced on
   * every turn_end. Always ≥ consolidateAtPoolTokens. Default:
   * 3 × consolidateAtPoolTokens (re-derived in resolveConfig when the user
   * overrides consolidateAtPoolTokens but not this key).
   */
  poolHardCapTokens: number;
  /** Context usage that triggers compaction (FR-3.1). */
  compactAtContextTokens: number;
  /**
   * Auto-resume after an auto-compaction that left the task unfinished
   * (ported from pi-observational-memory, MIT): after the adapter's
   * compaction completes, a hidden "continue where you left off" message
   * triggers a new agent turn — but ONLY when the just-ended run did not
   * terminate cleanly (stopReason 'length' / non-retryable 'error'; the
   * per-run decision is made by the adapter, which owns the event shapes).
   * Manual compactions (/om:compact) never resume. Default: true.
   */
  resumeAfterMidRunCompaction: boolean;
  /**
   * Hard budget in tokens for the observations part of the compaction block
   * (audit M3); applies to BOTH inject modes — 'full' means "the whole pool,
   * but never more than this". Default: min(0.4 × compactAtContextTokens,
   * poolHardCapTokens) — the post-compaction context (block + tail) then stays
   * below the pre-compaction context (≥ compactAtContextTokens).
   */
  maxCompactBlockTokens: number;
  /** Verbatim tail size, snapped to a chunk boundary (FR-3.4). */
  tailTokens: number;
  /** JOURNEY.md pushed size; oldest segments compressed past this (FR-5.2). */
  journeyTargetTokens: number;
  observerConcurrency: number;
  models: {
    /**
     * `id: ''` (default) = inherit the HOST model (the model the agent itself
     * runs on): the pi adapter replaces an empty id with ctx.model at boot.
     * provider/thinking are still honored when set alongside an empty id.
     */
    observer: ModelRef;
    consolidator: ModelRef;
    /** Optional; defaults to the consolidator model. */
    extractor?: ModelRef;
    /** Optional; defaults to the consolidator model (v0.6). */
    reflect?: ModelRef;
  };
  /** Structured extractors (Mastra-style, v2). Empty list disables extraction. */
  extractors: ExtractorSpec[];
  /** Power-user: disables all automatic triggers (FR-7.4). */
  passive: boolean;
  debugLog: boolean;
  gapMarkers: GapMarkersConfig;
  earlyActivation: EarlyActivationConfig;
  /** Priority tagging of observations (v0.4). */
  priority: PriorityConfig;
  /** Compaction injection mode (v0.5). */
  compaction: CompactionConfig;
  /** Sleep-time reflector (v0.6). */
  reflector: ReflectorConfig;
  /** Shared project-level memory (v0.7). */
  shared: SharedMemoryConfig;
}

export const DEFAULT_CONFIG: OmConfig = {
  chunkTokens: 5000,
  chunkOverlapTokens: 0,
  poolTargetTokens: 10000,
  consolidateAtPoolTokens: 20000,
  // = 3 × consolidateAtPoolTokens (re-derived in resolveConfig, see above)
  poolHardCapTokens: 60000,
  compactAtContextTokens: 100000,
  resumeAfterMidRunCompaction: true,
  // = min(0.4 × compactAtContextTokens, poolHardCapTokens) (re-derived)
  maxCompactBlockTokens: 40000,
  tailTokens: 20000,
  journeyTargetTokens: 1000,
  observerConcurrency: 4,
  models: {
    // audit n11: '' = inherit the host model. A hardcoded cloud model as
    // default means every chunk = spawn + provider failure + retry + noise
    // for users whose provider is not configured.
    observer: { id: '', thinking: 'low' },
    consolidator: { id: '', thinking: 'medium' },
  },
  passive: false,
  debugLog: false,
  gapMarkers: { enabled: true, thresholdMs: 10 * 60 * 1000 },
  earlyActivation: { enabled: true, idleMs: 5 * 60 * 1000, minUnobservedTokens: 300 },
  priority: { enabled: true },
  compaction: { inject: 'full', topKBudgetTokens: 20000 },
  reflector: { enabled: true, idleMs: 30 * 60 * 1000, minIntervalMs: 6 * 60 * 60 * 1000 },
  shared: { enabled: true },
  extractors: [
    {
      id: 'profile',
      name: 'User profile & preferences',
      description:
        'Stable facts about the user and their preferences that persist across sessions: '
        + 'communication language, coding style, stack, recurring workflows, do/don’t rules.',
    },
    {
      id: 'current-task',
      name: 'Current task & next steps',
      description:
        'The CURRENT state of the work: the active task or goal, what was done to reach it, '
        + 'what is pending or blocked, and the immediate next step. Rendered at the head of the '
        + 'compaction block so the agent never loses the thread after compaction. Keep it short: '
        + 'an object with fields task (string), pending (string[]), nextStep (string), asOf (YYYY-MM-DD).',
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
  if (!(c.poolHardCapTokens > 0)) problems.push('poolHardCapTokens must be > 0');
  if (c.poolHardCapTokens < c.consolidateAtPoolTokens)
    problems.push('poolHardCapTokens must be >= consolidateAtPoolTokens');
  if (!(c.maxCompactBlockTokens > 0)) problems.push('maxCompactBlockTokens must be > 0');
  if (!c.models?.observer || !c.models?.consolidator)
    problems.push('models.observer and models.consolidator are required (id "" = inherit the host model)');
  for (const [role, ref] of Object.entries(c.models ?? {})) {
    if (ref && 'id' in ref && typeof ref.id !== 'string')
      problems.push(`models.${role}.id must be a string`);
  }
  if (c.gapMarkers.thresholdMs <= 0) problems.push('gapMarkers.thresholdMs must be > 0');
  if (c.earlyActivation.idleMs <= 0) problems.push('earlyActivation.idleMs must be > 0');
  if (c.earlyActivation.minUnobservedTokens <= 0)
    problems.push('earlyActivation.minUnobservedTokens must be > 0');
  if (c.compaction.inject !== 'full' && c.compaction.inject !== 'topK')
    problems.push("compaction.inject must be 'full' or 'topK'");
  if (!(c.compaction.topKBudgetTokens > 0)) problems.push('compaction.topKBudgetTokens must be > 0');
  if (!(c.reflector.idleMs > 0)) problems.push('reflector.idleMs must be > 0');
  if (!(c.reflector.minIntervalMs > 0)) problems.push('reflector.minIntervalMs must be > 0');
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
  const p = (partial ?? {}) as Partial<OmConfig>;
  const merged = mergeDeep<OmConfig>(DEFAULT_CONFIG, p);
  // Derived defaults (audit M3): the cap/budget track their related
  // thresholds when the user overrides the threshold but not the derived key.
  if (p.poolHardCapTokens === undefined) {
    merged.poolHardCapTokens = 3 * merged.consolidateAtPoolTokens;
  }
  if (p.maxCompactBlockTokens === undefined) {
    merged.maxCompactBlockTokens = Math.min(
      Math.floor(merged.compactAtContextTokens * 0.4),
      merged.poolHardCapTokens,
    );
  }
  validateConfig(merged);
  return merged;
}
