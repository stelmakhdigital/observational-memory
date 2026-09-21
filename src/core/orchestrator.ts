/**
 * OmOrchestrator: the agent-agnostic heart of Observational Memory.
 *
 * Clocks (ARCHITECTURE §4.1):
 *  - onTurnEnd: observer pump (parallel, capped) + consolidator trigger (serial)
 *  - onAgentEnd: gap-marker detection + compaction (idle, threshold)
 *
 * All LLM work goes through ModelRunner (async, never blocks the master).
 * Failures never break the master session (NFR-1): one retry, then the error
 * is recorded (om.lastError) and visible in status.
 */
import { foldPool, oldestAbove } from './ledger/pool.js';
import { progressOf } from './ledger/progress.js';
import { renderCompactionBlock, selectBeforeTail } from './ledger/render.js';
import { renderMemoryMap } from './memory-store.js';
import { detectGap, gapMarkerId, renderGapMarkers } from './gap-markers.js';
import { sumCosts } from './cost.js';
import { estimateTokens } from './tokens.js';
import { nextObservationId, newRunId } from './ids.js';
import { OmError } from './types.js';
import type {
  Clock,
  CompactionBlock,
  EventSink,
  HistorySource,
  LedgerStore,
  MemoryRoot,
  ModelRunner,
  OmStatus,
  RunInfo,
  WorkerInput,
  WorkerResult,
} from './types.js';
import type { OmConfig } from './config.js';

export interface OrchestratorDeps {
  config: OmConfig;
  sessionId: string;
  /** Parent session id for fork/clone seeding (FR-4.4). */
  forkParentSessionId?: string;
  history: HistorySource;
  ledger: LedgerStore;
  runner: ModelRunner;
  memory: MemoryRoot;
  sink: EventSink;
  clock?: Clock;
  log?: (msg: string) => void;
}

interface InFlight {
  runId: string;
  role: 'observer' | 'consolidator';
  startedAt: string;
  promise: Promise<void>;
}

export class OmOrchestrator {
  private readonly cfg: OmConfig;
  private readonly sessionId: string;
  private readonly now: () => Date;
  private readonly log: (m: string) => void;
  private readonly estimate: (t: string) => number = estimateTokens;

  private enabled = false;
  private seeded = false;
  private inFlight: InFlight[] = [];
  private pendingChunks = new Set<string>();
  private consolidating = false;
  private lastGapMarkedFor: Date | null = null;
  private compactedForTokens = 0;

  constructor(private readonly d: OrchestratorDeps) {
    this.cfg = d.config;
    this.sessionId = d.sessionId;
    this.now = () => (d.clock ? d.clock.now() : new Date());
    this.log = d.log ?? (() => {});
  }

  // ---- gate (FR-7.2) -----------------------------------------------------

  /** Restore the persisted gate state (call on session start/resume). */
  restoreEnabled(): void {
    const entries = this.d.ledger.read<'om.enabled'>('om.enabled');
    const last = entries[entries.length - 1];
    if (last) this.enabled = last.data.enabled;
    this.emitStatus();
  }

  setEnabled(on: boolean): void {
    if (this.enabled === on) return;
    this.enabled = on;
    if (on) this.ensureSeeded();
    this.d.ledger.append({
      type: 'om.enabled',
      data: { enabled: on },
      at: this.now().toISOString(),
    });
    this.emitStatus();
    this.log(`enabled → ${on}`);
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  private ensureSeeded(): void {
    if (this.seeded || !this.d.forkParentSessionId) return;
    this.seeded = true;
    if (!this.d.memory.exists(this.sessionId)) {
      this.d.memory.seedFrom(this.d.forkParentSessionId, this.sessionId);
      this.log(`seeded memory from ${this.d.forkParentSessionId}`);
    }
  }

  // ---- clocks ------------------------------------------------------------

  onTurnEnd(): void {
    if (!this.enabled || this.cfg.passive) return;
    this.pumpObservers();
    this.maybeConsolidate();
  }

  async onAgentEnd(): Promise<void> {
    if (!this.enabled || this.cfg.passive) return;
    this.maybeMarkGap();
    const tokens = this.d.history.currentTokens();
    if (tokens >= this.cfg.compactAtContextTokens && tokens > this.compactedForTokens) {
      if (this.d.history.isIdle()) {
        this.compactedForTokens = tokens;
        await this.runCompaction();
      }
    }
  }

  // ---- observers (FR-1) ---------------------------------------------------

  private observersInFlight(): number {
    return this.inFlight.filter((r) => r.role === 'observer').length;
  }

  private pumpObservers(): void {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (this.observersInFlight() >= this.cfg.observerConcurrency) return;
      const wm = this.watermark();
      const chunk = this.d.history.nextChunk({
        coversUpToId: wm.coversUpToId,
        observedTokens: 0,
      });
      if (!chunk) return;
      // one observer per slice: the watermark moves only after the commit,
      // so the same slice would otherwise be launched up to `concurrency` times
      if (this.pendingChunks.has(chunk.coversUpToId)) return;
      this.startObserver(chunk.coversUpToId, chunk.text, chunk.overlapContext);
    }
  }

