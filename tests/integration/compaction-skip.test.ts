/**
 * Compaction drain fast path (R5, ported from pi-observational-memory's
 * canSkipObserverWait, MIT) + FR-3.4 tail-boundary snap invariants:
 *
 *  - an in-flight observer whose WHOLE slice lies in the verbatim tail
 *    (fromId > tail boundary) does NOT delay the compaction;
 *  - an in-flight observer covering pre-tail history (slice straddles or
 *    ends at/before the boundary) IS awaited before rendering;
 *  - the rendered block and the verbatim tail are disjoint and together
 *    cover the whole history (no "hole", no double representation).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { OmOrchestrator } from '../../src/core/orchestrator.js';
import { resolveConfig, type OmConfig } from '../../src/core/config.js';
import { MemoryStore } from '../../src/core/memory-store.js';
import { MockHistory, MockLedger, drafts } from '../fixtures/mocks.js';
import type {
  CompactionBlock,
  EventSink,
  ModelRunner,
  Role,
  WorkerInput,
  WorkerResult,
} from '../../src/core/types.js';

const cfg: OmConfig = resolveConfig({
  chunkTokens: 10,
  poolTargetTokens: 50000,
  consolidateAtPoolTokens: 100000, // keep auto-consolidation off
  compactAtContextTokens: 1000,
  tailTokens: 50,
  extractors: [],
  gapMarkers: { enabled: false, thresholdMs: 600000 },
  earlyActivation: { enabled: false, idleMs: 600000, minUnobservedTokens: 100 },
  reflector: { enabled: false, idleMs: 600000, minIntervalMs: 3600000 },
});

/** Observer run gated behind a manual release (deterministic in-flight). */
class GatedRunner implements ModelRunner {
  calls: WorkerInput[] = [];
  pending = false;
  private gate: Promise<void> = Promise.resolve();
  private releaseFn: (() => void) | null = null;

  hold(): void {
    this.gate = new Promise<void>((r) => (this.releaseFn = r));
  }
  release(): void {
    this.releaseFn?.();
  }
  async run(role: Role, input: WorkerInput): Promise<WorkerResult> {
    this.calls.push(input);
    if (role !== 'observer') {
      return {
        runId: input.runId,
        ok: true,
        consolidation: { topics: [], tombstoneIds: [], droppedIds: [], journeyChanged: false },
      };
    }
    this.pending = true;
    await this.gate;
    this.pending = false;
    return { runId: input.runId, ok: true, observations: drafts(`obs ${input.chunk!.coversUpToId}`) };
  }
  async drain(): Promise<void> {
    // Subprocess-level drain is a no-op in the mock; the orchestrator tracks
    // its own in-flight tasks (that is what the drain fast path skips).
  }
}

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
let history: MockHistory;
let ledger: MockLedger;
let memory: MemoryStore;
let sink: CaptureSink;
let runner: GatedRunner;
let orch: OmOrchestrator;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 6 messages × 15 tokens = 90; tail window 50 → raw boundary m3 (tail m4+m5+m6). */
function addHistory(): void {
  history.add('m1', 'a'.repeat(15));
  history.add('m2', 'b'.repeat(15));
  history.add('m3', 'c'.repeat(15));
  history.add('m4', 'd'.repeat(15));
  history.add('m5', 'e'.repeat(15));
  history.add('m6', 'f'.repeat(15));
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'om-skip-'));
  history = new MockHistory({ chunkTokens: cfg.chunkTokens });
  ledger = new MockLedger();
  memory = new MemoryStore(dir);
  sink = new CaptureSink();
  runner = new GatedRunner();
  orch = new OmOrchestrator({
    config: cfg,
    sessionId: 'session-skip',
    history,
    ledger,
    runner,
    memory,
    sink,
    clock: { now: () => new Date('2025-09-21T12:00:00Z') },
  });
  orch.setEnabled(true);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Commit N single-message chunks (chunkTokens 10 < 15 → 1 message per chunk). */
async function commitChunks(n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    orch.onTurnEnd();
    await orch.shutdown();
  }
}

