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
import { foldPool, oldestAbove, trimToBudget } from './ledger/pool.js';
import { progressOf } from './ledger/progress.js';
import { renderCompactionBlock, selectBeforeTail } from './ledger/render.js';
import { renderMemoryMap } from './memory-store.js';
import { detectGap, gapMarkerId, renderGapMarkers } from './gap-markers.js';
import { sumCosts } from './cost.js';
import { estimateTokens } from './tokens.js';
import { nextObservationId, newRunId } from './ids.js';
import { sanitizeObservation } from './sanitize.js';
import { recallSearch, renderRecallHits, buildSessionRecallDocs, type RecallHit, type RecallOptions } from './recall.js';
import { RunManager, type InFlight } from './run-manager.js';
import type {
  Clock,
  CompactionBlock,
  EventSink,
  HistorySource,
  LedgerStore,
  MemoryRoot,
  ModelRunner,
  Observation,
  OmStatus,
  WorkerInput,
  WorkerResult,
} from './types.js';
import type { OmConfig } from './config.js';

/** Built-in extractor id rendered at the head of the compaction block (v0.4). */
export const CURRENT_TASK_EXTRACTOR_ID = 'current-task';

/**
 * Render the current-task value (v0.4) deterministically:
 *  - string → as-is;
 *  - object → preferred fields (task, pending, nextStep, asOf, blocker),
 *    the rest appended as compact JSON (nothing is lost);
 *  - other → JSON.
 */
export function renderCurrentTask(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'object' && !Array.isArray(value)) {
    const v = { ...(value as Record<string, unknown>) };
    const lines: string[] = [];
    const take = (k: string) => {
      const val = v[k];
      if (typeof val === 'string' && val.trim()) {
        lines.push(`${k === 'asOf' ? 'as of' : k}: ${val.trim()}`);
        delete v[k];
      }
    };
    take('task');
    take('blocker');
    take('nextStep');
    take('asOf');
    const pending = v.pending;
    if (Array.isArray(pending) && pending.length > 0) {
      lines.push(`pending: ${pending.map((p) => String(p)).join('; ')}`);
      delete v.pending;
    }
    const rest = Object.entries(v).filter(([, val]) => val !== undefined && val !== null);
    if (rest.length > 0) lines.push(JSON.stringify(Object.fromEntries(rest), null, 2));
    return lines.join('\n');
  }
  return JSON.stringify(value, null, 2);
}

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

export class OmOrchestrator {
  private readonly cfg: OmConfig;
  private readonly sessionId: string;
  private readonly now: () => Date;
  private readonly log: (m: string) => void;
  private readonly estimate: (t: string) => number = estimateTokens;
  /** LLM-run lifecycle (S1): execution, retry, bookkeeping, quiescent drain. */
  private readonly runs: RunManager;

  private enabled = false;
  private seeded = false;
  private pendingChunks = new Set<string>();
  /**
   * R4: dispatch cursor — the furthest coversUpToId handed to an observer.
   * In-memory ONLY (never persisted): after a restart dispatching starts
   * from the committed watermark (safe: committed slices are not
   * re-observed). The committed watermark stays the source of truth for
   * "observed" semantics — compaction render / unobservedTokens count from
   * it, not from this cursor.
   */
  private dispatchedUpToId = '';
  /**
   * R4/M6: for each dispatched slice — the dispatch cursor BEFORE it was
   * handed out. A slice whose COMMIT ultimately fails rolls the cursor back
   * to its origin so the next pump re-observes it (M6 contract); a slice
   * whose WORKER failed does not (anti cost-loop — it is skipped).
   */
  private readonly sliceOrigins = new Map<string, string>();
  /**
   * R5: per-second observation seq counters (replaced the O(n) full-ledger
   * scan in maxSeqForSecond). Rebuilt once at construction (one read),
   * updated on every committed observation (O(1)).
   */
  private readonly seqBySecond = new Map<string, number>();
  private consolidating = false;
  private extracting = false;
  private lastGapMarkedFor: Date | null = null;
  /**
   * E1: total history tokens at the moment of the last observer pump
   * (`unobservedTokens('')` — everything). shutdown uses it to decide whether
   * new history arrived after the last pump (the tail race).
   */
  private lastPumpedTotalTokens = 0;
  private compactedForTokens = 0;
  /**
   * Auto-resume (FR-3): the just-ended agent run left the task unfinished
   * (adapter decision from the agent_end event); consumed by the next
   * auto-compaction. Manual compactions never see a stale flag: it is set
   * immediately before the auto runCompaction and cleared after every emit.
   */
  private pendingResume = false;
  /** Set in onAgentEnd; fed into pendingResume on the next auto-compaction. */
  private lastRunUnfinished = false;
  private earlyTimer: ReturnType<typeof setTimeout> | null = null;
  private reflectTimer: ReturnType<typeof setTimeout> | null = null;
  private reflecting = false;

