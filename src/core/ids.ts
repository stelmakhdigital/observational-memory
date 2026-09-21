/**
 * Ids: deterministic, second-resolution observation ids derived at commit time
 * (the orchestrator owns id derivation; workers only emit content + minute ts).
 * See ARCHITECTURE.md §2.
 */

export interface IdContext {
  /** Highest id suffix seen in the ledger (monotonic within the session). */
  lastSeq: number;
  /** Optional monotonic clock for tests. */
  now?: () => number;
}

/**
 * Derive a unique observation id: `om-<yyyymmddhhmmss>-<seq>`.
 * Second-resolution timestamp + monotonic sequence guarantees uniqueness even
 * when several observations commit within the same second.
 */
export function nextObservationId(ctx: IdContext, at?: Date): string {
  const ms = (ctx.now ?? Date.now)();
  const d = at ?? new Date(ms);
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  const ts =
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
  const seq = ctx.lastSeq + 1;
  return `om-${ts}-${seq}`;
}

/** Parse the sequence from an observation id; -1 if malformed. */
export function observationSeq(id: string): number {
  const m = /^om-\d{14}-(\d+)$/.exec(id);
  return m?.[1] ? Number(m[1]) : -1;
}

/** Generate a unique run id: `run-<base36-time>-<rand4>`. */
export function newRunId(now?: () => number): string {
  const ms = (now ?? Date.now)();
  return `run-${ms.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}
