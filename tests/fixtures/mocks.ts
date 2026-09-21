/**
 * Test fixtures: in-memory/mock implementations of the core seams
 * (HistorySource, LedgerStore, ModelRunner) — no LLM, no fs (except tmp dirs).
 */
import { MessageChunker, type OmMessage } from '../../src/core/chunker.js';
import type {
  HistorySource,
  LedgerStore,
  ModelRunner,
  Role,
  TypedLedgerEntry,
  LedgerEntryType,
  WorkerInput,
  WorkerResult,
} from '../../src/core/types.js';

export const identityEstimate = (t: string) => t.length;

export class MockHistory implements HistorySource {
  messages: OmMessage[] = [];
  chunker: MessageChunker;
  contextTokens = 0;
  idle = true;
  lastAt: Date | null = null;
  private tailStart: (maxTokens: number) => string;

  constructor(opts: { chunkTokens: number; overlapTokens?: number }) {
    this.chunker = new MessageChunker({
      chunkTokens: opts.chunkTokens,
      overlapTokens: opts.overlapTokens,
      estimate: identityEstimate,
    });
    this.tailStart = (maxTokens) => {
      // Newest window of ≤ maxTokens; returns the boundary (last excluded id).
      let acc = 0;
      let firstIncluded = this.messages.length;
      for (let i = this.messages.length - 1; i >= 0; i--) {
        const t = this.messages[i]!.tokens ?? identityEstimate(this.messages[i]!.text);
        // include i if it fits, or if it is the single newest message (never split)
        if (acc > 0 && acc + t > maxTokens) break;
        acc += t;
        firstIncluded = i;
      }
      if (firstIncluded === 0) return ''; // whole history fits
      return this.messages[firstIncluded - 1]!.id;
    };
  }

  add(id: string, text: string, tokens?: number): void {
    this.messages.push({ id, text, tokens: tokens ?? identityEstimate(text) });
    this.lastAt = new Date();
  }

  nextChunk(since: { coversUpToId: string; observedTokens: number }) {
    return this.chunker.next(this.messages, since);
  }
  currentTokens(): number {
    return this.contextTokens;
  }
  unobservedTokens(sinceId: string): number {
    let idx = -1;
    for (let i = 0; i < this.messages.length; i++) {
      if (this.messages[i]!.id === sinceId) idx = i;
    }
    const start = idx === -1 ? 0 : idx + 1;
    return this.messages
      .slice(start)
      .reduce((s, m) => s + (m.tokens ?? identityEstimate(m.text)), 0);
  }
  isIdle(): boolean {
    return this.idle;
  }
  tailVerbatim(sinceId: string, _maxTokens: number): string {
    if (sinceId === '') return this.messages.map((m) => m.text).join('\n');
    const idx = this.messages.findIndex((m) => m.id === sinceId);
    return this.messages.slice(idx + 1).map((m) => m.text).join('\n');
  }
  tailStartIdFor(maxTokens: number): string {
    return this.tailStart(maxTokens);
  }
  lastMessageAt(): Date | null {
    return this.lastAt;
  }
}

/** In-memory append-only ledger. */
export class MockLedger implements LedgerStore {
  entries: { entry: TypedLedgerEntry<LedgerEntryType>; at: string }[] = [];

  append<T extends LedgerEntryType>(entry: TypedLedgerEntry<T>): void {
    this.entries.push({ entry, at: entry.at });
  }
  read<T extends LedgerEntryType>(type?: T): TypedLedgerEntry<T>[] {
    return this.entries
      .map((e) => e.entry)
      .filter((e): e is TypedLedgerEntry<T> => (type ? e.type === type : true));
  }
  tombstone(observationIds: string[], report: { topics: string[]; journeyChanged: boolean; maxCoversUpToId?: string; maxSeq?: number }): void {
    this.entries.push({
      entry: {
        type: 'om.tombstone',
        data: { observationIds, ...report } as never,
        at: new Date().toISOString(),
      },
      at: new Date().toISOString(),
    });
  }
}

export interface ScriptedRun {
  result: (input: WorkerInput) => WorkerResult;
  delayMs?: number;
  failFirst?: number; // fail this many times before succeeding
}

/** Scripted model runner with in-flight tracking and drain(). */
export class MockRunner implements ModelRunner {
  calls: { role: Role; input: WorkerInput }[] = [];
  inFlight = 0;
  failures = 0;
  private failCounters = new Map<string, number>();

  constructor(private observer: ScriptedRun, private consolidator: ScriptedRun, private extractor?: ScriptedRun) {}

  async run(role: Role, input: WorkerInput): Promise<WorkerResult> {
    this.calls.push({ role, input });
    const defaultExtraction: ScriptedRun = { result: (i) => ({ runId: i.runId, ok: true, extraction: {} }) };
    const run =
      role === 'observer' ? this.observer : role === 'extractor' ? (this.extractor ?? defaultExtraction) : this.consolidator;
    this.inFlight++;
    try {
      await sleep(run.delayMs ?? 1);
      const key = input.runId;
      const fails = run.failFirst ?? 0;
      const n = (this.failCounters.get(key) ?? 0) + 1;
      this.failCounters.set(key, n);
      if (n <= fails) {
        this.failures++;
        return { runId: input.runId, ok: false, error: `scripted failure ${n}` };
      }
      return run.result(input);
    } finally {
      this.inFlight--;
    }
  }

  async drain(): Promise<void> {
    while (this.inFlight > 0) await sleep(1);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
