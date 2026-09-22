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
import { foldPool, oldestAbove, orderByPriority, trimToBudget } from './ledger/pool.js';
import { progressOf } from './ledger/progress.js';
import { renderCompactionBlock, selectBeforeTail } from './ledger/render.js';
import { renderMemoryMap } from './memory-store.js';
import { detectGap, gapMarkerId, renderGapMarkers } from './gap-markers.js';
import { sumCosts } from './cost.js';
import { estimateTokens } from './tokens.js';
import { nextObservationId, newRunId } from './ids.js';
import { sanitizeObservation } from './sanitize.js';
import { recallSearch, renderRecallHits, buildSessionRecallDocs, type RecallHit, type RecallOptions } from './recall.js';
import { OmError } from './types.js';
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
  Role,
  RunInfo,
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

interface InFlight {
  runId: string;
  role: Role;
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
  private extracting = false;
  private lastGapMarkedFor: Date | null = null;
  private compactedForTokens = 0;
  private earlyTimer: ReturnType<typeof setTimeout> | null = null;
  private reflectTimer: ReturnType<typeof setTimeout> | null = null;
  private reflecting = false;

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
    // The seed flag inside seedFrom is the idempotence guard (the session dir
    // itself may already exist, e.g. the ledger created it — FR-4.4).
    const did = this.d.memory.seedFrom(this.d.forkParentSessionId, this.sessionId);
    if (did) this.log(`seeded memory from ${this.d.forkParentSessionId}`);
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
    if (this.observersInFlight() >= this.cfg.observerConcurrency) return;
    const wm = this.watermark();
    const chunk = this.d.history.nextChunk(
      { coversUpToId: wm.coversUpToId, observedTokens: 0 },
      { minTokens: this.cfg.earlyActivation.minUnobservedTokens },
    );
    if (!chunk) return;
    if (this.pendingChunks.has(chunk.coversUpToId)) return;
    this.log(`early chunk: ${chunk.tokens} tokens up to ${chunk.coversUpToId}`);
    this.startObserver(chunk.coversUpToId, chunk.text, chunk.overlapContext, chunk.fromId);
  }

  async onAgentEnd(): Promise<void> {
    if (!this.enabled || this.cfg.passive) return;
    this.maybeMarkGap();
    this.scheduleReflectIdleCheck();
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

  /**
   * Track a worker task in inFlight; the entry REMOVES ITSELF when settled so
   * quiescent drains (shutdown/compaction) terminate even for follow-up runs
   * spawned while draining.
   */
  private trackTask(runId: string, role: Role, startedAt: string, task: Promise<void>): void {
    const tracked = task.finally(() => {
      const i = this.inFlight.findIndex((r) => r.runId === runId);
      if (i !== -1) this.inFlight.splice(i, 1);
    });
    this.inFlight.push({ runId, role, startedAt, promise: tracked });
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
      this.startObserver(chunk.coversUpToId, chunk.text, chunk.overlapContext, chunk.fromId);
    }
  }

  private startObserver(coversUpToId: string, text: string, overlapContext: string, fromId?: string): void {
    const runId = newRunId();
    const input: WorkerInput = {
      runId,
      role: 'observer',
      chunk: { coversUpToId, text, overlapContext, ...(fromId ? { fromId } : {}) },
    };
    this.pendingChunks.add(coversUpToId);
    const task = this.runWorker(
      input,
      (res) => this.commitObservations(runId, coversUpToId, fromId, res),
    ).finally(() => {
      this.pendingChunks.delete(coversUpToId);
    });
    this.trackTask(runId, 'observer', this.now().toISOString(), task);
  }

  private commitObservations(runId: string, coversUpToId: string, fromId: string | undefined, res: WorkerResult): void {
    if (!this.enabled) {
      this.log(`discarding observations of ${runId} (disabled mid-run)`);
      return;
    }
    const parsed = res.observations ?? [];
    if (parsed.length === 0) return;
    const at = this.now().toISOString();
    const sourceRange = fromId ? { fromId, toId: coversUpToId } : undefined;
    for (const draft of parsed) {
      const text = (draft?.text ?? '').trim();
      if (!text) continue;
      const { quarantined, matched } = sanitizeObservation(text);
      if (quarantined) this.log(`observation quarantined (injection-like, ${matched})`);
      const lastSeq = this.maxSeqForSecond();
      const id = nextObservationId({ lastSeq, now: () => this.now().getTime() });
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
        sharedTopics: this.sharedTopicsLine(),
      },
    };
    const task = this.runWorker(input, (res) => this.commitConsolidation(runId, oldest.ids, res));
    this.trackTask(runId, 'consolidator', this.now().toISOString(),
      task.finally(() => {
        this.consolidating = false;
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
    this.extracting = true;
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
    const task = this.runWorker(input, (res) => {
      const values = res.extraction ?? {};
      for (const spec of this.cfg.extractors) {
        if (Object.prototype.hasOwnProperty.call(values, spec.id)) {
          this.d.memory.saveExtracted(this.sessionId, spec.id, values[spec.id]);
        }
      }
      this.log(`extraction ${runId} (${reason}): saved ${Object.keys(values).length} values`);
    });
    this.trackTask(runId, 'extractor', this.now().toISOString(),
      task.finally(() => {
        this.extracting = false;
        this.emitStatus();
      }),
    );
    this.log(`extraction started (${reason})`);
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
    this.d.sink.onGapMarker?.({ at, humanDuration: gap.humanDuration, ms: gap.ms });
    this.emitStatus();
  }

  // ---- compaction (FR-3) ---------------------------------------------------

  private async runCompaction(): Promise<void> {
    await this.d.runner.drain?.();
    // Quiescent drain: workers may spawn follow-ups (e.g. post-consolidation
    // extraction) after the snapshot; loop until nothing is in flight.
    for (;;) {
      const inflight = this.inFlight.slice();
      if (inflight.length === 0) break;
      await Promise.allSettled(inflight.map((r) => r.promise));
    }
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
        sharedTopics: this.sharedTopicsLine(),
      },
    };
    const task = this.runWorker(input, (res) => this.commitConsolidation(runId, oldest.ids, res));
    this.trackTask(runId, 'consolidator', this.now().toISOString(),
      task.finally(() => {
        this.consolidating = false;
        this.emitStatus();
      }),
    );
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
    this.reflecting = true;
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
    const task = this.runWorker(input, (res) => this.commitReflection(runId, res));
    this.trackTask(runId, 'reflect', this.now().toISOString(),
      task.finally(() => {
        this.reflecting = false;
        this.emitStatus();
      }),
    );
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

  /**
   * Compaction plan (FR-3): the rendered block + the tail boundary id (last
   * message NOT included in the verbatim tail; '' when the tail covers
   * everything). Adapters use the boundary for e.g. firstKeptEntryId.
   */
  compactionPlan(): { block: CompactionBlock; tailBoundaryId: string } {
    const pool = this.pool();
    const prog = this.watermark();
    const tailBoundaryId = this.d.history.tailStartIdFor?.(this.cfg.tailTokens) ?? prog.coversUpToId;
    let observations = selectBeforeTail(pool.observations, tailBoundaryId);
    // v0.5: deterministic injection modes — topK trims by priority budget.
    if (this.cfg.compaction.inject === 'topK') {
      observations = trimToBudget(observations, this.cfg.compaction.topKBudgetTokens);
    }
    // v0.4: render priority-ordered (critical → important → routine).
    observations = orderByPriority(observations);
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

  private recordRun(runId: string, role: Role, status: 'ok' | 'error', costUsd?: number, error?: string): void {
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
      extractedCount: this.d.memory.listExtracted(this.sessionId).length,
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
    if (this.earlyTimer) clearTimeout(this.earlyTimer);
    this.earlyTimer = null;
    if (this.reflectTimer) clearTimeout(this.reflectTimer);
    this.reflectTimer = null;
    // Quiescent drain (see runCompaction): follow-up workers spawned while
    // draining must be awaited too.
    for (;;) {
      const inflight = this.inFlight.slice();
      if (inflight.length === 0) break;
      await Promise.allSettled(inflight.map((r) => r.promise));
    }
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
