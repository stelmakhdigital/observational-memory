import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { OmOrchestrator } from '../../src/core/orchestrator.js';
import { resolveConfig, type OmConfig } from '../../src/core/config.js';
import { MemoryStore } from '../../src/core/memory-store.js';
import { sumCosts } from '../../src/core/cost.js';
import type {
  CompactionBlock,
  EventSink,
  LedgerEntryType,
  LedgerStore,
  OmStatus,
  RunInfo,
  TypedLedgerEntry,
  WorkerInput,
  WorkerResult,
} from '../../src/core/types.js';
import { MockHistory, MockLedger, MockRunner, drafts } from '../fixtures/mocks.js';

const baseConfig: OmConfig = resolveConfig({
  chunkTokens: 10,
  poolTargetTokens: 5,
  consolidateAtPoolTokens: 100, // keep auto-consolidation off; force it manually
  compactAtContextTokens: 100,
  tailTokens: 50,
});

function makeRunner() {
  const runner = new MockRunner(
    {
      // two observations per chunk, content unique to the chunk boundary
      result: (input: WorkerInput) => ({
        runId: input.runId,
        ok: true,
        costUsd: 0.01,
        observations: drafts(
          `obs from ${input.chunk!.coversUpToId}`,
          `obs2 of chunk ${input.chunk!.coversUpToId}`,
        ),
      }),
    },
    {
      result: (input: WorkerInput) => ({
        runId: input.runId,
        ok: true,
        costUsd: 0.02,
        consolidation: {
          topics: ['topic-a.md'],
          tombstoneIds: input.pool!.observations.map((o) => o.id),
          droppedIds: [],
          journeyChanged: true,
        },
      }),
    },
  );
  return runner;
}

class CaptureSink implements EventSink {
  statuses: OmStatus[] = [];
  blocks: CompactionBlock[] = [];
  runsStarted: RunInfo[] = [];
  runsFinished: [RunInfo, WorkerResult][] = [];
  errors: Error[] = [];
  onStatus(s: OmStatus) {
    this.statuses.push(s);
  }
  onCompactionBlock(b: CompactionBlock) {
    this.blocks.push(b);
  }
  onRunStarted(r: RunInfo) {
    this.runsStarted.push(r);
  }
  onRunFinished(r: RunInfo, w: WorkerResult) {
    this.runsFinished.push([r, w]);
  }
  onError(e: Error) {
    this.errors.push(e);
  }
}

let dir: string;
let history: MockHistory;
let ledger: MockLedger;
let memory: MemoryStore;
let sink: CaptureSink;
let runner: ReturnType<typeof makeRunner>;
let orch: OmOrchestrator;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'om-it-'));
  history = new MockHistory({ chunkTokens: baseConfig.chunkTokens });
  ledger = new MockLedger();
  memory = new MemoryStore(dir);
  sink = new CaptureSink();
  runner = makeRunner();
  orch = new OmOrchestrator({
    config: baseConfig,
    sessionId: 'session-1',
    history,
    ledger,
    runner,
    memory,
    sink,
    clock: { now: () => new Date('2025-09-21T12:00:00Z') },
  });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const settle = async () => {
  await runner.drain();
  await orch.shutdown();
};