describe('compaction drain fast path (R5)', () => {
  it('WAITS for an in-flight observer whose slice reaches the pre-tail region', async () => {
    addHistory();
    // No committed chunk yet → tail boundary is the raw one (m3); the first
    // chunk [m1] lies entirely BEFORE it → its observations matter.
    runner.hold();
    orch.onTurnEnd();
    expect(runner.pending).toBe(true);

    const p = orch.forceCompact();
    await sleep(30);
    let settled = false;
    p.then(() => (settled = true));
    expect(settled).toBe(false); // still waiting for the observer

    runner.release();
    await p;
    expect(settled).toBe(true);
    // The just-committed observation made it into the rendered block —
    // that is exactly why the wait exists.
    expect(sink.blocks.length).toBe(1);
    expect(sink.blocks[0]!.observations).toContain('obs m1');
  });

  it('SKIPS an in-flight observer whose slice is fully inside the verbatim tail', async () => {
    addHistory();
    await commitChunks(3); // committed boundaries: m1, m2, m3 (= raw boundary)
    runner.hold();
    orch.onTurnEnd(); // chunk [m4]: fromId m4 > boundary m3 → in the tail
    expect(runner.pending).toBe(true);

    const p = orch.forceCompact();
    await p; // resolves while the observer is still in flight
    expect(runner.pending).toBe(true);
    expect(sink.blocks.length).toBe(1);
    const b = sink.blocks[0]!;
    // Not committed yet — and its slice is verbatim in the tail: no loss.
    expect(b.observations).not.toContain('obs m4');
    expect(b.verbatimTail).toContain('d'.repeat(15));

    runner.release();
    await orch.shutdown();
    // After the late commit the observation exists but stays OUT of future
    // pre-tail renders (its slice is in the tail) — no double representation.
    const stored = ledger.read('om.observation').map((e) => e.data);
    expect(stored.some((o) => o.coversUpToId === 'm4')).toBe(true);
    expect(stored.filter((o) => o.coversUpToId > 'm3').length).toBe(1);
  });

  it('still waits for a non-observer worker even when observers are skippable', async () => {
    addHistory();
    await commitChunks(3);
    // A consolidator in flight changes the pool → must be awaited.
    let releaseCons!: () => void;
    const consGate = new Promise<void>((r) => (releaseCons = r));
    const orig = runner.run.bind(runner);
    runner.run = async (role, input) => {
      if (role === 'consolidator') await consGate;
      return orig(role, input);
    };
    runner.hold(); // observer [m4] skippable (slice in the tail)
    orch.onTurnEnd();
    orch.forceConsolidate();
    const p = orch.forceCompact();
    await sleep(30);
    let settled = false;
    p.then(() => (settled = true));
    expect(settled).toBe(false); // waiting for the consolidator

    releaseCons();
    runner.release();
    await p;
    expect(settled).toBe(true);
  });
});

describe('FR-3.4 invariants: block ∩ tail = ∅, block ∪ tail = whole history', () => {
  it('the tail boundary snaps to a committed chunk boundary (never straddles a chunk)', async () => {
    addHistory();
    await commitChunks(3);
    const { tailBoundaryId } = orch.compactionPlan();
    // Raw token boundary is m3; a committed chunk end — no chunk straddles it.
    expect(tailBoundaryId).toBe('m3');
  });

  it('no double representation and no hole (∅ intersection, ∪ = history)', async () => {
    addHistory();
    await commitChunks(3);
    const { block, tailBoundaryId } = orch.compactionPlan();
    const boundary = tailBoundaryId;
    expect(boundary).not.toBe('');

    const stored = ledger.read('om.observation').map((e) => e.data);
    expect(stored.length).toBeGreaterThan(0);

    // 1) DISJOINT: no rendered observation covers the verbatim-tail region.
    for (const o of stored) {
      expect(o.coversUpToId <= boundary, `observation ${o.id} straddles the tail`).toBe(true);
    }
    // every message strictly after the boundary is in the verbatim tail
    const tailMsgs = history.messages.filter((m) => m.id > boundary);
    expect(tailMsgs.length).toBeGreaterThan(0);
    for (const m of tailMsgs) expect(block.verbatimTail).toContain(m.text);

    // 2) NO HOLE: the committed watermark covers everything at-or-before the
    // boundary (chunks are contiguous from the start of history), so nothing
    // falls between the observation block and the verbatim tail.
    const maxCov = stored.reduce((mx, o) => (o.coversUpToId > mx ? o.coversUpToId : mx), '');
    const preTail = history.messages.filter((m) => m.id <= boundary);
    expect(preTail.length).toBeGreaterThan(0);
    expect(preTail[preTail.length - 1]!.id <= maxCov).toBe(true);
  });
});
