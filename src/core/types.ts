/**
 * Core domain types for Observational Memory (agent-agnostic).
 * See docs/ARCHITECTURE.md §2-3.
 */

export type Role = 'observer' | 'consolidator';

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
  };
  /** Consolidator: oldest observations to fold into durable topic files. */
  pool?: {
    observations: Observation[];
    sessionDir: string;
    journey: string;
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
  /** Observer output: observation CONTENTS (ids/tokenCount are derived by the
   * orchestrator at commit time — see ids.ts, FR-1.4). */
  observations?: string[];
  /** Consolidator output. */
  consolidation?: ConsolidationResult;
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
   */
  nextChunk(since: Watermark): {
    text: string;
    overlapContext: string;
    coversUpToId: string;
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
  /** One-time seed from a parent session (fork/clone). */
  seedFrom(parentSessionId: string, sessionId: string): void;
  listTopics(sessionId: string): TopicSummary[];
  readJourney(sessionId: string): string;
  /** Orchestrator-owned INDEX.md re-render from topic front-matter. */
  renderIndex(sessionId: string): void;
}

export interface Clock {
  now(): Date;
}