describe('observer pipeline', () => {
  it('observes chunks into the pool with cost', async () => {
    orch.setEnabled(true);
    // 3 messages × 4 chars = 12 tokens ≥ chunkTokens 10
    history.add('m1', 'aaaa');
    history.add('m2', 'bbbb');
    history.add('m3', 'cccc');
    orch.onTurnEnd();
    await settle();

    const obs = ledger.read('om.observation');
    expect(obs.length).toBe(2);
    expect(obs[0]!.data.coversUpToId).toBe('m3');
    expect(orch.status().activeObservations).toBe(2);
    expect(orch.status().costUsd).toBeCloseTo(0.01);
    expect(sink.runsStarted.length).toBe(1);
  });

  it('is a no-op when disabled (FR-7.2)', async () => {
    history.add('m1', 'aaaaaaaaaa');
    orch.onTurnEnd();
    await settle();
    expect(ledger.read('om.observation')).toEqual([]);
    expect(runner.calls).toEqual([]);
    await expect(orch.forceCompact()).resolves.toBeUndefined();
    expect(sink.blocks).toEqual([]);
  });

  it('passive mode disables automatic triggers but keeps manual ones (FR-7.4)', async () => {
    const passive = new OmOrchestrator({
      config: resolveConfig({ ...baseConfig, passive: true }),
      sessionId: 's',
      history,
      ledger,
      runner,
      memory,
      sink,
    });
    passive.setEnabled(true);
    history.add('m1', 'aaaaaaaaaa');
    passive.onTurnEnd();
    await passive.shutdown();
    expect(ledger.read('om.observation')).toEqual([]); // auto-off
  });
});

describe('consolidation', () => {
  it('force-consolidate drains the pool via tombstones and preserves the watermark', async () => {
    orch.setEnabled(true);
    history.add('m1', 'aaaa');
    history.add('m2', 'bbbb');
    history.add('m3', 'cccc'); // 12 tokens ≥ chunkTokens 10
    orch.onTurnEnd();
    await settle();
    const before = orch.status();
    expect(before.activeObservations).toBe(2);

    orch.forceConsolidate();
    await settle();

    const pool = orch.status();
    expect(pool.activeObservations).toBe(0); // tombstoned
    const tomb = ledger.read('om.tombstone');
    expect(tomb.length).toBe(1);
    expect(tomb[0]!.data.maxCoversUpToId).toBe('m3');
    // watermark must not regress: no re-observation on next turn
    const callsBefore = runner.calls.length;
    history.add('m4', 'dddd');
    orch.onTurnEnd();
    await settle();
    // fresh history since m3 = 4 tokens < 10 → no new observer
    expect(runner.calls.length).toBe(callsBefore);
    // cost includes the consolidator run
    expect(sumCosts(ledger.read('om.cost')).totalUsd).toBeCloseTo(0.03);
  });
});

describe('compaction (FR-3)', () => {
  it('emits a compaction block when context exceeds the threshold while idle', async () => {
    orch.setEnabled(true);
    // 4 × 15 chars = 60 tokens; tail window 50 → boundary m2, tail = m3+m4
    history.add('m1', 'a'.repeat(15));
    history.add('m2', 'b'.repeat(15));
    history.add('m3', 'c'.repeat(15));
    history.add('m4', 'd'.repeat(15));
    // one observer per chunk: commit, then pump the next
    for (let i = 0; i < 4; i++) {
      orch.onTurnEnd();
      await runner.drain();
    }

    history.contextTokens = 150; // ≥ 100
    history.idle = true;
    await orch.onAgentEnd();

    expect(sink.blocks.length).toBe(1);
    const b = sink.blocks[0]!;
    expect(b.text).toContain('OBSERVATIONAL MEMORY');
    // Tail window (50 tokens) holds m2+m3+m4 (45) → boundary m1.
    // Only the pre-tail chunk (m1) is rendered as observations; m2..m4 are
    // verbatim in the tail → no double representation (FR-3.4).
    expect(b.observations).toContain('obs from m1');
    expect(b.observations).not.toContain('obs from m2');
    expect(b.observations).not.toContain('obs from m3');
    expect(b.verbatimTail).toBe('bbbbbbbbbbbbbbb\nccccccccccccccc\nddddddddddddddd');
  });

  it('does not re-compact for the same context size', async () => {
    orch.setEnabled(true);
    history.contextTokens = 150;
    history.idle = true;
    await orch.onAgentEnd();
    await orch.onAgentEnd();
    expect(sink.blocks.length).toBe(1);
  });
});

