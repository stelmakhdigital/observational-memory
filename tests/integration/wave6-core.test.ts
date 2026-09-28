/**
 * Wave 6 (core): R4 real observer parallelism + R5 status/seq optimizations.
 *
 * R4:
 *  (a) concurrency=2 → two observers in flight after one pump; the third
 *      slice is dispatched only after a commit;
 *  (b) a slice that failed (attempt + retry) is SKIPPED on the next pump
 *      (lastError set, no second LLM attempt — anti cost-loop);
 *  (c) concurrency=1 → legacy one-slice-per-pump behavior;
 *  (d) the dispatch cursor does not affect the compaction render (it stays
 *      committed-watermark based).
 *
 * R5:
 *  (a) per-second seq counters: 1..N within one second + rebuild at
 *      orchestrator restart (continues from the ledger);
 *  (b) status() caching: no ledger reads on repeated status() calls; a
 *      consolidator run (worker-written files) forces a re-read.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { OmOrchestrator } from '../../src/core/orchestrator.js';
import { resolveConfig, type OmConfig } from '../../src/core/config.js';
import { MemoryStore } from '../../src/core/memory-store.js';
import type {
  CompactionBlock,
  EventSink,
  LedgerEntryType,
  LedgerStore,
  ModelRunner,
  OmStatus,
  RunInfo,
  TypedLedgerEntry,
  WorkerInput,
  WorkerResult,
} from '../../src/core/types.js';
import {
  MockHistory,
  MockLedger,
  MockRunner,
  drafts,
  consolidatorRun,
  sleep,
  type ScriptedRun,
} from '../fixtures/mocks.js';

const FROZEN = { now: () => new Date('2025-09-21T12:00:00Z') };

const base: OmConfig = resolveConfig({
  chunkTokens: 10,
  poolTargetTokens: 5, // tiny → forceConsolidate always finds something
  consolidateAtPoolTokens: 100000, // keep auto-consolidation off
  compactAtContextTokens: 10000,
  tailTokens: 50,
  extractors: [],
  gapMarkers: { enabled: false, thresholdMs: 600000 },
  earlyActivation: { enabled: false, idleMs: 600000, minUnobservedTokens: 100 },
  reflector: { enabled: false, idleMs: 600000, minIntervalMs: 3600000 },
});

class CaptureSink implements EventSink {
  statuses: OmStatus[] = [];
  blocks: CompactionBlock[] = [];
  errors: Error[] = [];
  onStatus(s: OmStatus) {
    this.statuses.push(s);
  }
  onCompactionBlock(b: CompactionBlock) {
    this.blocks.push(b);
  }
  onRunStarted(_r: RunInfo) {}
  onRunFinished(_r: RunInfo, _w: WorkerResult) {}
  onError(e: Error) {
    this.errors.push(e);
  }
}

/** Observer runner gated behind a manual release (deterministic in-flight). */
class GatedObserverRunner implements ModelRunner {
  calls: WorkerInput[] = [];
  private gate: Promise<void> = Promise.resolve();
  private releaseFn: (() => void) | null = null;
  hold(): void {
    this.gate = new Promise<void>((r) => (this.releaseFn = r));
  }
  release(): void {
    this.releaseFn?.();
  }
  async run(role: string, input: WorkerInput): Promise<WorkerResult> {
    if (role !== 'observer') {
      return {
        runId: input.runId,
        ok: true,
        consolidation: { topics: [], tombstoneIds: [], droppedIds: [], journeyChanged: false },
      };
    }
    this.calls.push(input);
    await this.gate;
    return { runId: input.runId, ok: true, observations: drafts(`obs ${input.chunk!.coversUpToId}`) };
  }
  async drain(): Promise<void> {}
}

let dir: string;
let memory: MemoryStore;
let sink: CaptureSink;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'om-w6-'));
  memory = new MemoryStore(dir);
  sink = new CaptureSink();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function makeOrch(
  opts: {
    history: MockHistory;
    ledger: LedgerStore;
    runner: ModelRunner;
    concurrency?: number;
  },
  sessionId = 's-w6',
) {
  const orch = new OmOrchestrator({
    config: resolveConfig({ ...base, observerConcurrency: opts.concurrency ?? base.observerConcurrency }),
    sessionId,
    history: opts.history,
    ledger: opts.ledger,
    runner: opts.runner,
    memory,
    sink,
    clock: FROZEN,
  });
  orch.setEnabled(true);
  return orch;
}