  private startObserver(coversUpToId: string, text: string, overlapContext: string): void {
    const runId = newRunId();
    const input: WorkerInput = {
      runId,
      role: 'observer',
      chunk: { coversUpToId, text, overlapContext },
    };
    this.pendingChunks.add(coversUpToId);
    const task = this.runWorker(input, (res) => this.commitObservations(runId, coversUpToId, res)).finally(
      () => {
        this.pendingChunks.delete(coversUpToId);
      },
    );
    this.inFlight.push({
      runId,
      role: 'observer',
      startedAt: this.now().toISOString(),
      promise: task,
    });
  }

  private commitObservations(runId: string, coversUpToId: string, res: WorkerResult): void {
    if (!this.enabled) {
      this.log(`discarding observations of ${runId} (disabled mid-run)`);
      return;
    }
    const parsed = res.observations ?? [];
    if (parsed.length === 0) return;
    const at = this.now().toISOString();
    for (const content of parsed) {
      const lastSeq = this.maxSeqForSecond();
      const id = nextObservationId({ lastSeq, now: () => this.now().getTime() });
      this.d.ledger.append({
        type: 'om.observation',
        data: {
          id,
          coversUpToId,
          content,
          tokenCount: this.estimate(content),
          createdAt: at,
        },
        at,
        meta: { runId },
      });
    }
    this.emitStatus();
  }

  private maxSeqForSecond(): number {
    // seq scoped to the current second keeps ids lexicographically ordered.
    const ts = this.secondStamp();
    let max = 0;
    for (const e of this.d.ledger.read<'om.observation'>('om.observation')) {
      const id = e.data.id;
      if (id.includes(`-${ts}-`) || id.startsWith(`om-${ts}-`)) {
        const m = /-(\d+)$/.exec(id);
        if (m?.[1] && Number(m[1]) > max) max = Number(m[1]);
      }
    }
    return max;
  }

