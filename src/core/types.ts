/**
 * Core domain types for Observational Memory (agent-agnostic).
 * See docs/ARCHITECTURE.md §2-3.
 */

export type Role = 'observer' | 'consolidator' | 'extractor' | 'reflect';

/**
 * Observation priority classes (v0.4, niche-standard 🔴🟡🟢):
 *  - critical: breaks work if forgotten (decisions, security, current-task-critical facts);
 *  - important: decisions made, work completed, problems hit;
 *  - routine: everything else (default).
 * Priority drives block rendering and budget trimming (compaction.inject: topK).
 */
export type ObservationPriority = 'critical' | 'important' | 'routine';

/**
 * A declarative extractor (Mastra-style): a named structured value pulled out
 * of the active observation pool by a dedicated worker (v2 feature).
 */
export interface ExtractorSpec {
  /** Filesystem-safe id: [a-z0-9_-]+ (used as the storage key/file name). */
  id: string;
  /** Human/LLM-readable name. */
  name: string;
  /** What to extract and how it evolves (fed into the prompt). */
  description: string;
  /**
   * Show the previously stored value to the extractor (v0.4, Mastra-style
   * includePreviousExtraction): incremental merge instead of re-extraction.
   * Default: true. Set false for volatile values that must be re-derived.
   */
  includePrevious?: boolean;
}

/** Draft observation from a worker: content + priority (ids derived at commit). */
export interface ObservationDraft {
  text: string;
  priority: ObservationPriority;
}

/** Atomic, self-contained note about what happened in a slice of history. */
export interface Observation {
  /** Unique id, second-resolution, derived at commit time by the orchestrator. */
  id: string;
  /** Watermark: history up to (and including) this message id has been processed. */
  coversUpToId: string;
  /** Atomic note text. */
  content: string;
  /** Estimated token count of content. */
  tokenCount: number;
  /** ISO timestamp of the originating event. */
  createdAt: string;
  /** Priority class (v0.4); absent in older ledgers → treated as 'routine'. */
  priority?: ObservationPriority;
  /** Anti-poisoning flag (v0.6): content looks like an injected instruction. */
  quarantined?: boolean;
  /**
   * Provenance (v0.5): the raw-history message range this observation was
   * distilled from (recall can point the agent back to the source).
   */
  sourceRange?: { fromId: string; toId: string };
}

export type LedgerEntryType =
  | 'om.observation'
  | 'om.tombstone'
  | 'om.cost'
  | 'om.gap-marker'
  | 'om.enabled'
  | 'om.run'
  | 'om.lastError';

/**
 * An append-only ledger entry. Payload shapes are in Payloads below.
 * The adapter decides how entries are persisted (e.g. pi.appendEntry).
 */
export interface LedgerEntry<T extends LedgerEntryType = LedgerEntryType> {
  type: T;
  data: LedgerPayload[T];
  /** ISO timestamp. */
  at: string;
  meta?: {
    runId?: string;
  };
}

export interface TombstoneReport {
  /** Observation ids removed from the active pool (consolidated into topic files). */
  observationIds: string[];
  /** Topic files touched. */
  topics: string[];
  journeyChanged: boolean;
  /** Watermark preserved: max coversUpToId among tombstoned observations. */
  maxCoversUpToId?: string;
  /** Highest observation-id seq among tombstoned observations. */
  maxSeq?: number;
}

export interface CostEntry {
  runId: string;
  role: Role;
  usd: number;
  at: string;
}

export interface GapMarker {
  id: string;
  at: string;
  /** Human-readable duration, e.g. "2 дня 3 часа". */
  humanDuration: string;
  /** Milliseconds of the detected gap. */
  ms: number;
}

export interface EnabledEntry {
  enabled: boolean;
}

export interface RunEntry {
  runId: string;
  role: Role;
  status: 'started' | 'ok' | 'error';
  error?: string;
  at: string;
}

export interface LastErrorEntry {
  message: string;
  at: string;
}

export interface LedgerPayload {
  'om.observation': Observation;
  'om.tombstone': TombstoneReport;
  'om.cost': CostEntry;
  'om.gap-marker': GapMarker;
  'om.enabled': EnabledEntry;
  'om.run': RunEntry;
  'om.lastError': LastErrorEntry;
}

