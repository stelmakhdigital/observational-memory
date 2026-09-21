/**
 * Pool: the active observation buffer = committed observations minus tombstones
 * (FR-2). Deterministic fold over ledger entries in commit order.
 * See ARCHITECTURE.md §4.2.
 */
import type {
  Observation,
  TombstoneReport,
  TypedLedgerEntry,
} from '../types.js';

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

  const seen = new Set<string>();
  const active: Observation[] = [];
  let tokens = 0;
  for (const e of observations) {
    const o = e.data;
    if (removed.has(o.id) || seen.has(o.id)) continue; // dedupe by id (NFR-1)
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