  constructor(private readonly d: OrchestratorDeps) {
    this.cfg = d.config;
    this.sessionId = d.sessionId;
    this.now = () => (d.clock ? d.clock.now() : new Date());
    this.log = d.log ?? (() => {});
    this.runs = new RunManager({
      ledger: d.ledger,
      runner: d.runner,
      sink: d.sink,
      now: this.now,
      log: this.log,
      onStatus: () => this.emitStatus(),
      onLedgerChange: () => this.invalidateStatusCache(),
      onCommitFailure: (input) => this.onSliceCommitFailed(input),
    });
    // R9: gap-marker dedup must survive host restarts — restore the already
    // marked pause from the ledger (the marker stores the previous message
    // time; older markers without prevAt fall back to their write time).
    try {
      const markers = this.d.ledger.read<'om.gap-marker'>('om.gap-marker');
      const last = markers[markers.length - 1];
      if (last) this.lastGapMarkedFor = new Date(last.data.prevAt ?? last.at);
    } catch (e) {
      this.log(`gap-marker restore failed: ${String(e)}`);
    }
    // R5: rebuild the per-second seq counters from the ledger (one read) so
    // append-time id derivation is O(1). A restarted orchestrator continues
    // the seq counter from the existing entries (no id collisions).
    try {
      for (const e of d.ledger.read<'om.observation'>('om.observation')) {
        this.trackObsId(e.data.id);
      }
    } catch (e) {
      this.log(`seq rebuild failed: ${String(e)}`);
    }
  }