/** A ledger entry with its payload typed by entry type. */
export type TypedLedgerEntry<T extends LedgerEntryType> = LedgerEntry<T> & {
  data: LedgerPayload[T];
};

/** Rendered compaction block injected in place of raw history (FR-3). */
export interface CompactionBlock {
  /** Deterministic verbatim render of the active observation pool. */
  observations: string;
  /** Rendered live from topic file front-matter (memory map). */
  memoryMap: string;
  /** JOURNEY.md verbatim. */
  journey: string;
  /** Built-in current-task value rendered at the head of the block (v0.4). */
  currentTask: string;
  /** Fresh verbatim history, snapped to a chunk boundary. */
  verbatimTail: string;
  /** Gap markers rendered at the head, if any. */
  gapMarkers: string;
  /** Fully assembled block text (deterministic for given inputs). */
  text: string;
  generatedAt: string;
}

/** Input handed to a worker (observer or consolidator). */
export interface WorkerInput {
  runId: string;
  role: Role;
  /** Observer: a token-bounded slice of new history. */
  chunk?: {
    text: string;
    overlapContext: string;
    coversUpToId: string;
    /** Provenance (v0.5): id of the FIRST message in the slice. */
    fromId?: string;
  };
  /** Consolidator: oldest observations to fold into durable topic files. */
  pool?: {
    observations: Observation[];
    sessionDir: string;
    journey: string;
    /** Rendered memory-map line for shared (project-level) topics (v0.7). */
    sharedTopics?: string;
  };
  /** Extractor: refresh structured values from the active observation pool. */
  extract?: {
    specs: ExtractorSpec[];
    /** Previously stored values keyed by spec id (for merge/refresh). */
    current: Record<string, unknown>;
    /** Active observations to extract from. */
    observations: Observation[];
    sessionDir: string;
  };
  /**
   * Reflector (v0.6, sleep-time): reorganize durable memory files (topics /
   * INDEX / JOURNEY) without consuming observations.
   */
  reflect?: {
    sessionDir: string;
    /** Durable topic file names. */
    topics: string[];
    journey: string;
    /** Rendered memory-map line for shared (project-level) topics, if any. */
    sharedTopics?: string;
  };
}

export interface ConsolidationResult {
  topics: string[];
  tombstoneIds: string[];
  /** Explicitly dropped (superseded) observation ids — tombstoned too. */
  droppedIds: string[];
  journeyChanged: boolean;
}

export interface WorkerResult {
  runId: string;
  ok: boolean;
  error?: string;
  /** Observer output: observation drafts (ids/tokenCount are derived by the
   * orchestrator at commit time — see ids.ts, FR-1.4). */
  observations?: ObservationDraft[];
  /** Consolidator output. */
  consolidation?: ConsolidationResult;
  /** Extractor output: values keyed by extractor spec id. */
  extraction?: Record<string, unknown>;
  /** Reflector output (v0.6): durable files touched. */
  reflection?: { topics: string[]; journeyChanged: boolean };
  costUsd?: number;
}

export interface Watermark {
  /** Max coversUpToId committed so far; '' when none. */
  coversUpToId: string;
  /** Approximate tokens of history already observed. */
  observedTokens: number;
}

/** LLM invocation seam. Implementations: PiSubprocessRunner, MockRunner (tests). */
export interface ModelRunner {
  run(role: Role, input: WorkerInput): Promise<WorkerResult>;
  /** Wait for in-flight runs to finish (graceful shutdown / pre-compaction). */
  drain?(): Promise<void>;
}

