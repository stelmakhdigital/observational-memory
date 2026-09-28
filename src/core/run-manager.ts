/**
 * RunManager: LLM-run lifecycle for the OmOrchestrator (S1 extraction).
 *
 * Owns everything about a single worker run's plumbing (NFR-1):
 *  - inFlight tracking (entries self-remove on settle, so quiescent drains
 *    terminate even for follow-up runs spawned while draining);
 *  - runWorker: one retry, then the error is recorded (om.lastError) and
 *    surfaced (om.lastError / onError) — failures never break the master;
 *  - commit failure handling (M6): a commit failure is NOT a worker failure —
 *    the commit is retried once without re-running the LLM;
 *  - run/cost bookkeeping (om.run / om.cost) and the onRunFinished event;
 *  - badSlices (E1): slices attempted but never committed — the shutdown
 *    final pump skips them;
 *  - committedForRun (R3): partial-commit idempotence.
 *
 * Domain decisions (what to commit, when) stay in the orchestrator — it
 * passes the commit callback to runWorker.
 */
import { OmError } from './types.js';
import type {
  EventSink,
  LedgerStore,
  ModelRunner,
  Role,
  WorkerInput,
  WorkerResult,
} from './types.js';

export interface InFlight {
  runId: string;
  role: Role;
  startedAt: string;
  promise: Promise<void>;
  /** Observer chunk provenance — drain fast path (FR-3.4, see mustWaitFor). */
  coversUpToId?: string;
  fromId?: string;
}

export interface RunManagerDeps {
  ledger: LedgerStore;
  runner: ModelRunner;
  sink: EventSink;
  now: () => Date;
  log: (m: string) => void;
  /** Orchestrator status re-emit after every run-state change. */
  onStatus: () => void;
}

/**
 * M6: compact rendering of an LLM result for om.lastError — the observations
 * texts verbatim, other roles as capped JSON (nothing important is lost).
 */
function summarizeWorkerResult(res: WorkerResult): string {
  if (res.observations && res.observations.length > 0) {
    return res.observations.map((d) => `- ${d.text}`).join('\n');
  }
  const rest: Record<string, unknown> = { ...res };
  delete rest.runId;
  delete rest.ok;
  delete rest.costUsd;
  delete rest.observations;
  delete rest.error;
  try {
    const s = JSON.stringify(rest) ?? '{}';
    return s.length > 2000 ? `${s.slice(0, 2000)}…` : s;
  } catch {
    return '(unserializable)';
  }
}

export class RunManager {
  private readonly ledger: LedgerStore;
  private readonly runner: ModelRunner;
  private readonly sink: EventSink;
  private readonly now: () => Date;
  private readonly log: (m: string) => void;
  private readonly onStatus: () => void;
  private _inFlight: InFlight[] = [];
  /**
   * E1 guard: coversUpToId of slices that were attempted but never committed
   * (worker failed after the retry, or the commit itself failed). The
   * shutdown final pump skips them — they are re-observed on a later cycle,
   * not re-run for free LLM cost at shutdown time.
   */
  private readonly badSlices = new Set<string>();

  constructor(d: RunManagerDeps) {
    this.ledger = d.ledger;
    this.runner = d.runner;
    this.sink = d.sink;
    this.now = d.now;
    this.log = d.log;
    this.onStatus = d.onStatus;
  }

  /** In-flight worker runs (read-only view; mutate only via RunManager). */
  get inFlight(): InFlight[] {
    return this._inFlight;
  }

  clearInFlight(): void {
    this._inFlight = [];
  }

  /**
   * Track a worker task in inFlight; the entry REMOVES ITSELF when settled so
   * quiescent drains (shutdown/compaction) terminate even for follow-up runs
   * spawned while draining.
   */
  trackTask(
    runId: string,
    role: Role,
    startedAt: string,
    task: Promise<void>,
    extra?: { coversUpToId?: string; fromId?: string },
  ): void {
    const tracked = task.finally(() => {
      const i = this._inFlight.findIndex((r) => r.runId === runId);
      if (i !== -1) this._inFlight.splice(i, 1);
    });
    this._inFlight.push({ runId, role, startedAt, promise: tracked, ...extra });
  }

  /**
   * Quiescent drain: wait until NOTHING is in flight. Follow-up workers
   * spawned while draining are awaited too (entries remove themselves on
   * settle, so the loop terminates). Shared by shutdown/drainForCompaction.
   */
  async drainInFlight(): Promise<void> {
    for (;;) {
      const inflight = this._inFlight.slice();
      if (inflight.length === 0) break;
      await Promise.allSettled(inflight.map((r) => r.promise));
    }
    this._inFlight = [];
  }

  // ---- E1: bad slices ------------------------------------------------------

  markBadSlice(coversUpToId: string): void {
    this.badSlices.add(coversUpToId);
  }

  clearBadSlice(coversUpToId: string): void {
    this.badSlices.delete(coversUpToId);
  }

  isBadSlice(coversUpToId: string): boolean {
    return this.badSlices.has(coversUpToId);
  }

  // ---- R3: partial-commit idempotence --------------------------------------

