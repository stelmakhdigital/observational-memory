/**
 * Progress: the observation watermark (FR-1.3, ARCHITECTURE §4.2).
 *
 * The chunker watermark is the MAXIMUM coversUpToId (message id) across ALL
 * committed observations (active + tombstoned), not the last-committed one:
 * observers finish out of order (parallel pure mappers), so a late-arriving
 * result for an older slice must not move progress backwards. Consolidated
 * (tombstoned) history is still processed, so its watermarks must survive.
 *
 * Contract (adapter responsibility): message ids must be monotonically
 * comparable — lexicographic order equals chronological order (e.g. prefix
 * ids with a creation counter). PiSubprocessRunner/adapter enforce this.
 */
import { observationSeq } from '../ids.js';
import type { Observation } from '../types.js';

export interface Progress {
  /** Chunker watermark: last message id fully covered by committed observations. */
  coversUpToId: string;
  /** Highest observation-id seq (for id derivation). */
  maxSeq: number;
}

/** Compare two observation ids; <0 if a sorts before b. */
export function compareObsIds(a: string, b: string): number {
  const sa = observationSeq(a);
  const sb = observationSeq(b);
  // Malformed ids sort after well-formed ones (conservative: never regress).
  if (sa === -1 && sb === -1) return a < b ? -1 : a > b ? 1 : 0;
  if (sa === -1) return 1;
  if (sb === -1) return -1;
  if (sa !== sb) return sa - sb;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Highest committed observation id (by seq); '' when none. */
export function maxObsId(observations: readonly Observation[]): string {
  let best = '';
  for (const o of observations) {
    if (best === '' || compareObsIds(o.id, best) > 0) best = o.id;
  }
  return best;
}

/**
 * Watermark from the union of committed observations.
 * @param active   active pool observations
 * @param tombstoned all observations ever committed (for seq/watermark history)
 */
export function progressOf(
  active: readonly Observation[],
  tombstoned: readonly Observation[],
): Progress {
  let coversUpToId = '';
  let maxSeq = 0;
  const consider = (o: Observation) => {
    if (o.coversUpToId > coversUpToId) coversUpToId = o.coversUpToId;
    const s = observationSeq(o.id);
    if (s > maxSeq) maxSeq = s;
  };
  for (const o of active) consider(o);
  for (const o of tombstoned) consider(o);
  return { coversUpToId, maxSeq };
}