/** Agent session history seam (the adapter knows the session format). */
export interface HistorySource {
  /**
   * Next token-bounded slice of history since the watermark, or null when
   * fewer than chunkTokens of new history. Slices never split a message.
   * opts.minTokens (early activation) lowers the threshold.
   */
  nextChunk(since: Watermark, opts?: { minTokens?: number }): {
    text: string;
    overlapContext: string;
    coversUpToId: string;
    /** Provenance (v0.5): id of the first message in the slice. */
    fromId: string;
    tokens: number;
  } | null;
  /** Estimated total context tokens (for the compact trigger). */
  currentTokens(): number;
  /** Tokens of history AFTER the given watermark (for "next observer" progress). */
  unobservedTokens(sinceId: string): number;
  isIdle(): boolean;
  /** Verbatim fresh history since an id, bounded by maxTokens. */
  tailVerbatim(sinceId: string, maxTokens: number): string;
  /**
   * Id of the LAST message not included in the newest window of ≤ maxTokens
   * (the verbatim tail starts after it; FR-3.4). '' when the whole history
   * fits — the tail covers everything and the observation section is empty.
   */
  tailStartIdFor?(maxTokens: number): string;
  /** For gap markers. */
  lastMessageAt(): Date | null;
}

/** Append-only ledger seam. Implementations: PiAppendEntryStore, FileLedgerStore. */
export interface LedgerStore {
  append<T extends LedgerEntryType>(entry: TypedLedgerEntry<T>): void;
  /** Entries of the current branch, in commit order. */
  read<T extends LedgerEntryType>(type?: T): TypedLedgerEntry<T>[];
  /** Marker helper (implemented via an om.tombstone entry). */
  tombstone(observationIds: string[], report: Omit<TombstoneReport, 'observationIds'>): void;
}

export interface OmStatus {
  enabled: boolean;
  passive: boolean;
  inFlight: { runId: string; role: Role; startedAt: string }[];
  activeObservations: number;
  poolTokens: number;
  nextObserverInTokens: number | null;
  consolidationPending: boolean;
  topicCount: number;
  /** Count of stored extractor values (v2; undefined in older core versions). */
  extractedCount?: number;
  journeyTokens: number;
  contextTokens: number | null;
  costUsd: number;
  runs: number;
  lastError: { message: string; at: string } | null;
}

export interface RunInfo {
  runId: string;
  role: Role;
  startedAt: string;
  finishedAt?: string;
  status?: 'ok' | 'error';
  error?: string;
  costUsd?: number;
}

/** Events outward to the adapter/UI. */
export interface EventSink {
  onStatus(s: OmStatus): void;
  /** Adapter forwards the block into the agent's compaction (see spike S1). */
  onCompactionBlock(b: CompactionBlock): void;
  onRunStarted(run: RunInfo): void;
  onRunFinished(run: RunInfo, r: WorkerResult): void;
  onError(e: OmError): void;
  /** A temporal gap was marked (FR-8); adapters may surface it in-context. */
  onGapMarker?(gap: { at: string; humanDuration: string; ms: number }): void;
}

export class OmError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'config-invalid'
      | 'ledger-corrupt'
      | 'runner-failed'
      | 'storage-error'
      | 'not-enabled',
  ) {
    super(message);
    this.name = 'OmError';
  }
}

/** Durable per-session memory files under <root>/<sessionId>/ (FR-4, FR-5). */
export interface TopicSummary {
  file: string;
  topic: string;
  description: string;
  session: string;
}

export interface MemoryRoot {
  sessionDir(sessionId: string): string;
  exists(sessionId: string): boolean;
  /**
   * One-time seed from a parent session (fork/clone); true when actually
   * seeded. opts.force (v0.7) allows manual re-seeding (still never clobbers
   * existing child files).
   */
  seedFrom(parentSessionId: string, sessionId: string, opts?: { force?: boolean }): boolean;
  listTopics(sessionId: string): TopicSummary[];
  /** Durable topic file content (v0.5, for recall). '' when missing. */
  readTopic(sessionId: string, file: string): string;
  readJourney(sessionId: string): string;
  /** Orchestrator-owned INDEX.md re-render from topic front-matter. */
  renderIndex(sessionId: string): void;
  /** Structured extractor values (v2). */
  loadExtracted(sessionId: string, id: string): unknown;
  saveExtracted(sessionId: string, id: string, value: unknown): void;
  listExtracted(sessionId: string): string[];
  /** Shared (project-level) topic root, or null when disabled (v0.7). */
  sharedDir(): string | null;
  listSharedTopics(): TopicSummary[];
  /** Shared topic file content (v0.7). '' when missing. */
  readSharedTopic(file: string): string;
}

export interface Clock {
  now(): Date;
}