const slowObserver: ScriptedRun = {
  delayMs: 40,
  result: (input) => ({ runId: input.runId, ok: true, observations: drafts(`obs ${input.chunk!.coversUpToId}`) }),
};

describe('R4: real observer parallelism', () => {
  it('(a) concurrency=2: two observers in flight after one pump, the third slice waits for a commit', async () => {
    const history = new MockHistory({ chunkTokens: 10 });
    history.add('m1', 'a'.repeat(10));
    history.add('m2', 'b'.repeat(10));
    history.add('m3', 'c'.repeat(10));
    const ledger = new MockLedger();
    const runner = new MockRunner(slowObserver, consolidatorRun());
    const orch = makeOrch({ history, ledger, runner, concurrency: 2 });

    orch.onTurnEnd();
    // one pump dispatches up to `concurrency` consecutive slices
    expect(runner.calls.filter((c) => c.role === 'observer').length).toBe(2);
    expect(orch.status().inFlight.length).toBe(2); // two in parallel
    expect(ledger.read('om.observation')).toEqual([]);

    await sleep(80); // both commits land
    expect(ledger.read('om.observation').length).toBe(2);
    expect(orch.status().inFlight.length).toBe(0);

    // the third slice is dispatched on the NEXT pump (after a commit)
    orch.onTurnEnd();
    expect(runner.calls.filter((c) => c.role === 'observer').length).toBe(3);
    await sleep(80);
    expect(ledger.read('om.observation').map((e) => e.data.coversUpToId).sort()).toEqual(['m1', 'm2', 'm3']);
  });

  it('(b) a slice that failed (attempt + retry) is skipped on the next pump, no cost-loop', async () => {
    const history = new MockHistory({ chunkTokens: 10 });
    const ledger = new MockLedger();
    const dead = new MockRunner(
      {
        result: (input): WorkerResult =>
          input.chunk!.coversUpToId === 'm1'
            ? { runId: input.runId, ok: false, error: 'observer down' }
            : { runId: input.runId, ok: true, observations: drafts(`obs ${input.chunk!.coversUpToId}`) },
      },
      consolidatorRun(),
    );
    const orch = makeOrch({ history, ledger, runner: dead, concurrency: 2 });

    history.add('m1', 'a'.repeat(10));
    orch.onTurnEnd();
    await dead.drain();
    // m1: attempt + its retry = 2 LLM calls, no observation
    expect(dead.calls.filter((c) => c.role === 'observer').length).toBe(2);
    expect(ledger.read('om.observation')).toEqual([]);
    expect(orch.status().lastError).not.toBeNull();

    history.add('m2', 'b'.repeat(10));
    orch.onTurnEnd(); // next pump: m1's history is skipped, m2 observed
    await dead.drain();
    expect(dead.calls.filter((c) => c.role === 'observer').length).toBe(3); // m1×2 + m2×1
    const obs = ledger.read('om.observation');
    expect(obs.length).toBe(1);
    expect(obs[0]!.data.coversUpToId).toBe('m2');

    // anti cost-loop: further pumps do NOT re-run the failed slice
    orch.onTurnEnd();
    await dead.drain();
    expect(dead.calls.filter((c) => c.role === 'observer').length).toBe(3);
  });

  it('(c) concurrency=1: one slice per pump (legacy behavior)', async () => {
    const history = new MockHistory({ chunkTokens: 10 });
    const ledger = new MockLedger();
    const runner = new MockRunner(slowObserver, consolidatorRun());
    const orch = makeOrch({ history, ledger, runner, concurrency: 1 });

    history.add('m1', 'a'.repeat(10));
    history.add('m2', 'b'.repeat(10));
    orch.onTurnEnd();
    expect(runner.calls.filter((c) => c.role === 'observer').length).toBe(1);
    expect(runner.calls[0]!.input.chunk!.coversUpToId).toBe('m1');
    await sleep(80);
    expect(ledger.read('om.observation').length).toBe(1);

    orch.onTurnEnd(); // next slice only after the commit
    expect(runner.calls.filter((c) => c.role === 'observer').length).toBe(2);
    await sleep(80);
    expect(ledger.read('om.observation').length).toBe(2);
  });

  it('(d) dispatched (in-flight, uncommitted) slices do not affect the compaction render', async () => {
    const history = new MockHistory({ chunkTokens: 10 });
    const ledger = new MockLedger();
    const runner = new GatedObserverRunner();
    const orch = makeOrch({ history, ledger, runner, concurrency: 2 });

    // 6 × 10 = 60 tokens > tailTokens 50 → raw tail boundary = m0
    for (const [id, ch] of [['m0', 'a'], ['m1', 'b'], ['m2', 'c'], ['m3', 'd'], ['m4', 'e'], ['m5', 'f']] as const) {
      history.add(id, ch.repeat(10));
    }
    runner.hold();
    orch.onTurnEnd();
    expect(runner.calls.length).toBe(2); // m0, m1 dispatched (uncommitted)

    // status still counts from the COMMITTED watermark (empty pool)
    const s = orch.status();
    expect(s.activeObservations).toBe(0);
    expect(s.nextObserverInTokens).toBe(0); // all 60 tokens unobserved

    // the block renders uncommitted history verbatim, not as observations
    const b = orch.compactBlock();
    expect(b.observations).not.toContain('obs m0');

    runner.release();
    await sleep(10);
    expect(ledger.read('om.observation').length).toBe(2);
    const b2 = orch.compactBlock();
    expect(b2.observations).toContain('obs m0'); // now committed → rendered (pre-tail)
  });
});