describe('gap markers (FR-8)', () => {
  it('marks a pause and includes it in the compaction block', async () => {
    orch.setEnabled(true);
    history.add('m1', 'aaaa');
    history.lastAt = new Date('2025-09-19T09:00:00Z'); // 2+ days before clock
    history.contextTokens = 150;
    history.idle = true;
    await orch.onAgentEnd();

    const gaps = ledger.read('om.gap-marker');
    expect(gaps.length).toBe(1);
    expect(gaps[0]!.data.humanDuration).toBe('2 дня 3 часа');
    const b = sink.blocks[0]!;
    expect(b.text).toContain('temporal anchors');
    expect(b.text).toContain('resumed after 2 дня 3 часа');
  });

  it('does not double-mark the same pause', async () => {
    orch.setEnabled(true);
    history.lastAt = new Date('2025-09-19T09:00:00Z');
    history.contextTokens = 150;
    history.idle = true;
    await orch.onAgentEnd();
    await orch.onAgentEnd();
    expect(ledger.read('om.gap-marker').length).toBe(1);
  });
});

describe('error handling (NFR-1)', () => {
  it('retries a failed observer once and succeeds without recording an error', async () => {
    const flaky = new MockRunner(
      {
        result: (input: WorkerInput) => ({ runId: input.runId, ok: true, observations: drafts('ok note') }),
        failFirst: 1,
      },
      {
        result: (input: WorkerInput) => ({
          runId: input.runId,
          ok: true,
          consolidation: { topics: [], tombstoneIds: [], droppedIds: [], journeyChanged: false },
        }),
      },
    );
    const orch2 = new OmOrchestrator({
      config: baseConfig,
      sessionId: 's-err',
      history,
      ledger,
      runner: flaky,
      memory,
      sink,
    });
    orch2.setEnabled(true);
    history.add('m1', 'aaaaaaaaaa');
    orch2.onTurnEnd();
    await flaky.drain();
    await orch2.shutdown();

    expect(ledger.read('om.observation').length).toBe(1); // retry succeeded
    expect(ledger.read('om.lastError')).toEqual([]); // transient failure: no lastError
  });

  it('records lastError when the retry is exhausted', async () => {
    const dead = new MockRunner(
      {
        result: (input: WorkerInput) => ({ runId: input.runId, ok: true, observations: drafts('x') }),
        failFirst: 2, // both the attempt and its retry fail
      },
      {
        result: (input: WorkerInput) => ({
          runId: input.runId,
          ok: true,
          consolidation: { topics: [], tombstoneIds: [], droppedIds: [], journeyChanged: false },
        }),
      },
    );
    const orch3 = new OmOrchestrator({
      config: baseConfig,
      sessionId: 's-err2',
      history,
      ledger,
      runner: dead,
      memory,
      sink,
    });
    orch3.setEnabled(true);
    history.add('m1', 'aaaaaaaaaa');
    orch3.onTurnEnd();
    await dead.drain();
    await orch3.shutdown();

    expect(ledger.read('om.observation')).toEqual([]);
    expect(ledger.read('om.lastError').length).toBe(1);
    expect(orch3.status().lastError).toBeTruthy();
    expect(sink.errors.length).toBe(1);
  });
});

// M6: a COMMIT failure must not re-run the LLM. The commit is retried once
// (synchronously, no LLM); a final commit failure keeps the result in
// om.lastError and leaves the slice un-covered (re-observed later).

/** Ledger whose first N om.observation appends throw (simulated commit failure). */
class FlakyCommitLedger implements LedgerStore {
  private fails = 0;
  constructor(private inner: MockLedger, private failTimes: number) {}
  append<T extends LedgerEntryType>(entry: TypedLedgerEntry<T>): void {
    if (entry.type === 'om.observation' && this.fails < this.failTimes) {
      this.fails++;
      throw new Error('simulated ledger commit failure');
    }
    this.inner.append(entry);
  }
  read<T extends LedgerEntryType>(type?: T): TypedLedgerEntry<T>[] {
    return this.inner.read(type);
  }
  tombstone(ids: string[], report: Parameters<LedgerStore['tombstone']>[1]): void {
    this.inner.tombstone(ids, report);
  }
}

