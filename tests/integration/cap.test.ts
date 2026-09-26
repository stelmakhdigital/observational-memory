/**
 * audit M3: pool hard cap + compaction-block budget.
 *
 * Invariant under test: even when the consolidator is permanently failing and
 * the pool grows past poolHardCapTokens, the compaction block (observations
 * part) stays within maxCompactBlockTokens — so the post-compaction context
 * (block + tail) does not exceed the pre-compaction context.
 *
 * Plus the runs-counter fix (smoke-bug #2): zero-cost runs are counted.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MockHistory, MockLedger, MockRunner, type ScriptedRun } from '../fixtures/mocks.js';
import { OmOrchestrator } from '../../src/core/orchestrator.js';
import { MemoryStore } from '../../src/core/memory-store.js';
import { resolveConfig } from '../../src/core/config.js';
import { estimateTokens } from '../../src/core/tokens.js';
import type { CompactionBlock, EventSink, ObservationDraft, WorkerInput, WorkerResult } from '../../src/core/types.js';

const base = {
  chunkTokens: 60, // 5 messages of 12 tokens each
  poolTargetTokens: 100,
  consolidateAtPoolTokens: 200,
  poolHardCapTokens: 400, // below the pool we will build (~950)
  maxCompactBlockTokens: 250,
  compactAtContextTokens: 1000,
  tailTokens: 200,
  journeyTargetTokens: 100,
  extractors: [],
  gapMarkers: { enabled: false },
  earlyActivation: { enabled: false },
  reflector: { enabled: false },
};

// ~235 chars ≈ 58-59 estimated tokens each; two per chunk ≈ 117 tokens/chunk.
const A =
  'The user refactored the settings module so that per-session JSON files override ' +
  'the global fallback layer and the merge order is documented in the README section';
const B =
  'Decision recorded: workers are launched as headless subprocesses with a scoped ' +
  'tool set and the result is parsed from the last assistant message of the session';

class CaptureSink implements EventSink {
  blocks: CompactionBlock[] = [];
  onStatus() {}
  onRunStarted() {}
  onRunFinished() {}
  onError() {}
  onCompactionBlock(b: CompactionBlock) {
    this.blocks.push(b);
  }
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'om-cap-'));
});

const settle = (ms = 40) => new Promise<void>((r) => setTimeout(r, ms));

function makeSession(
  configOverrides: Partial<typeof base> = {},
  opts: { consolidatorOk?: boolean; observerCostUsd?: number } = {},
) {
  const { consolidatorOk = true, observerCostUsd = 0.01 } = opts;
  const history = new MockHistory({ chunkTokens: base.chunkTokens, overlapTokens: 0 });
  const observer: ScriptedRun = {
    result: (input: WorkerInput) => ({
      runId: input.runId,
      ok: true,
      ...(observerCostUsd !== undefined ? { costUsd: observerCostUsd } : {}),
      observations: [
        { text: A, priority: 'routine' },
        { text: B, priority: 'routine' },
      ] as ObservationDraft[],
    }),
  };
  const consolidator: ScriptedRun = {
    result: (input: WorkerInput): WorkerResult =>
      consolidatorOk
        ? {
            runId: input.runId,
            ok: true,
            costUsd: 0.01,
            consolidation: {
              topics: ['topic-a.md'],
              tombstoneIds: input.pool!.observations.map((o) => o.id),
              droppedIds: [],
              journeyChanged: false,
            },
          }
        : { runId: input.runId, ok: false, error: 'consolidator is down (scripted)' },
  };
  const runner = new MockRunner(observer, consolidator);
  const sink = new CaptureSink();
  const cfg = resolveConfig({ ...base, ...configOverrides } as never);
  const memory = new MemoryStore(dir);
  const ledger = new MockLedger();
  const orch = new OmOrchestrator({
    config: cfg,
    sessionId: 'sess-cap',
    history,
    ledger,
    runner,
    memory,
    sink,
  });
  return { history, runner, sink, cfg, ledger, orch };
}

describe('M3: pool hard cap + compact-block budget', () => {
  it('caps the compaction block and keeps post-compaction context below pre-compaction', async () => {
    // consolidator is PERMANENTLY failing → the pool grows past the hard cap
    const { history, runner, sink, cfg, orch } = makeSession({}, { consolidatorOk: false });
    orch.setEnabled(true);
    for (let r = 0; r < 8; r++) {
      for (let i = 0; i < 5; i++) history.add(`m${r}-${i}`, 'x'.repeat(12));
      orch.onTurnEnd();
      await settle();
    }

    // 1) the pool is bloated: well past both the regular threshold and the cap
    expect(orch.status().poolTokens).toBeGreaterThan(cfg.poolHardCapTokens);

    // 2) the consolidator was forced repeatedly (pool stays > threshold)
    const consCalls = runner.calls.filter((c) => c.role === 'consolidator').length;
    expect(consCalls).toBeGreaterThanOrEqual(2);
    expect(orch.status().lastError).not.toBeNull();

    // 3) compaction: pre-compaction context ≥ compactAtContextTokens
    const tokensBefore = 1000;
    history.contextTokens = tokensBefore;
    history.idle = true;
    await orch.onAgentEnd();
    expect(sink.blocks.length).toBe(1);
    const block = sink.blocks[0]!;

    // the observations part of the block is within the budget.
    // Exact check over the kept observations' own tokenCounts (rendering adds
    // only the stable [id] prefix), plus an estimate check with that overhead.
    const lines = block.observations.split('\n').filter(Boolean);
    const keptIds = lines
      .map((l) => l.match(/^\[(om-[^\]]+)\]/)?.[1])
      .filter((x): x is string => Boolean(x));
    const stored = (orch as unknown as { d: { ledger: MockLedger } }).d.ledger
      .read('om.observation')
      .map((e) => e.data);
    const byId = new Map(stored.map((o) => [o.id, o.tokenCount] as const));
    const keptTokens = keptIds.reduce((sum, id) => sum + (byId.get(id) ?? 0), 0);
    expect(keptTokens).toBeLessThanOrEqual(cfg.maxCompactBlockTokens);
    expect(estimateTokens(block.observations)).toBeLessThanOrEqual(
      cfg.maxCompactBlockTokens + 15 * lines.length, // [id] prefix overhead per line
    );
    // the trim actually kicked in (8 chunks × 2 observations committed, 8 pre-tail)
    expect(keptIds.length).toBeGreaterThan(0);
    expect(keptIds.length).toBeLessThan(8);

    // 4) THE invariant: context after compaction ≤ context before
    expect(estimateTokens(block.text)).toBeLessThan(tokensBefore);
  });

  it('inject: full — no trim when the pre-tail pool fits the budget', async () => {
    // failing consolidator so the pool keeps all its observations; 7 rounds →
    // 3 chunks before the tail boundary (tail 200 covers the rest)
    const { history, orch } = makeSession({ maxCompactBlockTokens: 100000 }, { consolidatorOk: false });
    orch.setEnabled(true);
    for (let r = 0; r < 7; r++) {
      for (let i = 0; i < 5; i++) history.add(`m${r}-${i}`, 'x'.repeat(12));
      orch.onTurnEnd();
      await settle();
    }
    const block = orch.compactBlock();
    expect(block.observations.split('\n').filter(Boolean).length).toBe(6);
  });

  it('explicit poolHardCapTokens / maxCompactBlockTokens are honored', () => {
    const { cfg } = makeSession({ poolHardCapTokens: 350, maxCompactBlockTokens: 80 });
    expect(cfg.poolHardCapTokens).toBe(350);
    expect(cfg.maxCompactBlockTokens).toBe(80);
  });
});

describe('runs counter (smoke-bug #2): zero-cost runs are counted', () => {
  it('2 runs with $0 cost → runs=2, costUsd=$0', async () => {
    const { history, orch } = makeSession(
      { consolidateAtPoolTokens: 100000, poolHardCapTokens: 300000 }, // no consolidation
      { observerCostUsd: 0 }, // free/local model → $0 reported
    );
    orch.setEnabled(true);
    for (let r = 0; r < 2; r++) {
      for (let i = 0; i < 5; i++) history.add(`m${r}-${i}`, 'x'.repeat(12));
      orch.onTurnEnd();
      await settle();
    }
    const s = orch.status();
    expect(s.runs).toBe(2);
    expect(s.costUsd).toBe(0);
    const costs = (orch as unknown as { d: { ledger: MockLedger } }).d.ledger.read('om.cost');
    expect(costs.map((e) => e.data.usd)).toEqual([0, 0]);
  });
});