describe('R5: seq counters and status cache', () => {
  it('(a) seq continues 1..N within one second and rebuilds on orchestrator restart', async () => {
    const history = new MockHistory({ chunkTokens: 10 });
    const ledger = new MockLedger();
    const runner = new MockRunner(
      { result: (i) => ({ runId: i.runId, ok: true, observations: drafts('one', 'two', 'three') }) },
      consolidatorRun(),
    );
    const orch1 = makeOrch({ history, ledger, runner }, 's-w6-seq1');
    history.add('m1', 'a'.repeat(10));
    orch1.onTurnEnd();
    await runner.drain();
    const ids1 = ledger.read('om.observation').map((e) => e.data.id);
    expect(ids1).toEqual(['om-20250921120000-1', 'om-20250921120000-2', 'om-20250921120000-3']);

    // "restart": a fresh orchestrator on the same ledger rebuilds the
    // counters and continues the seq (4), not 1
    const runner2 = new MockRunner(
      { result: (i) => ({ runId: i.runId, ok: true, observations: drafts('after restart') }) },
      consolidatorRun(),
    );
    const orch2 = new OmOrchestrator({
      config: base,
      sessionId: 's-w6-seq1',
      history,
      ledger,
      runner: runner2,
      memory,
      sink,
      clock: FROZEN,
    });
    orch2.setEnabled(true);
    history.add('m2', 'b'.repeat(10));
    orch2.onTurnEnd();
    await runner2.drain();
    const ids2 = ledger.read('om.observation').map((e) => e.data.id);
    expect(ids2[3]).toBe('om-20250921120000-4');
  });

  it('(b) status() is cached: no ledger reads until the next of our own mutations', async () => {
    const history = new MockHistory({ chunkTokens: 10 });
    const inner = new MockLedger();
    let reads = 0;
    const counting: LedgerStore = {
      append<T extends LedgerEntryType>(entry: TypedLedgerEntry<T>): void {
        inner.append(entry);
      },
      read<T extends LedgerEntryType>(type?: T): TypedLedgerEntry<T>[] {
        reads++;
        return inner.read(type);
      },
      tombstone(ids: string[], report: Parameters<LedgerStore['tombstone']>[1]): void {
        inner.tombstone(ids, report);
      },
    };
    const runner = new MockRunner(slowObserver, consolidatorRun({ topics: ['topic-a.md'] }));
    const orch = makeOrch({ history, ledger: counting, runner }, 's-w6-cache');

    history.add('m1', 'a'.repeat(10));
    orch.onTurnEnd();
    await sleep(80); // commit
    expect(orch.status().activeObservations).toBe(1);
    expect(reads).toBeGreaterThan(0); // first build

    reads = 0;
    const a = orch.status();
    const b = orch.status();
    expect(reads).toBe(0); // cache hit — no ledger reads
    expect(b.activeObservations).toBe(a.activeObservations);
    expect(b.costUsd).toBe(a.costUsd);

    // a consolidator run (workers write topic files directly) forces a
    // re-read once it finishes
    reads = 0;
    orch.forceConsolidate();
    await sleep(80);
    expect(reads).toBeGreaterThan(0);
    reads = 0;
    orch.status();
    expect(reads).toBe(0); // cached again after the rebuild
  });
});
