/**
 * Wave-2 core fixes:
 *  - R8: ensureSeeded sets the flag only after success (a failing seedFrom is
 *    retried on the next enable);
 *  - R9: gap-marker dedup survives a host restart (prevAt persisted in the
 *    marker, restored at orchestrator init);
 *  - A5: drainForCompaction() quiescently waits for in-flight observers so a
 *    block rendered afterwards is complete.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { OmOrchestrator } from '../../src/core/orchestrator.js';
import { resolveConfig, type OmConfig } from '../../src/core/config.js';
import { MemoryStore } from '../../src/core/memory-store.js';
import type {
  EventSink,
  MemoryRoot,
  Role,
  WorkerInput,
  WorkerResult,
} from '../../src/core/types.js';
import { MockHistory, MockLedger, drafts } from '../fixtures/mocks.js';

const baseConfig: OmConfig = resolveConfig({
  chunkTokens: 10,
  poolTargetTokens: 5,
  consolidateAtPoolTokens: 100,
  compactAtContextTokens: 100,
  tailTokens: 50,
});

class NoopSink implements EventSink {
  onStatus() {}
  onCompactionBlock() {}
  onRunStarted() {}
  onRunFinished() {}
  onError() {}
}

const noopRunner = {
  calls: 0,
  async run(_role: Role, _input: WorkerInput): Promise<WorkerResult> {
    this.calls++;
    return { runId: '', ok: true, observations: [] };
  },
  async drain() {},
};

let dir: string;
let memory: MemoryStore;
let sink: NoopSink;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'om-wave2-'));
  memory = new MemoryStore(dir);
  sink = new NoopSink();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('R8: ensureSeeded retries after a failing seed', () => {
  it('a throwing seedFrom does not set the seeded flag — the next enable retries', () => {
    let calls = 0;
    const memoryStub = {
      seedFrom: (): boolean => {
        calls++;
        throw new Error('simulated fs failure');
      },
      sessionDir: () => '/nonexistent',
      listTopics: () => [] as never[],
      listExtracted: () => [] as string[],
      listSharedTopics: () => [] as never[],
      readJourney: () => '',
      readTopic: () => '',
      loadExtracted: () => undefined,
    } as unknown as MemoryRoot;
    const orch = new OmOrchestrator({
      config: baseConfig,
      sessionId: 's-r8',
      forkParentSessionId: 'parent-1',
      history: new MockHistory({ chunkTokens: 10 }),
      ledger: new MockLedger(),
      runner: noopRunner,
      memory: memoryStub,
      sink,
    });
    expect(() => orch.setEnabled(true)).not.toThrow(); // NFR-1: master is not broken
    expect(calls).toBe(1);
    orch.setEnabled(false);
    orch.setEnabled(true); // second enable must retry the seed
    expect(calls).toBe(2);
  });

  it('a successful seed is not repeated', () => {
    let calls = 0;
    const memoryStub = {
      seedFrom: () => {
        calls++;
        return false; // nothing to copy (parent has no memory)
      },
      sessionDir: () => '/nonexistent',
      listTopics: () => [] as never[],
      listExtracted: () => [] as string[],
      listSharedTopics: () => [] as never[],
      readJourney: () => '',
      readTopic: () => '',
      loadExtracted: () => undefined,
    } as unknown as MemoryRoot;
    const orch = new OmOrchestrator({
      config: baseConfig,
      sessionId: 's-r8b',
      forkParentSessionId: 'parent-1',
      history: new MockHistory({ chunkTokens: 10 }),
      ledger: new MockLedger(),
      runner: noopRunner,
      memory: memoryStub,
      sink,
    });
    orch.setEnabled(true);
    orch.setEnabled(false);
    orch.setEnabled(true);
    expect(calls).toBe(1);
  });
});

describe('R9: gap-marker dedup survives a host restart', () => {
  const cfg = resolveConfig({ ...baseConfig, gapMarkers: { enabled: true, thresholdMs: 60_000 } });

  const make = (sessionId: string, history: MockHistory, ledger: MockLedger) =>
    new OmOrchestrator({
      config: cfg,
      sessionId,
      history,
      ledger,
      runner: noopRunner,
      memory,
      sink,
    });

  it('a fresh orchestrator on the same ledger does not re-mark an already-marked pause', async () => {
    const h = new MockHistory({ chunkTokens: cfg.chunkTokens });
    h.add('m1', 'aaaaaaaaaa', 10, new Date('2025-09-21T09:00:00Z'));
    h.add('m2', 'bbbbbbbbbb', 10, new Date('2025-09-21T12:00:00Z')); // 3-hour pause
    const ledger = new MockLedger();

    const o1 = make('s-r9a', h, ledger);
    o1.setEnabled(true);
    await o1.onAgentEnd();
    expect(ledger.read('om.gap-marker').length).toBe(1);
    const marker = ledger.read('om.gap-marker')[0]!;
    expect(marker.data.prevAt).toBe('2025-09-21T09:00:00.000Z'); // persisted pause start

    // "host restart": a NEW orchestrator over the same ledger
    const o2 = make('s-r9b', h, ledger);
    o2.setEnabled(true);
    await o2.onAgentEnd();
    expect(ledger.read('om.gap-marker').length).toBe(1); // no second marker
  });

  it('a NEW pause (later prevAt) is still marked after restart', async () => {
    const h = new MockHistory({ chunkTokens: cfg.chunkTokens });
    h.add('m1', 'aaaaaaaaaa', 10, new Date('2025-09-21T09:00:00Z'));
    h.add('m2', 'bbbbbbbbbb', 10, new Date('2025-09-21T12:00:00Z')); // 3-hour pause
    const ledger = new MockLedger();

    const o1 = make('s-r9c', h, ledger);
    o1.setEnabled(true);
    await o1.onAgentEnd();
    expect(ledger.read('om.gap-marker').length).toBe(1);

    // The user returns, works, then pauses AGAIN (new prevAt)
    h.add('m3', 'cccccccccc', 10, new Date('2025-09-22T09:00:00Z')); // second pause: prevAt = 12:00
    const o2 = make('s-r9d', h, ledger);
    o2.setEnabled(true);
    await o2.onAgentEnd();
    expect(ledger.read('om.gap-marker').length).toBe(2);
    expect(ledger.read('om.gap-marker')[1]!.data.prevAt).toBe('2025-09-21T12:00:00.000Z');
  });
});

describe('A5: drainForCompaction waits for in-flight observers', () => {
  it('the drain blocks until the observer commits; the committed observation is then rendered', async () => {
    const cfgA5 = resolveConfig({ ...baseConfig, tailTokens: 5, observerConcurrency: 1 });
    const h = new MockHistory({ chunkTokens: cfgA5.chunkTokens });
    const ledger = new MockLedger();
    let release!: (res: WorkerResult) => void;
    const gated = new Promise<WorkerResult>((r) => {
      release = r;
    });
    let runCalls = 0;
    const gatedRunner = {
      async run(_role: Role, _input: WorkerInput): Promise<WorkerResult> {
        runCalls++;
        return gated;
      },
      async drain() {},
    };
    const orch = new OmOrchestrator({
      config: cfgA5,
      sessionId: 's-a5',
      history: h,
      ledger,
      runner: gatedRunner,
      memory,
      sink,
    });
    orch.setEnabled(true);
    h.add('m1', 'aaaaaaaaaa');
    h.add('m2', 'bbbbbbbbbb'); // tail holds m2; the observer covers m1
    orch.onTurnEnd(); // observer launched, still in flight
    expect(orch.status().inFlight.length).toBe(1);
    expect(runCalls).toBe(1);

    const drainP = orch.drainForCompaction();
    // The drain must not resolve while the observer is still in flight.
    let resolved = false;
    void drainP.then(() => {
      resolved = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(resolved).toBe(false);

    release({ runId: 'run-gated', ok: true, observations: drafts('gated observation committed') });
    await drainP;
    expect(resolved).toBe(true);
    expect(orch.status().inFlight.length).toBe(0);
    expect(ledger.read('om.observation').length).toBe(1);
    // The block rendered AFTER the drain contains the observation.
    expect(orch.compactBlock().observations).toContain('gated observation committed');
  });

  it('is a no-op when the orchestrator is disabled', async () => {
    const orch = new OmOrchestrator({
      config: baseConfig,
      sessionId: 's-a5b',
      history: new MockHistory({ chunkTokens: baseConfig.chunkTokens }),
      ledger: new MockLedger(),
      runner: noopRunner,
      memory,
      sink,
    });
    await expect(orch.drainForCompaction()).resolves.toBeUndefined();
  });
});
