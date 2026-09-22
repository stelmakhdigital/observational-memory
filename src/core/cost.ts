/**
 * Cost accounting (FR-6): the session cost is the sum of ALL om.cost entries
 * across the whole ledger (every branch) — real money never decreases under
 * tree navigation (FR-6.2).
 * See ARCHITECTURE.md §4.7.
 */
import type { CostEntry, Role, TypedLedgerEntry } from './types.js';

export interface CostSummary {
  totalUsd: number;
  runs: number;
  byRole: Record<Role, { usd: number; runs: number }>;
}

/** Sum cost entries (all branches). Deterministic order-independent. */
export function sumCosts(entries: readonly TypedLedgerEntry<'om.cost'>[]): CostSummary {
  const byRole: Record<Role, { usd: number; runs: number }> = {
    observer: { usd: 0, runs: 0 },
    consolidator: { usd: 0, runs: 0 },
    extractor: { usd: 0, runs: 0 },
    reflect: { usd: 0, runs: 0 },
  };
  let totalUsd = 0;
  let runs = 0;
  for (const e of entries) {
    const c: CostEntry = e.data;
    if (!Number.isFinite(c.usd)) continue; // corrupt: skip (NFR-1)
    totalUsd += c.usd;
    byRole[c.role].usd += c.usd;
    byRole[c.role].runs += 1;
    runs += 1;
  }
  return {
    totalUsd,
    runs,
    byRole,
  };
}
