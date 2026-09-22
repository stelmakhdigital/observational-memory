import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { OmOrchestrator } from '../../src/core/orchestrator.js';
import { resolveConfig, type OmConfig } from '../../src/core/config.js';
import { MemoryStore } from '../../src/core/memory-store.js';
import type { EventSink, WorkerInput } from '../../src/core/types.js';
import { MockHistory, MockLedger, MockRunner, drafts } from '../fixtures/mocks.js';

const baseConfig: OmConfig = resolveConfig({
  chunkTokens: 10,
  poolTargetTokens: 5,
  consolidateAtPoolTokens: 1000, // off; force manually
  compactAtContextTokens: 100,
  tailTokens: 50,
});

const S = 'sess-ext';

function makeRunner(profileValue: Record<string, unknown>) {
  return new MockRunner(
    {
      result: (input: WorkerInput) => ({
        runId: input.runId,
        ok: true,
        costUsd: 0.01,
        observations: drafts(`obs from ${input.chunk!.coversUpToId}`),
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
          journeyChanged: false,
        },
      }),
    },
    {
      result: (input: WorkerInput) => ({
        runId: input.runId,
        ok: true,
        costUsd: 0.005,
        extraction: { profile: profileValue },
      }),
    },
  );
}

class CaptureSink implements EventSink {
  errors: Error[] = [];
  onStatus() {}
  onCompactionBlock() {}
  onRunStarted() {}
  onRunFinished() {}
  onError(e: Error) {
    this.errors.push(e);
  }
}

let dir: string;
let memory: MemoryStore;
let sink: CaptureSink;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'om-ext-int-'));
  memory = new MemoryStore(dir);
  sink = new CaptureSink();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function settle(orch: OmOrchestrator): Promise<void> {
  await orch.shutdown();
}

describe('extractors (orchestrator integration)', () => {
  it('runs an extractor after a forced consolidation and stores the value', async () => {
    const runner = makeRunner({ lang: 'ru', prefersTabs: true });
    const history = new MockHistory({ chunkTokens: 10 });
    const ledger = new MockLedger();
    const orch = new OmOrchestrator({
      config: baseConfig,
      sessionId: S,
      history,
      ledger,
      runner,
      memory,
      sink,
    });
    orch.restoreEnabled();
    orch.setEnabled(true);
    // ≥ chunkTokens of new history so an observer chunk is emitted
    history.add('m1', 'aaaaaaaaaa');
    history.add('m2', 'bbbb');
    orch.onTurnEnd();
    await settle(orch);
    // force consolidation → triggers extraction
    orch.forceConsolidate();
    await settle(orch);

    const extractedCalls = runner.calls.filter((c) => c.role === 'extractor');
    expect(extractedCalls.length).toBe(1);
    // observations were passed newest-first with specs
    const input = extractedCalls[0]!.input;
    expect(input.extract!.specs.map((s) => s.id)).toEqual(['profile', 'current-task']);
    expect(input.extract!.observations.length).toBeGreaterThan(0);

    const file = path.join(dir, S, 'extracted', 'profile.json');
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ lang: 'ru', prefersTabs: true });
    expect(memory.listExtracted(S)).toEqual(['profile']);
    expect(orch.status().extractedCount).toBe(1);

    // extraction cost recorded
    const costs = ledger.read<'om.cost'>('om.cost').map((e) => e.data);
    expect(costs.some((c) => c.role === 'extractor' && c.usd === 0.005)).toBe(true);
    expect(sink.errors).toEqual([]);
  });

  it('forceExtract() without observations does nothing (no runner call)', async () => {
    const runner = makeRunner({});
    const orch = new OmOrchestrator({
      config: baseConfig,
      sessionId: S,
      history: new MockHistory({ chunkTokens: 10 }),
      ledger: new MockLedger(),
      runner,
      memory,
      sink,
    });
    orch.setEnabled(true);
    orch.forceExtract();
    await settle(orch);
    expect(runner.calls.filter((c) => c.role === 'extractor')).toEqual([]);
  });

  it('extractors disabled by empty config', async () => {
    const cfg = resolveConfig({ ...baseConfig, extractors: [] });
    const runner = makeRunner({ x: 1 });
    const orch = new OmOrchestrator({
      config: cfg,
      sessionId: S,
      history: new MockHistory({ chunkTokens: 10 }),
      ledger: new MockLedger(),
      runner,
      memory,
      sink,
    });
    orch.setEnabled(true);
    orch.forceExtract();
    await settle(orch);
    expect(runner.calls.filter((c) => c.role === 'extractor')).toEqual([]);
  });
});
