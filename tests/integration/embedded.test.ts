import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createOmSession } from '../../src/core/session.js';
import { resolveConfig, type OmConfig } from '../../src/core/config.js';
import type { CompactionBlock, EventSink, WorkerInput } from '../../src/core/types.js';
import { MockHistory, MockRunner, drafts } from '../fixtures/mocks.js';

const baseConfig: OmConfig = resolveConfig({
  chunkTokens: 10,
  poolTargetTokens: 5,
  consolidateAtPoolTokens: 1000, // off; force manually
  compactAtContextTokens: 100,
  tailTokens: 50,
});

function makeRunner() {
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
      // the consolidator is the LLM worker: it writes the topic file itself
      result: (input: WorkerInput) => {
        const dir = input.pool!.sessionDir;
        mkdirSync(dir, { recursive: true });
        const lines = input.pool!.observations.map((o) => `- ${o.content}`).join('\n');
        writeFileSync(
          path.join(dir, 'work.md'),
          `---\ntopic: Work\ndescription: Consolidated work\nsession: embedded\n---\n\n# Work\n${lines}\n`,
          'utf8',
        );
        appendFileSync(path.join(dir, 'JOURNEY.md'), `## Demo segment\nWork was consolidated.\n`, 'utf8');
        return {
          runId: input.runId,
          ok: true,
          costUsd: 0.02,
          consolidation: {
            topics: ['work.md'],
            tombstoneIds: input.pool!.observations.map((o) => o.id),
            droppedIds: [],
            journeyChanged: true,
          },
        };
      },
    },
  );
}

class CaptureSink implements EventSink {
  blocks: CompactionBlock[] = [];
  errors: Error[] = [];
  onStatus() {}
  onCompactionBlock(b: CompactionBlock) {
    this.blocks.push(b);
  }
  onRunStarted() {}
  onRunFinished() {}
  onError(e: Error) {
    this.errors.push(e);
  }
}

let dir: string;
let history: MockHistory;
let sink: CaptureSink;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'om-embedded-'));
  history = new MockHistory({ chunkTokens: 10 });
  sink = new CaptureSink();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function boot() {
  return createOmSession({
    root: dir,
    sessionId: 'embedded-1',
    history,
    runner: makeRunner(),
    config: baseConfig,
    sink,
  });
}

describe('createOmSession (embedded integration)', () => {
  it('runs the full pipeline: observe → consolidate → compact block', async () => {
    const s = boot();
    s.orchestrator.setEnabled(true);

    history.add('m1', 'aaaaaaaaaa');
    history.add('m2', 'bbbb');
    s.orchestrator.onTurnEnd();
    await s.orchestrator.shutdown();

    // observations landed in the JSONL ledger on disk
    const ledgerFile = path.join(dir, 'embedded-1', 'ledger.jsonl');
    expect(existsSync(ledgerFile)).toBe(true);
    expect(s.ledger.read('om.observation').length).toBeGreaterThan(0);

    // consolidation → durable topic files
    s.orchestrator.forceConsolidate();
    await s.orchestrator.shutdown();
    const memDir = path.join(dir, 'embedded-1');
    expect(existsSync(path.join(memDir, 'work.md'))).toBe(true);
    expect(existsSync(path.join(memDir, 'INDEX.md'))).toBe(true);
    expect(existsSync(path.join(memDir, 'JOURNEY.md'))).toBe(true);

    // compaction block renders memory map + journey
    const block = s.orchestrator.compactBlock();
    expect(block.text).toContain('OBSERVATIONAL MEMORY');
    expect(block.text).toContain('Work: Consolidated work'); // memory map from topic front-matter
    expect(block.memoryMap).toContain('Work');
    expect(sink.errors).toEqual([]);
  });

  it('persists the gate: a new session restores enabled state from the ledger', async () => {
    const s1 = boot();
    s1.orchestrator.setEnabled(true);
    expect(s1.orchestrator.isEnabled()).toBe(true);

    // "restart": fresh orchestrator, same root/session
    const s2 = boot();
    expect(s2.orchestrator.isEnabled()).toBe(true);
    s2.orchestrator.setEnabled(false);
    const s3 = boot();
    expect(s3.orchestrator.isEnabled()).toBe(false);
  });

  it('wires sink callbacks and no-op defaults without crashing', async () => {
    const s = createOmSession({
      root: dir,
      sessionId: 'embedded-sink',
      history,
      runner: makeRunner(),
      config: baseConfig,
      // no sink at all: defaults are no-ops
    });
    s.orchestrator.setEnabled(true);
    history.add('m1', 'aaaaaaaaaa');
    s.orchestrator.onTurnEnd();
    await s.orchestrator.shutdown();
    expect(s.orchestrator.status().activeObservations).toBeGreaterThan(0);
  });

  it('forkParentSessionId seeds memory on enable (one-time)', async () => {
    // parent session with a topic file
    const parent = createOmSession({
      root: dir,
      sessionId: 'parent-1',
      history,
      runner: makeRunner(),
      config: baseConfig,
    });
    parent.orchestrator.setEnabled(true);
    parent.memory.saveExtracted('parent-1', 'profile', { lang: 'ru' });
    parent.orchestrator.forceConsolidate();
    await parent.orchestrator.shutdown();

    const child = createOmSession({
      root: dir,
      sessionId: 'child-1',
      forkParentSessionId: 'parent-1',
      history,
      runner: makeRunner(),
      config: baseConfig,
    });
    child.orchestrator.setEnabled(true); // triggers one-time seeding
    expect(child.memory.listExtracted('child-1')).toContain('profile');
    const prof = JSON.parse(
      readFileSync(path.join(dir, 'child-1', 'extracted', 'profile.json'), 'utf8'),
    );
    expect(prof).toEqual({ lang: 'ru' });
  });
});