  /** R5: remember an observation id's seq in the per-second counter. */
  private trackObsId(id: string): void {
    const m = /^om-(\d{14})-(\d+)$/.exec(id);
    if (!m) return;
    const seq = Number(m[2]);
    const prev = this.seqBySecond.get(m[1]!);
    if (prev === undefined || seq > prev) this.seqBySecond.set(m[1]!, seq);
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
    this.invalidateStatusCache();
    this.emitStatus();
    this.log(`enabled → ${on}`);
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  private ensureSeeded(): void {
    if (this.seeded || !this.d.forkParentSessionId) return;
    // The seed flag inside seedFrom is the idempotence guard (the session dir
    // itself may already exist, e.g. the ledger created it — FR-4.4).
    // R8: the flag is set only AFTER a successful call — a failing seedFrom
    // (fs error) must be retried on the next enable; NFR-1: a seed failure
    // never breaks the master session.
    try {
      const did = this.d.memory.seedFrom(this.d.forkParentSessionId, this.sessionId);
      this.seeded = true;
      if (did) this.log(`seeded memory from ${this.d.forkParentSessionId}`);
    } catch (e) {
      this.log(`seed from ${this.d.forkParentSessionId} failed (will retry on next enable): ${String(e)}`);
    }
  }

  // ---- clocks ------------------------------------------------------------

  onTurnEnd(): void {
    if (!this.enabled || this.cfg.passive) return;
    this.pumpObservers();
    this.maybeConsolidate();
    this.scheduleEarlyIdleCheck();
  }

  /**
   * Early activation (v2): the provider/model was switched — the prompt cache
   * is invalidated anyway, so observe pending history now if enough of it
   * exists (even below the regular chunk threshold).
   */
  onModelChange(): void {
    if (!this.enabled || this.cfg.passive) return;
    if (this.cfg.earlyActivation.enabled) this.earlyPump();
  }

  // ---- early activation (v2) -------------------------------------------------

  private scheduleEarlyIdleCheck(): void {
    if (!this.cfg.earlyActivation.enabled) return;
    if (this.earlyTimer) clearTimeout(this.earlyTimer);
    this.earlyTimer = setTimeout(() => {
      this.earlyTimer = null;
      this.maybeEarlyIdle();
    }, this.cfg.earlyActivation.idleMs);
    // don't keep the process alive for the early check
    (this.earlyTimer as { unref?: () => void }).unref?.();
  }

  private maybeEarlyIdle(): void {
    if (!this.enabled || this.cfg.passive) return;
    try {
      if (!this.d.history.isIdle()) return;
      const unobserved = this.d.history.unobservedTokens(this.watermark().coversUpToId);
      if (unobserved < this.cfg.earlyActivation.minUnobservedTokens) return;
      this.log(`early activation (idle, ${unobserved} unobserved tokens)`);
      this.earlyPump();
    } catch (e) {
      this.log(`early idle check failed: ${String(e)}`);
    }
  }

  /** One early observer slice with a lowered token threshold. */
  private earlyPump(): void {
    this.lastPumpedTotalTokens = this.safeTotalTokens();
    if (this.observersInFlight() >= this.cfg.observerConcurrency) return;
    // R4: dispatch from the dispatch cursor (not the raw committed watermark)
    // so an already-dispatched slice can never be handed out twice (with a
    // different boundary) by two triggers.
    const from = this.dispatchCursor();
    const chunk = this.d.history.nextChunk(
      { coversUpToId: from },
      { minTokens: this.cfg.earlyActivation.minUnobservedTokens },
    );
    if (!chunk) return;
    if (this.pendingChunks.has(chunk.coversUpToId)) return;
    this.log(`early chunk: ${chunk.tokens} tokens up to ${chunk.coversUpToId}`);
    this.dispatchSlice(chunk, from);
  }

  async onAgentEnd(opts?: { runUnfinished?: boolean }): Promise<void> {
    if (!this.enabled || this.cfg.passive) return;
    // Auto-resume input: the adapter decides from the agent_end event whether
    // the run ended with the task unfinished (stopReason 'length' / a
    // non-retryable 'error'); core treats it as an opaque flag.
    this.lastRunUnfinished = !!opts?.runUnfinished;
    this.maybeMarkGap();
    this.scheduleReflectIdleCheck();
    const tokens = this.d.history.currentTokens();
    if (tokens >= this.cfg.compactAtContextTokens && tokens > this.compactedForTokens) {
      if (this.d.history.isIdle()) {
        this.compactedForTokens = tokens;
        this.pendingResume = this.cfg.resumeAfterMidRunCompaction && this.lastRunUnfinished;
        await this.runCompaction();
      } else {
        this.log(`auto-compaction skipped: not idle at agent_end (tokens ${tokens})`);
      }
    }
  }

  // ---- observers (FR-1) ---------------------------------------------------

  private observersInFlight(): number {
    return this.runs.inFlight.filter((r) => r.role === 'observer').length;
  }

  private pumpObservers(): void {
    this.lastPumpedTotalTokens = this.safeTotalTokens();
    // R4: dispatch UP TO `observerConcurrency` slices per pump. The committed
    // watermark only moves on commit, so the pump works off the in-memory
    // dispatch cursor (dispatchCursor) — otherwise every iteration would
    // re-derive the same slice and stop after one observer.
    for (;;) {
      if (this.observersInFlight() >= this.cfg.observerConcurrency) return;
      const from = this.dispatchCursor();
      const chunk = this.d.history.nextChunk({ coversUpToId: from });
      if (!chunk) return;
      // belt & braces: an identical slice must never be dispatched twice
      // (e.g. early activation raced with this pump)
      if (this.pendingChunks.has(chunk.coversUpToId)) return;
      this.dispatchSlice(chunk, from);
    }
  }

  /**
   * R4: dispatch cursor = max(committed watermark, dispatchedUpToId). Never
   * behind the committed watermark (a late commit can only move that
   * forward), so committed history is never re-observed.
   */
  private dispatchCursor(): string {
    const wm = this.watermark().coversUpToId;
    return this.dispatchedUpToId > wm ? this.dispatchedUpToId : wm;
  }

  /** R4: hand a slice to a new observer, advancing the dispatch cursor. */
  private dispatchSlice(
    chunk: { coversUpToId: string; text: string; overlapContext: string; fromId: string; tokens: number },
    from: string,
  ): void {
    this.sliceOrigins.set(chunk.coversUpToId, from);
    if (chunk.coversUpToId > this.dispatchedUpToId) this.dispatchedUpToId = chunk.coversUpToId;
    this.startObserver(chunk.coversUpToId, chunk.text, chunk.overlapContext, chunk.fromId);
  }

  /**
   * R4/M6: a slice whose COMMIT ultimately failed (the LLM result is
   * preserved in om.lastError) must be re-observed on the next cycle — roll
   * the dispatch cursor back to where this slice was dispatched from. The
   * committed-watermark lower bound (dispatchCursor) prevents re-observing
   * committed history when later slices already committed. A WORKER failure
   * does NOT trigger this: the slice is skipped, not re-run (anti cost-loop).
   */
  private onSliceCommitFailed(input: WorkerInput): void {
    const covers = input.chunk?.coversUpToId;
    if (!covers) return;
    const origin = this.sliceOrigins.get(covers);
    if (origin === undefined) return;
    this.sliceOrigins.delete(covers);
    if (origin < this.dispatchedUpToId) this.dispatchedUpToId = origin;
  }

  private startObserver(coversUpToId: string, text: string, overlapContext: string, fromId?: string): void {
    const runId = newRunId();
    const input: WorkerInput = {
      runId,
      role: 'observer',
      chunk: { coversUpToId, text, overlapContext, ...(fromId ? { fromId } : {}) },
    };
    this.pendingChunks.add(coversUpToId);
    const task = this.runs.runWorker(
      input,
      (res) => this.commitObservations(runId, coversUpToId, fromId, res),
    ).finally(() => {
      this.pendingChunks.delete(coversUpToId);
    });
    this.runs.trackTask(runId, 'observer', this.now().toISOString(), task, { coversUpToId, fromId });
  }

  private commitObservations(runId: string, coversUpToId: string, fromId: string | undefined, res: WorkerResult): void {
    // the slice committed → it is no longer "bad" (E1 shutdown pump may pass it)
    this.runs.clearBadSlice(coversUpToId);
    // NOTE: sliceOrigins.delete(coversUpToId) happens ONLY after a fully
    // successful commit (end of this method) — a failed commit must keep
    // the origin for the R4/M6 dispatch-cursor rollback.
    if (!this.enabled) {
      this.log(`discarding observations of ${runId} (disabled mid-run)`);
      return;
    }
    const parsed = res.observations ?? [];
    if (parsed.length === 0) return;
    const at = this.now().toISOString();
    const sourceRange = fromId ? { fromId, toId: coversUpToId } : undefined;
    // R3: idempotent commit — if a previous attempt of THIS run committed a
    // PARTIAL slice before the append failed, those observations are already
    // in the ledger and must NOT be re-appended under fresh ids (the runId is
    // unchanged, so foldPool's same-run dedup would not evict them — dups).
    // Observation ids can't be matched across attempts (the seq counter
    // advances after every append), so we match by position + text: appends
    // are sequential, one ledger read, the volume is tiny (one chunk).
    const committed = this.runs.committedForRun(runId);
    for (let i = 0; i < parsed.length; i++) {
      const draft = parsed[i]!;
      const text = (draft?.text ?? '').trim();
      if (!text) continue;
      if (i < committed.size && committed.has(text)) continue; // R3: already committed
      const { quarantined, matched } = sanitizeObservation(text);
      if (quarantined) this.log(`observation quarantined (injection-like, ${matched})`);
      const lastSeq = this.maxSeqForSecond();
      const id = nextObservationId({ lastSeq, now: () => this.now().getTime() });
      this.trackObsId(id); // R5: keep the per-second counter current (O(1))
      this.d.ledger.append({
        type: 'om.observation',
        data: {
          id,
          coversUpToId,
          content: text,
          tokenCount: this.estimate(text),
          createdAt: at,
          priority: draft?.priority ?? 'routine',
          ...(quarantined ? { quarantined: true } : {}),
          ...(sourceRange ? { sourceRange } : {}),
        },
        at,
        meta: { runId },
      });
    }
    this.sliceOrigins.delete(coversUpToId); // commit fully succeeded
    this.invalidateStatusCache(); // R5: the pool just changed
    this.emitStatus();
  }

  private maxSeqForSecond(): number {
    // R5: O(1) — the per-second map is rebuilt at construction and updated
    // on every append (replaces the previous full-ledger scan per
    // observation). seq is scoped to the current second so ids stay
    // lexicographically ordered.
    return this.seqBySecond.get(this.secondStamp()) ?? 0;
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
    // audit M3: above the hard cap the consolidator is FORCED on every
    // turn_end (not just at the regular threshold). The real protection
    // against a permanently failing consolidator is the compaction-block
    // budget in compactionPlan — the pool may stay big, the context won't.
    const overCap = pool.tokens > this.cfg.poolHardCapTokens;
    if (pool.tokens <= this.cfg.consolidateAtPoolTokens && !overCap) return;
    if (overCap) {
      this.log(
        `pool (${pool.tokens} tokens) above hard cap (${this.cfg.poolHardCapTokens}) — forcing consolidation`,
      );
    }
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
        sharedTopics: this.sharedTopicsLine(),
      },
    };
    this.startRoleWorker('consolidating', input, (res) => this.commitConsolidation(runId, oldest.ids, res));
  }

  /**
   * Common role-worker launch (consolidator/extractor/reflect): flag on →
   * runWorker + trackTask → flag off + status re-emit when settled. The flags
   * stay in the orchestrator (domain state); only the launch template is here.
   */
  private startRoleWorker(
    flag: 'consolidating' | 'extracting' | 'reflecting',
    input: WorkerInput,
    commit: (res: WorkerResult) => void,
  ): void {
    this[flag] = true;
    const task = this.runs.runWorker(input, commit);
    this.runs.trackTask(input.runId, input.role, this.now().toISOString(),
      task.finally(() => {
        this[flag] = false;
        // R5: consolidator/extractor/reflector write topic/extracted/journey
        // files directly (outside our ledger) — re-read them on next status.
        this.invalidateStatusCache();
        this.emitStatus();
      }),
    );
  }

  /** Shared (project-level) topics as a reference line for the consolidator (v0.7). */
  private sharedTopicsLine(): string {
    try {
      const shared = this.d.memory.listSharedTopics();
      if (shared.length === 0) return '';
      return shared
        .map((t) => `- ${t.topic}${t.description ? `: ${t.description}` : ''}`)
        .join('\n');
    } catch {
      return '';
    }
  }

  private commitConsolidation(runId: string, allowedIds: string[], res: WorkerResult): void {
    if (!this.enabled) return;
    const c = res.consolidation;
    if (!c) return;
    const allowed = new Set(allowedIds);
    const consumed = c.tombstoneIds.filter((id) => allowed.has(id));
    const dropped = c.droppedIds.filter((id) => allowed.has(id));
    const all = [...consumed, ...dropped];
    let evidence: Observation[] = [];
    if (all.length > 0) {
      // preserve the watermark: tombstoned history stays "processed" (FR-1.3)
      const poolObs = this.pool().observations;
      const tombstonedObs = poolObs.filter((o) => all.includes(o.id));
      evidence = tombstonedObs;
      const maxCoversUpToId = tombstonedObs.reduce(
        (m, o) => (o.coversUpToId > m ? o.coversUpToId : m),
        '',
      );
      this.d.ledger.tombstone(all, {
        topics: c.topics,
        journeyChanged: c.journeyChanged,
        maxCoversUpToId,
      });
      this.invalidateStatusCache(); // R5: the pool just shrank
    }
    this.d.memory.renderIndex(this.sessionId);
    this.log(`consolidation ${runId}: tombstoned ${all.length} observations`);
    this.startExtraction('post-consolidation', evidence);
    this.emitStatus();
  }

  // ---- extractors (v2) -----------------------------------------------------

  /** Refresh structured extractor values from the active observation pool. */
  forceExtract(): void {
    this.startExtraction('manual');
  }

  private startExtraction(reason: 'post-consolidation' | 'manual', evidence?: Observation[]): void {
    if (!this.enabled || this.extracting || this.cfg.extractors.length === 0) return;
    // Post-consolidation: the pool is drained by the tombstone, so extract from
    // the just-consolidated observations (newest first). Manual: active pool.
    const observations =
      evidence && evidence.length > 0
        ? [...evidence].reverse()
        : reason === 'manual'
          ? [...this.pool().observations].reverse()
          : [];
    if (observations.length === 0) return;
    const current: Record<string, unknown> = {};
    for (const spec of this.cfg.extractors) {
      // includePrevious (v0.4, Mastra-style): by default the extractor sees the
      // stored value and merges incrementally; opt-out per spec.
      if (spec.includePrevious === false) continue;
      const v = this.d.memory.loadExtracted(this.sessionId, spec.id);
      if (v !== undefined) current[spec.id] = v;
    }
    const runId = newRunId();
    const input: WorkerInput = {
      runId,
      role: 'extractor',
      extract: {
        specs: this.cfg.extractors,
        current,
        observations,
        sessionDir: this.d.memory.sessionDir(this.sessionId),
      },
    };
    this.startRoleWorker('extracting', input, (res) => {
      const values = res.extraction ?? {};
      for (const spec of this.cfg.extractors) {
        if (Object.prototype.hasOwnProperty.call(values, spec.id)) {
          this.d.memory.saveExtracted(this.sessionId, spec.id, values[spec.id]);
        }
      }
      this.log(`extraction ${runId} (${reason}): saved ${Object.keys(values).length} values`);
    });
    this.log(`extraction started (${reason})`);
  }

  // ---- gap markers (FR-8) --------------------------------------------------

  private maybeMarkGap(): void {
    // R2: the pause to measure is BETWEEN the last two branch messages
    // (the user's pause before the current run). The old `now() - lastAt`
    // measured the duration of the run that JUST finished — not a pause.
    const [lastAt, prevAt] = this.d.history.lastTwoMessageAts();
    if (lastAt === null || prevAt === null) return;
    const gap = detectGap(lastAt, prevAt, this.cfg.gapMarkers);
    if (!gap) return;
    // one marker per pause: skip if we already marked a gap with the same
    // second-to-last message (dedup by prevAt)
    if (this.lastGapMarkedFor && prevAt <= this.lastGapMarkedFor) return;
    this.lastGapMarkedFor = prevAt;
    const seq = this.d.ledger.read<'om.gap-marker'>('om.gap-marker').length;
    const at = this.now().toISOString();
    this.d.ledger.append({
      type: 'om.gap-marker',
      // R9: prevAt (the pause's start point) is persisted so a restarted host
      // can restore the dedup state from the ledger.
      data: { id: gapMarkerId(this.now(), seq), at, prevAt: prevAt.toISOString(), humanDuration: gap.humanDuration, ms: gap.ms },
      at,
    });
    this.invalidateStatusCache();
    this.d.sink.onGapMarker?.({ at, humanDuration: gap.humanDuration, ms: gap.ms });
    this.emitStatus();
  }

  // ---- compaction (FR-3) ---------------------------------------------------

  private async runCompaction(): Promise<void> {
    // Auto-resume (FR-3): capture-and-clear BEFORE any await so a concurrent
    // manual compaction (forceCompact) can never pick up a stale flag.
    const shouldResume = this.pendingResume;
    this.pendingResume = false;
    // Quiescent drain: workers may spawn follow-ups (e.g. post-consolidation
    // extraction) after the snapshot; loop until nothing is in flight.
    //
    // R5 fast path (ported from pi-observational-memory's canSkipObserverWait,
    // MIT): an in-flight observer whose WHOLE slice lies in the verbatim tail
    // cannot change the rendered block — the tail keeps that history verbatim,
    // so its yet-uncommitted observations add nothing. Skip it (and skip the
    // runner drain: it would otherwise wait on the same subprocess anyway).
    const boundary = this.tailBoundaryId();
    let waited = false;
    for (;;) {
      const wait = this.runs.inFlight.filter((t) => this.mustWaitFor(t, boundary));
      if (wait.length === 0) break;
      waited = true;
      await Promise.allSettled(wait.map((r) => r.promise));
    }
    this.runs.clearInFlight();
    if (waited) await this.d.runner.drain?.();
    const block = this.compactBlock();
    this.d.sink.onCompactionBlock(block, { shouldResume });
    this.log(`compaction block emitted (${block.observations ? block.observations.length : 0} chars)`);
    this.emitStatus();
  }

  /**
   * May compaction skip waiting for this in-flight worker? Non-observers
   * (consolidator/extractor/reflect) always block the render. An observer
   * is skippable when its slice starts strictly AFTER the tail boundary
   * (fromId > boundary): the slice is then fully inside the verbatim tail.
   * We check fromId, not coversUpToId: an in-flight chunk straddling the
   * boundary would leave its pre-tail part in neither the block nor the tail.
   * Unknown provenance → conservative wait (the reference does the same).
   */
  private mustWaitFor(t: InFlight, boundary: string): boolean {
    if (t.role !== 'observer') return true;
    return !(t.fromId && t.fromId > boundary);
  }

  forceCompact(): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    return this.runCompaction();
  }

  forceConsolidate(): void {
    if (!this.enabled || this.consolidating) return;
    const pool = this.pool();
    const oldest = oldestAbove(pool, this.cfg.poolTargetTokens);
    if (oldest.ids.length === 0) return;
    const runId = newRunId();
    const input: WorkerInput = {
      runId,
      role: 'consolidator',
      pool: {
        observations: pool.observations.slice(0, oldest.ids.length),
        sessionDir: this.d.memory.sessionDir(this.sessionId),
        journey: this.d.memory.readJourney(this.sessionId),
        sharedTopics: this.sharedTopicsLine(),
      },
    };
    this.startRoleWorker('consolidating', input, (res) => this.commitConsolidation(runId, oldest.ids, res));
  }

  // ---- reflector (v0.6, sleep-time) -----------------------------------------

  /**
   * Sleep-time reflector (Letta-style): while the session is idle for
   * reflector.idleMs and the last reflect pass is older than minIntervalMs,
   * a 'reflect' worker reorganizes durable memory (topic merge/rename,
   * JOURNEY compression). Rare and rate-limited by design.
   */
  private scheduleReflectIdleCheck(): void {
    if (!this.cfg.reflector.enabled) return;
    if (this.reflectTimer) clearTimeout(this.reflectTimer);
    this.reflectTimer = setTimeout(() => {
      this.reflectTimer = null;
      this.maybeReflect();
    }, this.cfg.reflector.idleMs);
    (this.reflectTimer as { unref?: () => void }).unref?.();
  }

  private maybeReflect(): void {
    try {
      if (!this.enabled || this.cfg.passive || this.reflecting) return;
      if (!this.d.history.isIdle()) return;
      if (this.lastReflectAt() !== null &&
        this.now().getTime() - this.lastReflectAt()! < this.cfg.reflector.minIntervalMs) {
        return;
      }
      this.forceReflect();
    } catch (e) {
      this.log(`reflect check failed: ${String(e)}`);
    }
  }

  private lastReflectAt(): number | null {
    let last: number | null = null;
    for (const e of this.d.ledger.read<'om.run'>('om.run')) {
      if (e.data.role !== 'reflect') continue;
      const t = new Date(e.data.at).getTime();
      if (Number.isFinite(t) && (last === null || t > last)) last = t;
    }
    return last;
  }

  forceReflect(): void {
    if (!this.enabled || this.reflecting) return;
    const topics = this.d.memory.listTopics(this.sessionId).map((t) => t.file);
    const runId = newRunId();
    const input: WorkerInput = {
      runId,
      role: 'reflect',
      reflect: {
        sessionDir: this.d.memory.sessionDir(this.sessionId),
        topics,
        journey: this.d.memory.readJourney(this.sessionId),
        sharedTopics: this.sharedTopicsLine(),
      },
    };
    this.startRoleWorker('reflecting', input, (res) => this.commitReflection(runId, res));
    this.log(`reflect pass started (topics: ${topics.length})`);
  }

  private commitReflection(runId: string, res: WorkerResult): void {
    if (!this.enabled) return;
    const r = res.reflection;
    if (r) {
      this.d.memory.renderIndex(this.sessionId);
      this.log(`reflection ${runId}: touched ${r.topics.length} topics, journeyChanged=${r.journeyChanged}`);
    }
  }

  compactBlock(): CompactionBlock {
    return this.compactionPlan().block;
  }

  /** History seam (adapters clamp the compaction tail to the model window). */
  get history(): HistorySource {
    return this.d.history;
  }

  /**
   * Compaction plan (FR-3): the rendered block + the tail boundary id (last
   * message NOT included in the verbatim tail; '' when the tail covers
   * everything). Adapters use the boundary for e.g. firstKeptEntryId.
   */
  compactionPlan(): { block: CompactionBlock; tailBoundaryId: string } {
    const pool = this.pool();
    const tailBoundaryId = this.tailBoundaryId();
    let observations = selectBeforeTail(pool.observations, tailBoundaryId);
    // v0.5: deterministic injection modes; S7: the observations part of the
    // block is ALWAYS capped by maxCompactBlockTokens in BOTH modes — 'full'
    // means "the whole pool, but never more than the cap"; 'topK' uses the
    // same cap as an explicit selection budget (class/freshness selection is
    // the same trimToBudget).
    observations = trimToBudget(observations, this.cfg.maxCompactBlockTokens);
    // trimToBudget returns priority-ordered (critical → important → routine).
    const memoryMap = renderMemoryMap(this.d.memory.listTopics(this.sessionId));
    const journey = this.d.memory.readJourney(this.sessionId);
    const verbatimTail = this.d.history.tailVerbatim(tailBoundaryId, this.cfg.tailTokens);
    const gaps = this.d.ledger.read<'om.gap-marker'>('om.gap-marker').map((e) => ({
      at: new Date(e.at),
      lastAt: new Date(0),
      ms: e.data.ms,
      humanDuration: e.data.humanDuration,
    }));
    // v0.4: built-in current-task value at the head of the block.
    const currentTask = renderCurrentTask(
      this.d.memory.loadExtracted(this.sessionId, CURRENT_TASK_EXTRACTOR_ID),
    );
    const block = renderCompactionBlock({
      observations,
      memoryMap,
      journey,
      verbatimTail,
      gapMarkers: renderGapMarkers(gaps),
      currentTask,
      generatedAt: this.now().toISOString(),
    });
    return { block, tailBoundaryId };
  }

  /**
   * Tail boundary (last message NOT in the verbatim tail), snapped BACKWARD
   * to a committed chunk boundary (FR-3.4; snap idea ported from
   * pi-observational-memory's snapCutoff, MIT). No chunk may straddle the
   * cutoff: the observation block and the verbatim tail are then disjoint and
   * together cover the whole pre-compaction history (no "hole" of messages
   * that are in neither). '' when the tail covers the whole history.
   *
   * Conservative on purpose: the snap only moves the boundary EARLIER (to a
   * committed chunk end at or before the raw boundary) and, among candidates,
   * the one whose resulting tail is closest to tailTokens — the reference's
   * rule. Never moving it forward keeps the tail a superset of the raw one.
   *
   * "At or before" is compared via unobservedTokens monotonicity, NOT by id
   * string: pi 0.87.x entry ids are `randomUUID().slice(0, 8)` — random hex,
   * lexicographic order ≠ chronological (the uuidv7 contract assumed in
   * history.ts is broken). String comparison would filter out random half of
   * the candidates and could snap to a much older boundary.
   */
  tailBoundaryId(): string {
    const raw = this.d.history.tailStartIdFor?.(this.cfg.tailTokens) ?? this.watermark().coversUpToId;
    if (raw === '') return '';
    // Committed chunk ends: ALL om.observation entries (consolidated ones too —
    // their chunks stay represented via topics/journey, not the block).
    const boundaries = new Set<string>();
    for (const e of this.d.ledger.read<'om.observation'>('om.observation')) {
      if (e.data.coversUpToId) boundaries.add(e.data.coversUpToId);
    }
    let tailRaw = -1;
    try {
      tailRaw = this.d.history.unobservedTokens(raw);
    } catch {
      // raw unknown to history (branch rewrite): fall back to raw, no snap.
      return raw;
    }
    let best: string | null = null;
    let bestDelta = Number.POSITIVE_INFINITY;
    for (const b of boundaries) {
      let tail: number;
      try {
        tail = this.d.history.unobservedTokens(b);
      } catch {
        continue;
      }
      if (tail < tailRaw) continue; // conservative: never move the cutoff forward
      const delta = Math.abs(tail - this.cfg.tailTokens);
      if (delta < bestDelta) {
        bestDelta = delta;
        best = b;
      }
    }
    return best ?? raw;
  }

  // ---- recall (v0.5) ---------------------------------------------------------

  /**
   * Deterministic memory search (BM25-lite over observations, topics,
   * journey, extracted values; temporal filters supported). No LLM.
   */
  recall(query: string, opts: RecallOptions = {}): RecallHit[] {
    return recallSearch(buildSessionRecallDocs(this.d.ledger, this.d.memory, this.sessionId), query, opts);
  }

  /** Recall rendered for tool/command output. */
  recallText(query: string, opts: RecallOptions = {}): string {
    const hits = this.recall(query, opts);
    const rendered = renderRecallHits(hits, { sessionId: this.sessionId });
    return rendered || '(no matches in memory)';
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
    let { coversUpToId } = progressOf(active, []);
    // Watermark must survive tombstones (FR-1.3): consolidated history is still processed.
    for (const t of this.d.ledger.read<'om.tombstone'>('om.tombstone')) {
      if (t.data.maxCoversUpToId && t.data.maxCoversUpToId > coversUpToId) {
        coversUpToId = t.data.maxCoversUpToId;
      }
    }
    return { coversUpToId };
  }

  /**
   * A5: quiescently wait for ALL in-flight workers (observed by compaction
   * rendering). Adapters call this before rendering (session_before_compact);
   * runCompaction has its own boundary-aware variant (R5 fast path skips
   * tail-only observers).
   */
  async drainForCompaction(): Promise<void> {
    if (!this.enabled) return;
    await this.runs.drainInFlight();
    await this.d.runner.drain?.();
  }

  // ---- worker plumbing (NFR-1) ----------------------------------------------
  // runWorker / commit-failure handling / run+cost bookkeeping live in
  // RunManager (S1) — see run-manager.ts.

  // ---- status (FR-7.3) ------------------------------------------------------

  /**
   * R5: status() cache of the expensive reads (pool scan, topic/journey/
   * extracted files, costs, lastError, watermark). In-memory only;
   * invalidated by every ledger mutation of OUR process (RunManager
   * onLedgerChange + the orchestrator's own append/tombstone sites) and by
   * consolidator/extractor/reflector runs finishing (workers write topic
   * files directly). NFR: never stale past one of our own appends.
   */
  private statusCache: {
    activeObservations: number;
    poolTokens: number;
    watermark: string;
    topicCount: number;
    extractedCount: number;
    journeyTokens: number;
    costUsd: number;
    runs: number;
    lastError: OmStatus['lastError'];
  } | null = null;

  private invalidateStatusCache(): void {
    this.statusCache = null;
  }

  /** R5: one ledger read per type; computes pool + watermark together. */
  private buildStatusCache() {
    const obs = this.d.ledger.read<'om.observation'>('om.observation');
    const tomb = this.d.ledger.read<'om.tombstone'>('om.tombstone');
    const pool = foldPool(obs, tomb);
    // Watermark must survive tombstones (FR-1.3) — same rule as watermark().
    let watermark = progressOf(obs.map((e) => e.data), []).coversUpToId;
    for (const t of tomb) {
      if (t.data.maxCoversUpToId && t.data.maxCoversUpToId > watermark) watermark = t.data.maxCoversUpToId;
    }
    const costs = sumCosts(this.d.ledger.read<'om.cost'>('om.cost'));
    const lastErr = this.d.ledger.read<'om.lastError'>('om.lastError');
    const lastErrorEntry = lastErr[lastErr.length - 1];
    return {
      activeObservations: pool.observations.length,
      poolTokens: pool.tokens,
      watermark,
      topicCount: this.d.memory.listTopics(this.sessionId).length,
      extractedCount: this.d.memory.listExtracted(this.sessionId).length,
      journeyTokens: this.estimate(this.d.memory.readJourney(this.sessionId)),
      costUsd: costs.totalUsd,
      runs: costs.runs,
      lastError: lastErrorEntry ? { message: lastErrorEntry.data.message, at: lastErrorEntry.at } : null,
    };
  }

  status(): OmStatus {
    // R5: heavy reads are cached; rebuilt only after one of our own
    // mutations invalidated the cache.
    const c = this.statusCache ?? (this.statusCache = this.buildStatusCache());
    return {
      enabled: this.enabled,
      passive: this.cfg.passive,
      inFlight: this.runs.inFlight.map((r) => ({ runId: r.runId, role: r.role, startedAt: r.startedAt })),
      activeObservations: c.activeObservations,
      poolTokens: c.poolTokens,
      nextObserverInTokens: this.nextObserverProgress(c.watermark),
      consolidationPending: this.consolidating,
      topicCount: c.topicCount,
      extractedCount: c.extractedCount,
      journeyTokens: c.journeyTokens,
      contextTokens: this.safeContextTokens(),
      costUsd: c.costUsd,
      runs: c.runs,
      lastError: c.lastError,
    };
  }

  private nextObserverProgress(watermark: string): number | null {
    if (!this.enabled || this.cfg.passive) return null;
    try {
      // unobservedTokens is an in-memory O(M) walk (no fs) — left uncached
      // on purpose: the history has no cheap change signal on the interface.
      const unobserved = this.d.history.unobservedTokens(watermark);
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

  /** Total history tokens (`unobservedTokens('')` = everything); -1 on error. */
  private safeTotalTokens(): number {
    try {
      return this.d.history.unobservedTokens('');
    } catch {
      return -1;
    }
  }

  // ---- lifecycle -------------------------------------------------------------

  /** Wait for all in-flight workers (graceful shutdown / pre-compaction). */
  async shutdown(): Promise<void> {
    if (this.earlyTimer) clearTimeout(this.earlyTimer);
    this.earlyTimer = null;
    if (this.reflectTimer) clearTimeout(this.reflectTimer);
    this.reflectTimer = null;
    // Quiescent drain (see RunManager.drainInFlight): follow-up workers spawned
    // while draining must be awaited too.
    await this.runs.drainInFlight();
    // E1 (tail race): while an observer was in flight the pump saw only that
    // in-flight slice (the watermark does not move until the commit), so a
    // tail of ≥ chunkTokens arriving after the last pump stays unobserved.
    // If history GREW since the last pump, do one final pump: inFlight is
    // empty (no duplicate of an in-flight slice; committed-only watermark +
    // pendingChunks guard the rest), badSlices skips slices that never
    // committed (they are re-observed on a later cycle, not re-run for LLM
    // cost at shutdown). History unchanged → no pump (an idle quiescent
    // shutdown stays a no-op).
    if (this.enabled && !this.cfg.passive && this.safeTotalTokens() > this.lastPumpedTotalTokens) {
      const chunk = this.d.history.nextChunk({
        coversUpToId: this.watermark().coversUpToId,
      });
      if (chunk && !this.runs.isBadSlice(chunk.coversUpToId)) {
        this.startObserver(chunk.coversUpToId, chunk.text, chunk.overlapContext, chunk.fromId);
      }
    }
    // Drain the possibly-pumped observer (and any follow-ups it spawned).
    await this.runs.drainInFlight();
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
