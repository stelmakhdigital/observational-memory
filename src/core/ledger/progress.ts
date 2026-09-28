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
import type { Observation } from '../types.js';

export interface Progress {
  /** Chunker watermark: last message id fully covered by committed observations. */
  coversUpToId: string;
}

/**
 * Watermark from the union of committed observations.
 * @param active   active pool observations
 * @param tombstoned all observations ever committed (consolidated history still counts)
 */
export function progressOf(
  active: readonly Observation[],
  tombstoned: readonly Observation[],
): Progress {
  let coversUpToId = '';
  const consider = (o: Observation) => {
    if (o.coversUpToId > coversUpToId) coversUpToId = o.coversUpToId;
  };
  for (const o of active) consider(o);
  for (const o of tombstoned) consider(o);
  return { coversUpToId };
}