  private secondStamp(): string {
    const d = this.now();
    const p = (n: number) => String(n).padStart(2, '0');
    return (
      `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
      `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`
    );
  }

  // ---- consolidator (FR-4) -------------------------------------------------

  private maybeConsolidate(): void {
    if (this.consolidating) return;
    const pool = this.pool();
    if (pool.tokens <= this.cfg.consolidateAtPoolTokens) return;
    this.consolidating = true;
    const oldest = oldestAbove(pool, this.cfg.poolTargetTokens);
    const runId = newRunId();
    const input: WorkerInput = {
      runId,
      role: 'consolidator',
      pool: {
        observations: pool.observations.slice(0, oldest.ids.length),
        sessionDir: this.d.memory.sessionDir(this.sessionId),
        journey: this.d.memory.readJourney(this.sessionId),
      },
    };
    const task = this.runWorker(input, (res) => this.commitConsolidation(runId, oldest.ids, res));
    this.inFlight.push({
      runId,
      role: 'consolidator',
      startedAt: this.now().toISOString(),
      promise: task.finally(() => {
        this.consolidating = false;
        this.emitStatus();
      }),
    });
  }

  private commitConsolidation(runId: string, allowedIds: string[], res: WorkerResult): void {
    if (!this.enabled) return;
    const c = res.consolidation;
    if (!c) return;
    const allowed = new Set(allowedIds);
    const consumed = c.tombstoneIds.filter((id) => allowed.has(id));
    const dropped = c.droppedIds.filter((id) => allowed.has(id));
    const all = [...consumed, ...dropped];
    if (all.length > 0) {
      // preserve the watermark: tombstoned history stays "processed" (FR-1.3)
      const poolObs = this.pool().observations;
      const tombstonedObs = poolObs.filter((o) => all.includes(o.id));
      const maxCoversUpToId = tombstonedObs.reduce(
        (m, o) => (o.coversUpToId > m ? o.coversUpToId : m),
        '',
      );
      const maxSeq = tombstonedObs.reduce((m, o) => {
        const s = /-(\d+)$/.exec(o.id)?.[1];
        return s && Number(s) > m ? Number(s) : m;
      }, 0);
      this.d.ledger.tombstone(all, {
        topics: c.topics,
        journeyChanged: c.journeyChanged,
        maxCoversUpToId,
        maxSeq,
      });
    }
    this.d.memory.renderIndex(this.sessionId);
    this.log(`consolidation ${runId}: tombstoned ${all.length} observations`);
    this.emitStatus();
  }

  // ---- gap markers (FR-8) --------------------------------------------------

  private maybeMarkGap(): void {
    const lastAt = this.d.history.lastMessageAt();
    const gap = detectGap(lastAt, this.now(), this.cfg.gapMarkers);
    if (!gap) return;
    // one marker per pause: skip if we already marked a gap covering this lastAt
    if (this.lastGapMarkedFor && lastAt !== null && lastAt <= this.lastGapMarkedFor) return;
    this.lastGapMarkedFor = lastAt;
    const seq = this.d.ledger.read<'om.gap-marker'>('om.gap-marker').length;
    const at = this.now().toISOString();
    this.d.ledger.append({
      type: 'om.gap-marker',
      data: { id: gapMarkerId(this.now(), seq), at, humanDuration: gap.humanDuration, ms: gap.ms },
      at,
    });
    this.emitStatus();
  }

  // ---- compaction (FR-3) ---------------------------------------------------

  private async runCompaction(): Promise<void> {
    await this.d.runner.drain?.();
    await Promise.allSettled(this.inFlight.map((r) => r.promise));
    this.inFlight = [];
    const block = this.compactBlock();
    this.d.sink.onCompactionBlock(block);
    this.log(`compaction block emitted (${block.observations ? block.observations.length : 0} chars)`);
    this.emitStatus();
  }

  forceCompact(): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    return this.runCompaction();
  }

  forceConsolidate(): void {
    if (!this.enabled || this.consolidating) return;
    this.consolidating = true;
    const pool = this.pool();
    const oldest = oldestAbove(pool, this.cfg.poolTargetTokens);
    if (oldest.ids.length === 0) {
      this.consolidating = false;
      return;
    }
    const runId = newRunId();
    const input: WorkerInput = {
      runId,
      role: 'consolidator',
      pool: {
        observations: pool.observations.slice(0, oldest.ids.length),
        sessionDir: this.d.memory.sessionDir(this.sessionId),
        journey: this.d.memory.readJourney(this.sessionId),
      },
    };
    const task = this.runWorker(input, (res) => this.commitConsolidation(runId, oldest.ids, res));
    this.inFlight.push({
      runId,
      role: 'consolidator',
      startedAt: this.now().toISOString(),
      promise: task.finally(() => {
        this.consolidating = false;
        this.emitStatus();
      }),
    });
  }

  compactBlock(): CompactionBlock {
    const pool = this.pool();
    const prog = this.watermark();
    const tailStart = this.d.history.tailStartIdFor?.(this.cfg.tailTokens) ?? prog.coversUpToId;
    const observations = selectBeforeTail(pool.observations, tailStart === '' ? '' : tailStart);
    const memoryMap = renderMemoryMap(this.d.memory.listTopics(this.sessionId));
    const journey = this.d.memory.readJourney(this.sessionId);
    const verbatimTail = this.d.history.tailVerbatim(tailStart, this.cfg.tailTokens);
    const gaps = this.d.ledger.read<'om.gap-marker'>('om.gap-marker').map((e) => ({
      at: new Date(e.at),
      lastAt: new Date(0),
      ms: e.data.ms,
      humanDuration: e.data.humanDuration,
    }));
    return renderCompactionBlock({
      observations,
      memoryMap,
      journey,
      verbatimTail,
      gapMarkers: renderGapMarkers(gaps),
      generatedAt: this.now().toISOString(),
    });
  }

  // ---- shared reads ----------------------------------------------------------

  private pool() {
    return foldPool(
      this.d.ledger.read<'om.observation'>('om.observation'),
      this.d.ledger.read<'om.tombstone'>('om.tombstone'),
    );
  }

  private watermark() {
    const obs = this.d.ledger.read<'om.observation'>('om.observation');
    const active = obs.map((e) => e.data);
    let { coversUpToId, maxSeq } = progressOf(active, []);
    // Watermark must survive tombstones (FR-1.3): consolidated history is still processed.
    for (const t of this.d.ledger.read<'om.tombstone'>('om.tombstone')) {
      if (t.data.maxCoversUpToId && t.data.maxCoversUpToId > coversUpToId) {
        coversUpToId = t.data.maxCoversUpToId;
      }
      if (t.data.maxSeq && t.data.maxSeq > maxSeq) maxSeq = t.data.maxSeq;
    }
    return { coversUpToId, maxSeq };
  }

  // ---- worker plumbing (NFR-1) ----------------------------------------------

  private runWorker(input: WorkerInput, onSuccess: (res: WorkerResult) => void): Promise<void> {
    const startedAt = this.now().toISOString();
    this.d.sink.onRunStarted({ runId: input.runId, role: input.role, startedAt });
    this.d.ledger.append({
      type: 'om.run',
      data: { runId: input.runId, role: input.role, status: 'started', at: startedAt },
      at: startedAt,
      meta: { runId: input.runId },
    });
    this.emitStatus();

    const attempt = (retriesLeft: number): Promise<void> =>
      this.d.runner
        .run(input.role, input)
        .then((res) => {
          if (!res.ok) throw new Error(res.error ?? 'worker failed');
          this.recordRun(input.runId, input.role, 'ok', res.costUsd);
          onSuccess(res);
        })
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          if (retriesLeft > 0) {
            this.log(`worker ${input.runId} failed (${msg}), retrying once`);
            return attempt(retriesLeft - 1);
          }
          this.recordRun(input.runId, input.role, 'error', undefined, msg);
          const at = this.now().toISOString();
          this.d.ledger.append({
            type: 'om.lastError',
            data: { message: msg, at },
            at,
          });
          this.d.sink.onError(new OmError(msg, 'runner-failed'));
          this.emitStatus();
        });
    return attempt(1);
  }

  private recordRun(runId: string, role: 'observer' | 'consolidator', status: 'ok' | 'error', costUsd?: number, error?: string): void {
    const at = this.now().toISOString();
    this.d.ledger.append({
      type: 'om.run',
      data: { runId, role, status, at, ...(error ? { error } : {}) },
      at,
      meta: { runId },
    });
    if (status === 'ok' && costUsd && costUsd > 0) {
      this.d.ledger.append({
        type: 'om.cost',
        data: { runId, role, usd: costUsd, at },
        at,
        meta: { runId },
      });
    }
  }

  // ---- status (FR-7.3) ------------------------------------------------------

  status(): OmStatus {
    const pool = this.pool();
    const costs = sumCosts(this.d.ledger.read<'om.cost'>('om.cost'));
    const lastErr = this.d.ledger.read<'om.lastError'>('om.lastError');
    const lastErrorEntry = lastErr[lastErr.length - 1];
    return {
      enabled: this.enabled,
      passive: this.cfg.passive,
      inFlight: this.inFlight.map((r) => ({ runId: r.runId, role: r.role, startedAt: r.startedAt })),
      activeObservations: pool.observations.length,
      poolTokens: pool.tokens,
      nextObserverInTokens: this.nextObserverProgress(),
      consolidationPending: this.consolidating,
      topicCount: this.d.memory.listTopics(this.sessionId).length,
      journeyTokens: this.estimate(this.d.memory.readJourney(this.sessionId)),
      contextTokens: this.safeContextTokens(),
      costUsd: costs.totalUsd,
      runs: costs.runs,
      lastError: lastErrorEntry ? { message: lastErrorEntry.data.message, at: lastErrorEntry.at } : null,
    };
  }

  private nextObserverProgress(): number | null {
    if (!this.enabled || this.cfg.passive) return null;
    try {
      const unobserved = this.d.history.unobservedTokens(this.watermark().coversUpToId);
      return Math.max(0, this.cfg.chunkTokens - unobserved);
    } catch {
      return null;
    }
  }

  private safeContextTokens(): number | null {
    try {
      return this.d.history.currentTokens();
    } catch {
      return null;
    }
  }

  // ---- lifecycle -------------------------------------------------------------

  /** Wait for all in-flight workers (graceful shutdown / pre-compaction). */
  async shutdown(): Promise<void> {
    await Promise.allSettled(this.inFlight.map((r) => r.promise));
    this.inFlight = [];
    await this.d.runner.drain?.();
  }

  private emitStatus(): void {
    try {
      this.d.sink.onStatus(this.status());
    } catch (e) {
      this.log(`status emit failed: ${String(e)}`);
    }
  }
}