  /** R3: texts this run already committed (partial-commit idempotence). */
  committedForRun(runId: string): Set<string> {
    const committed = new Set<string>();
    for (const e of this.ledger.read<'om.observation'>('om.observation')) {
      if (e.meta?.runId === runId) committed.add(e.data.content);
    }
    return committed;
  }

  // ---- worker execution (NFR-1) --------------------------------------------

  runWorker(input: WorkerInput, onSuccess: (res: WorkerResult) => void): Promise<void> {
    const startedAt = this.now().toISOString();
    this.sink.onRunStarted({ runId: input.runId, role: input.role, startedAt });
    this.ledger.append({
      type: 'om.run',
      data: { runId: input.runId, role: input.role, status: 'started', at: startedAt },
      at: startedAt,
      meta: { runId: input.runId },
    });
    this.onStatus();

    const attempt = (retriesLeft: number): Promise<void> =>
      this.runner
        .run(input.role, input)
        .then((res) => {
          if (!res.ok) throw new Error(res.error ?? 'worker failed');
          this.recordRun(input.runId, input.role, 'ok', res.costUsd, startedAt);
          // M6: a COMMIT failure is NOT a worker failure. The .catch below
          // would retry the WHOLE worker — re-running the LLM and paying for it.
          // Instead the commit is retried once, synchronously, without the LLM.
          // If the commit ultimately fails: the LLM result is preserved in
          // om.lastError (data is not lost) and the slice is left UNCOVERED —
          // the watermark only moves on a successful commit, so the slice is
          // re-observed on a later cycle; foldPool's sourceRange.fromId dedup
          // (n9) guards against duplicates from a partially committed attempt.
          let commitErr: unknown = null;
          try {
            onSuccess(res);
          } catch (e) {
            commitErr = e;
            this.log(`commit for ${input.runId} failed, retrying commit once (no LLM re-run)`);
            try {
              onSuccess(res);
              commitErr = null; // retry succeeded
            } catch (e2) {
              commitErr = e2;
            }
          }
          if (commitErr !== null) this.handleCommitFailure(input, commitErr, res);
        })
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          if (retriesLeft > 0) {
            this.log(`worker ${input.runId} failed (${msg}), retrying once`);
            return attempt(retriesLeft - 1);
          }
          this.recordRun(input.runId, input.role, 'error', undefined, msg, startedAt);
          const badId = input.chunk?.coversUpToId;
          if (badId) this.markBadSlice(badId); // E1: shutdown must not re-run it
          const at = this.now().toISOString();
          this.ledger.append({
            type: 'om.lastError',
            data: { message: msg, at },
            at,
          });
          this.sink.onError(new OmError(msg, 'runner-failed'));
          this.onStatus();
        });
    return attempt(1);
  }

  /**
   * M6: final commit failure. The LLM run was recorded 'ok' (cost is real);
   * we only record the error with the result payload so nothing is lost.
   */
  private handleCommitFailure(input: WorkerInput, err: unknown, res: WorkerResult): void {
    const msg = err instanceof Error ? err.message : String(err);
    const badId = input.chunk?.coversUpToId;
    if (badId) this.markBadSlice(badId); // E1: shutdown must not re-run it
    const detail = `commit failed (run ${input.runId}, ${input.role}) after 1 commit-retry: ${msg};\nresult: ${summarizeWorkerResult(res)}`;
    const at = this.now().toISOString();
    try {
      this.ledger.append({ type: 'om.lastError', data: { message: detail, at }, at });
      this.sink.onError(new OmError(detail, 'commit-failed'));
    } catch (e) {
      this.log(`commit-failure recording failed: ${String(e)}`);
      return;
    }
    this.log(detail);
    this.onStatus();
  }

  private recordRun(
    runId: string,
    role: Role,
    status: 'ok' | 'error',
    costUsd: number | undefined,
    startedAt: string,
    error?: string,
  ): void {
    const at = this.now().toISOString();
    this.ledger.append({
      type: 'om.run',
      data: { runId, role, status, at, ...(error ? { error } : {}) },
      at,
      meta: { runId },
    });
    // Runs counter (audit, smoke-bug #2): EVERY successful worker run leaves
    // an om.cost mark — even at $0 (free/local models previously showed
    // "(0 runs)"). The cost sum is unaffected (0 + 0 = 0).
    if (status === 'ok') {
      const usd = typeof costUsd === 'number' && Number.isFinite(costUsd) && costUsd > 0 ? costUsd : 0;
      this.ledger.append({
        type: 'om.cost',
        data: { runId, role, usd, at },
        at,
        meta: { runId },
      });
    }
    // onRunFinished: the run's terminal state (ok with the worker result, or
    // the final error) — sinks may surface progress/costs. NFR-1: a sink
    // failure never breaks the run.
    try {
      this.sink.onRunFinished(
        { runId, role, startedAt, finishedAt: at, status, ...(error ? { error } : {}) },
        status === 'ok' ? { runId, ok: true, costUsd } : { runId, ok: false, error },
      );
    } catch (e) {
      this.log(`onRunFinished sink failed: ${String(e)}`);
    }
  }
}