const okConsolidator = {
  result: (input: WorkerInput): WorkerResult => ({
    runId: input.runId,
    ok: true,
    consolidation: { topics: [], tombstoneIds: [], droppedIds: [], journeyChanged: false },
  }),
};

describe('M6: commit failure vs worker failure', () => {
  it('retries ONLY the commit (exactly 1 LLM run) when the first commit fails', async () => {
    const runner2 = new MockRunner(
      { result: (i: WorkerInput) => ({ runId: i.runId, ok: true, observations: drafts('committed note') }) },
      okConsolidator,
    );
    const ledger2 = new FlakyCommitLedger(ledger, 1);
    const orch2 = new OmOrchestrator({
      config: baseConfig,
      sessionId: 's-m6a',
      history,
      ledger: ledger2,
      runner: runner2,
      memory,
      sink,
    });
    orch2.setEnabled(true);
    history.add('m1', 'aaaaaaaaaa');
    orch2.onTurnEnd();
    await runner2.drain();
    await orch2.shutdown();

    expect(runner2.calls.filter((c) => c.role === 'observer').length).toBe(1); // NO LLM re-run
    expect(ledger2.read('om.observation').length).toBe(1); // commit retry succeeded
    expect(ledger2.read('om.lastError')).toEqual([]);
  });

  it('keeps the LLM result in lastError and leaves the slice un-covered when the commit keeps failing', async () => {
    const runner2 = new MockRunner(
      { result: (i: WorkerInput) => ({ runId: i.runId, ok: true, observations: drafts('committed note') }) },
      okConsolidator,
    );
    const ledger2 = new FlakyCommitLedger(ledger, Number.MAX_SAFE_INTEGER);
    const orch2 = new OmOrchestrator({
      config: baseConfig,
      sessionId: 's-m6b',
      history,
      ledger: ledger2,
      runner: runner2,
      memory,
      sink,
    });
    orch2.setEnabled(true);
    history.add('m1', 'aaaaaaaaaa');
    orch2.onTurnEnd();
    await runner2.drain();
    await orch2.shutdown();

    expect(runner2.calls.filter((c) => c.role === 'observer').length).toBe(1); // LLM result NOT repeated
    expect(ledger2.read('om.observation')).toEqual([]);
    const errs = ledger2.read('om.lastError');
    expect(errs.length).toBe(1);
    expect(errs[0]!.data.message).toContain('committed note'); // result preserved, data not lost
    // Slice is NOT covered: the next cycle re-observes the same chunk
    // (n9 dedup by sourceRange.fromId guards against partial-commit dups).
    orch2.onTurnEnd();
    await runner2.drain();
    await orch2.shutdown();
    expect(runner2.calls.filter((c) => c.role === 'observer').length).toBe(2);
  });

  it('still re-runs the LLM once on a WORKER (LLM) failure (behavior unchanged)', async () => {
    const flaky = new MockRunner(
      {
        result: (i: WorkerInput) => ({ runId: i.runId, ok: true, observations: drafts('ok note') }),
        failFirst: 1,
      },
      okConsolidator,
    );
    const orch2 = new OmOrchestrator({
      config: baseConfig,
      sessionId: 's-m6c',
      history,
      ledger,
      runner: flaky,
      memory,
      sink,
    });
    orch2.setEnabled(true);
    history.add('m1', 'aaaaaaaaaa');
    orch2.onTurnEnd();
    await flaky.drain();
    await orch2.shutdown();

    expect(flaky.calls.filter((c) => c.role === 'observer').length).toBe(2); // 1 attempt + 1 retry
    expect(ledger.read('om.observation').length).toBe(1);
    expect(ledger.read('om.lastError')).toEqual([]);
  });
});
