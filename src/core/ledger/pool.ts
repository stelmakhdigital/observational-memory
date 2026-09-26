/**
 * Pool: the active observation buffer = committed observations minus tombstones
 * (FR-2). Deterministic fold over ledger entries in commit order.
 * See ARCHITECTURE.md §4.2.
 */
import type {
  Observation,
  ObservationPriority,
  TombstoneReport,
  TypedLedgerEntry,
} from '../types.js';

const PRIORITY_RANK: Record<ObservationPriority, number> = {
  critical: 0,
  important: 1,
  routine: 2,
};

/** Effective priority (older ledgers have no field → routine). */
export function priorityOf(o: Observation): ObservationPriority {
  return o.priority ?? 'routine';
}

/**
 * Deterministic priority order (v0.4): critical → important → routine; within
 * a class — commit order (stable, cache-friendly). Used for block rendering
 * and topK selection.
 */
export function orderByPriority(observations: readonly Observation[]): Observation[] {
  const withIdx = observations.map((o, i) => ({ o, i }));
  withIdx.sort((a, b) => {
    const d = PRIORITY_RANK[priorityOf(a.o)] - PRIORITY_RANK[priorityOf(b.o)];
    return d !== 0 ? d : a.i - b.i;
  });
  return withIdx.map((x) => x.o);
}

/**
 * Deterministic budget trim (v0.5, compaction.inject = topK): keep observations
 * by priority class (critical → important → routine); within a class the NEWEST
 * first, until the token budget is reached. The result is re-sorted into
 * stable priority order for rendering.
 */
export function trimToBudget(
  observations: readonly Observation[],
  budgetTokens: number,
): Observation[] {
  if (budgetTokens <= 0) return [];
  const byPriority = orderByPriority(observations);
  const tokensById = new Map(byPriority.map((o) => [o.id, o.tokenCount]));
  const kept = new Set<string>();
  let used = 0;
  for (const pr of ['critical', 'important', 'routine'] as ObservationPriority[]) {
    const classObs = byPriority.filter((o) => priorityOf(o) === pr).reverse(); // newest first
    for (const o of classObs) {
      if (kept.has(o.id)) continue;
      if (used + o.tokenCount > budgetTokens && kept.size > 0) break;
      kept.add(o.id);
      used += tokensById.get(o.id) ?? 0;
    }
  }
  return byPriority.filter((o) => kept.has(o.id));
}

export interface PoolState {
  /** Active observations in commit order. */
  observations: Observation[];
  /** Total estimated tokens of active observations. */
  tokens: number;
  /** Observation id → tombstone that removed it (for diagnostics). */
  tombstoned: Map<string, { by: string; at: string }>;
}

export interface PoolOptions {
  tombstoneBy?: string; // run id attribution, informational
}

/**
 * Fold ledger entries into the active pool.
 * @param observations entries of type 'om.observation' (commit order)
 * @param tombstones   entries of type 'om.tombstone' (commit order)
 */
export function foldPool(
  observations: readonly TypedLedgerEntry<'om.observation'>[],
  tombstones: readonly TypedLedgerEntry<'om.tombstone'>[],
): PoolState {
  const removed = new Set<string>();
  const tombstoned = new Map<string, { by: string; at: string }>();
  for (const t of tombstones) {
    const report: TombstoneReport = t.data;
    for (const id of report.observationIds) {
      removed.add(id);
      tombstoned.set(id, { by: t.meta?.runId ?? 'unknown', at: t.at });
    }
  }

  // n9 (/tree re-observe): a slice is identified by sourceRange.fromId. When
  // the watermark of a dead branch is not found in the current branch, the
  // same slice is re-observed under a NEW run and the new observations get
  // fresh ids — id-based dedupe alone would keep BOTH sets in the pool.
  // Rule (commit order): for each fromId only the LATEST run's observations
  // are active; earlier runs of the same slice are superseded. Same-run
  // siblings (one commit = several observations, same fromId) and other
  // slices (different fromId) are untouched.
  let latestRunByFromId: Map<string, string> | undefined;
  for (const e of observations) {
    const fromId = e.data.sourceRange?.fromId;
    const runId = e.meta?.runId;
    if (fromId === undefined || runId === undefined) continue; // legacy → id-only dedupe
    latestRunByFromId ??= new Map();
    latestRunByFromId.set(fromId, runId);
  }
  const superseded = new Set<string>();
  if (latestRunByFromId) {
    for (const e of observations) {
      const fromId = e.data.sourceRange?.fromId;
      const runId = e.meta?.runId;
      if (fromId === undefined || runId === undefined) continue;
      if (latestRunByFromId.get(fromId) !== runId) superseded.add(e.data.id);
    }
  }

  const seen = new Set<string>();
  const active: Observation[] = [];
  let tokens = 0;
  for (const e of observations) {
    const o = e.data;
    if (removed.has(o.id) || seen.has(o.id) || superseded.has(o.id)) continue; // dedupe by id + slice supersession
    seen.add(o.id);
    active.push(o);
    tokens += o.tokenCount;
  }
  return { observations: active, tokens, tombstoned };
}

/** Ids of the oldest `maxTokens` worth of active observations (FR-4.2). */
export function oldestAbove(
  pool: PoolState,
  maxTokens: number,
): { ids: string[]; tokens: number } {
  const ids: string[] = [];
  let tokens = 0;
  for (const o of pool.observations) {
    if (tokens >= maxTokens) break;
    ids.push(o.id);
    tokens += o.tokenCount;
  }
  return { ids, tokens };
}
