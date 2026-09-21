import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { OmOrchestrator } from '../../src/core/orchestrator.js';
import { resolveConfig, type OmConfig } from '../../src/core/config.js';
import { MemoryStore } from '../../src/core/memory-store.js';
import type { EventSink, WorkerInput } from '../../src/core/types.js';
import { MockHistory, MockLedger, MockRunner } from '../fixtures/mocks.js';

// chunkTokens 1000; early min 30; consolidation/compaction far away.
const baseConfig: OmConfig = resolveConfig({
  chunkTokens: 1000,
  earlyActivation: { enabled: true, idleMs: 120, minUnobservedTokens: 30 },
  consolidateAtPoolTokens: 1_000_000,
  compactAtContextTokens: 1_000_000,
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeRunner() {
  return new MockRunner(
    {
      result: (input: WorkerInput) => ({
        runId: input.runId,
        ok: true,
        observations: [`early obs from ${input.chunk!.coversUpToId}`],
      }),
    },
    {
      result: (input: WorkerInput) => ({
        runId: input.runId,
        ok: true,
        consolidation: { topics: [], tombstoneIds: [], droppedIds: [], journeyChanged: false },
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
  dir = mkdtempSync(path.join(tmpdir(), 'om-early-'));
  memory = new MemoryStore(dir);
  sink = new CaptureSink();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function makeOrch(runner: MockRunner, history: MockHistory) {
  const orch = new OmOrchestrator({
    config: baseConfig,
    sessionId: 'sess-early',
    history,
    ledger: new MockLedger(),
    runner,
    memory,
    sink,
  });
  orch.setEnabled(true);
  return orch;
}

describe('early activation (v2)', () => {
  it('model_select observes below the regular chunk threshold', async () => {
    const runner = makeRunner();
    const history = new MockHistory({ chunkTokens: 1000 });
    const orch = makeOrch(runner, history);
    // 500 chars (~500 identity tokens) of new history: below chunkTokens=1000
    history.add('m1', 'a'.repeat(500));

    // normal turn: no observer yet (below threshold, idle timer not yet fired)
    orch.onTurnEnd();
    expect(runner.calls.filter((c) => c.role === 'observer')).toEqual([]);

    orch.onModelChange();
    await orch.shutdown();

    const obs = runner.calls.filter((c) => c.role === 'observer');
    expect(obs.length).toBe(1);
    expect(obs[0]!.input.chunk!.coversUpToId).toBe('m1');
    expect(obs[0]!.input.chunk!.text).toHaveLength(500);
    expect(sink.errors).toEqual([]);
  });

  it('idle timer triggers an early observation when the user goes quiet', async () => {
    const runner = makeRunner();
    const history = new MockHistory({ chunkTokens: 1000 });
    const orch = makeOrch(runner, history);
    history.add('m1', 'b'.repeat(400));
    history.idle = true;
    orch.onTurnEnd();
    expect(runner.calls.filter((c) => c.role === 'observer')).toEqual([]);

    await sleep(300); // > idleMs (120)
    await orch.shutdown();

    const obs = runner.calls.filter((c) => c.role === 'observer');
    expect(obs.length).toBe(1);
    expect(obs[0]!.input.chunk!.coversUpToId).toBe('m1');
  });

  it('no early activation below minUnobservedTokens', async () => {
    const runner = makeRunner();
    const history = new MockHistory({ chunkTokens: 1000 });
    const orch = makeOrch(runner, history);
    history.add('m1', 'c'.repeat(20)); // 20 < min 30
    history.idle = true;
    orch.onTurnEnd();
    orch.onModelChange();
    await sleep(300);
    await orch.shutdown();
    expect(runner.calls.filter((c) => c.role === 'observer')).toEqual([]);
  });

  it('early activation disabled by config does nothing', async () => {
    const cfg = resolveConfig({
      ...baseConfig,
      earlyActivation: { enabled: false, idleMs: 120, minUnobservedTokens: 30 },
    });
    const runner = makeRunner();
    const history = new MockHistory({ chunkTokens: 1000 });
    const orch = new OmOrchestrator({
      config: cfg,
      sessionId: 'sess-early-off',
      history,
      ledger: new MockLedger(),
      runner,
      memory,
      sink,
    });
    orch.setEnabled(true);
    history.add('m1', 'd'.repeat(500));
    history.idle = true;
    orch.onTurnEnd();
    orch.onModelChange();
    await sleep(300);
    await orch.shutdown();
    expect(runner.calls.filter((c) => c.role === 'observer')).toEqual([]);
  });
});
