import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PiSubprocessRunner, parsePiJsonl, pickReportBody } from '../../src/adapters/pi/runner.js';

let dir: string;
let fakePi: string;

// Fake pi binary: records invocation (env + args) and emits a JSONL event stream;
// role is detected from the prompt.
const fakeScript = `
import fs from 'node:fs';
const args = process.argv.slice(2);
const prompt = args[args.indexOf('--') + 1] ?? '';
const isObserver = prompt.includes('OBSERVER');
const isExtractor = prompt.includes('EXTRACTOR');
const isReflect = prompt.includes('REFLECTOR');
fs.writeFileSync('invocation.json', JSON.stringify({
  omWorker: process.env.OM_WORKER,
  omWorkerDir: process.env.OM_WORKER_DIR,
  hasWorkerExt: args.includes('-e') && args[args.indexOf('-e') + 1].endsWith('worker.ts'),
  noBuiltinTools: args.includes('--no-builtin-tools'),
  model: args[args.indexOf('--model') + 1],
}));
const lines = [];
lines.push(JSON.stringify({ type: 'session', version: 3, id: 'w1', timestamp: 't', cwd: '.' }));
lines.push(JSON.stringify({ type: 'agent_start' }));
lines.push(JSON.stringify({ type: 'message_update', usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 } } }));
const extractorText = 'EXTRACTED_JSON\\n{"profile": {"lang": "ru"}}\\nEND_EXTRACTED_JSON';
const reflectText = 'REFLECTION_REPORT\\ntopics: merged.md\\njourney_changed: true\\nEND_REFLECTION_REPORT';
const text = isExtractor
  ? extractorText
  : isObserver
  ? 'OBSERVATIONS\\n- [P1] fake obs 1\\n- [P2] fake obs 2\\nEND_OBSERVATIONS'
  : isReflect
  ? reflectText
  : 'CONSOLIDATION_REPORT\\ntopics: a.md, b.md\\njourney_changed: true\\nconsumed: om-1, om-2\\ndropped: none\\nEND_CONSOLIDATION_REPORT';
lines.push(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }] } }));
lines.push(JSON.stringify({ type: 'agent_end', messages: [] }));
process.stdout.write(lines.join('\\n') + '\\n');
`;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'om-runner-'));
  writeFileSync(path.join(dir, 'fake-pi.mjs'), fakeScript);
  fakePi = path.join(dir, 'fake-pi.sh');
  writeFileSync(fakePi, `#!/bin/sh\nexec node ${path.join(dir, 'fake-pi.mjs')} "$@"\n`);
  chmodSync(fakePi, 0o755);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const makeRunner = () =>
  new PiSubprocessRunner({
    piBinary: fakePi,
    cwd: dir,
    observerModel: { id: 'test-model' },
    consolidatorModel: { id: 'test-model' },
    timeoutMs: 15_000,
  });

describe('parsePiJsonl', () => {
  it('extracts assistant text and cumulative cost', () => {
    const out = parsePiJsonl(
      [
        JSON.stringify({ type: 'message_update', usage: { cost: { total: 0.001 } } }),
        JSON.stringify({ type: 'message_update', usage: { cost: { total: 0.003 } } }),
        JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] } }),
        'not json',
      ].join('\n'),
    );
    expect(out.text).toBe('hello');
    expect(out.texts).toEqual(['hello']);
    expect(out.costUsd).toBe(0.003);
  });
});

// n10: a multi-turn worker (consolidator with tool calls) emits several
// message_end events; the FINAL report is not necessarily the LAST message.
const msgEnd = (text: string) =>
  JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const REPORT = 'CONSOLIDATION_REPORT\ntopics: a.md\njourney_changed: true\nconsumed: om-1\ndropped: none\nEND_CONSOLIDATION_REPORT';

describe('n10: report selection from multi-turn JSONL', () => {
  it('collects all non-empty assistant turns; text = last non-empty', () => {
    const out = parsePiJsonl(
      [msgEnd('let me check the files first'), msgEnd(REPORT), msgEnd(' '), msgEnd('')].join('\n'),
    );
    expect(out.texts).toEqual(['let me check the files first', REPORT]);
    expect(out.text).toBe(REPORT);
  });

  it('picks the report after a tool turn', () => {
    const { texts } = parsePiJsonl([msgEnd('checking topic files'), msgEnd(REPORT)].join('\n'));
    expect(pickReportBody(texts, 'consolidator')).toBe(REPORT);
  });

  it('picks the report when an empty follow-up message comes after it', () => {
    const { texts } = parsePiJsonl(
      [msgEnd('checking topic files'), msgEnd(REPORT), msgEnd(' '), msgEnd('done (empty)')].join('\n'),
    );
    // 'done (empty)' does not parse as a report → the newest PARSEABLE turn wins
    expect(pickReportBody(texts, 'consolidator')).toBe(REPORT);
  });

  it('falls back to the last non-empty text when nothing parses', () => {
    const { texts, text } = parsePiJsonl([msgEnd('garbage one'), msgEnd('garbage two')].join('\n'));
    expect(pickReportBody(texts, 'consolidator')).toBe('');
    expect(text).toBe('garbage two'); // caller: body = pick || text || stdout
  });

  it('end-to-end: a multi-turn consolidator subprocess yields a parsed report', async () => {
    const scriptLine = (t: string) => JSON.stringify(msgEnd(t));
    const multi = path.join(dir, 'fake-pi-multi.mjs');
    writeFileSync(
      multi,
      `const lines = [\n`
        + `  ${scriptLine('let me check the topic files first')},\n`
        + `  ${scriptLine(REPORT)},\n`
        + `  ${scriptLine('  ')},\n`
        + `  JSON.stringify({ type: 'agent_end', messages: [] })\n`
        + `];\n`
        + `process.stdout.write(lines.join('\\n') + '\\n');\n`,
    );
    const bin = path.join(dir, 'fake-pi-multi.sh');
    writeFileSync(bin, `#!/bin/sh\nexec node ${multi} "$@"\n`);
    chmodSync(bin, 0o755);
    const r = await new PiSubprocessRunner({
      piBinary: bin,
      cwd: dir,
      observerModel: { id: 'x' },
      consolidatorModel: { id: 'x' },
      timeoutMs: 15_000,
    }).run('consolidator', { runId: 'run-multi', role: 'consolidator', pool: { observations: [], sessionDir: dir, journey: '' } });
    expect(r.ok).toBe(true);
    expect(r.consolidation).toEqual({
      topics: ['a.md'],
      tombstoneIds: ['om-1'],
      droppedIds: [],
      journeyChanged: true,
    });
  });
});

describe('PiSubprocessRunner', () => {
  it('passes -e worker extension, --no-builtin-tools and OM_WORKER env', async () => {
    await makeRunner().run('consolidator', {
      runId: 'run-env',
      role: 'consolidator',
      pool: { observations: [], sessionDir: dir, journey: '' },
    });
    const inv = JSON.parse(readFileSync(path.join(dir, 'invocation.json'), 'utf8'));
    expect(inv.omWorker).toBe('consolidator');
    expect(inv.omWorkerDir).toBe(dir);
    expect(inv.hasWorkerExt).toBe(true);
    expect(inv.noBuiltinTools).toBe(true);
    expect(inv.model).toBe('test-model');
  });

  it('runs an extractor subprocess and parses the JSON values + cost', async () => {
    const r = await makeRunner().run('extractor', {
      runId: 'run-ext',
      role: 'extractor',
      extract: {
        specs: [{ id: 'profile', name: 'User profile', description: 'd' }],
        current: {},
        observations: [],
        sessionDir: dir,
      },
    });
    expect(r.ok).toBe(true);
    expect(r.extraction?.profile).toEqual({ lang: 'ru' });
    expect(r.costUsd).toBeCloseTo(0.003);
    const inv = JSON.parse(readFileSync(path.join(dir, 'invocation.json'), 'utf8'));
    expect(inv.omWorker).toBe('extractor');
  });

  it('runs an observer subprocess and parses observations + cost', async () => {
    const r = await makeRunner().run('observer', {
      runId: 'run-1',
      role: 'observer',
      chunk: { text: 'history', overlapContext: '', coversUpToId: 'm1' },
    });
    expect(r.ok).toBe(true);
    expect(r.observations).toEqual([
      { text: 'fake obs 1', priority: 'important' },
      { text: 'fake obs 2', priority: 'routine' },
    ]);
    expect(r.costUsd).toBe(0.003);
  });

  it('runs a reflect subprocess and parses the reflection report (v0.6)', async () => {
    const r = await makeRunner().run('reflect', {
      runId: 'run-refl',
      role: 'reflect',
      reflect: { sessionDir: dir, topics: ['a.md'], journey: 'old' },
    });
    expect(r.ok).toBe(true);
    expect(r.reflection).toEqual({ topics: ['merged.md'], journeyChanged: true });
    const inv = JSON.parse(readFileSync(path.join(dir, 'invocation.json'), 'utf8'));
    expect(inv.omWorker).toBe('reflect');
    expect(inv.omWorkerDir).toBe(dir);
  });

  it('runs a consolidator subprocess and parses the report', async () => {
    const r = await makeRunner().run('consolidator', {
      runId: 'run-2',
      role: 'consolidator',
      pool: { observations: [], sessionDir: dir, journey: '' },
    });
    expect(r.ok).toBe(true);
    expect(r.consolidation).toEqual({
      topics: ['a.md', 'b.md'],
      tombstoneIds: ['om-1', 'om-2'],
      droppedIds: [],
      journeyChanged: true,
    });
  });

  it('fails cleanly when the binary does not exist', async () => {
    const r = await new PiSubprocessRunner({
      piBinary: path.join(dir, 'nope'),
      cwd: dir,
      observerModel: { id: 'x' },
      consolidatorModel: { id: 'x' },
    }).run('observer', { runId: 'r', role: 'observer', chunk: { text: 'x', overlapContext: '', coversUpToId: 'm' } });
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });

  it('times out a hung worker', async () => {
    const hang = path.join(dir, 'hang.sh');
    writeFileSync(hang, '#!/bin/sh\nsleep 30\n');
    chmodSync(hang, 0o755);
    const r = await new PiSubprocessRunner({
      piBinary: hang,
      cwd: dir,
      observerModel: { id: 'x' },
      consolidatorModel: { id: 'x' },
      timeoutMs: 300,
    }).run('observer', { runId: 'r', role: 'observer', chunk: { text: 'x', overlapContext: '', coversUpToId: 'm' } });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('timed out');
  });
});

// M1: drain() race tests — `active` is a private map; inject mock children
// (EventEmitters) directly.
function mockChild(over: { exitCode?: number | null; killed?: boolean } = {}): any {
  const ee = new EventEmitter();
  return Object.assign(ee, { pid: 4242, exitCode: over.exitCode ?? null, killed: over.killed ?? false });
}

function runnerWithActive(...children: any[]): PiSubprocessRunner {
  const runner = makeRunner();
  const active = (runner as unknown as { active: Map<string, any> }).active;
  children.forEach((c, i) => active.set(`mock-${i}`, c));
  return runner;
}

describe('drain (M1 race)', () => {
  it('resolves for a child that is already dead before drain (close never emitted)', async () => {
    const runner = runnerWithActive(mockChild({ exitCode: 0, killed: true }));
    await expect(runner.drain()).resolves.toBeUndefined();
  });

  it('resolves when the child closes after drain started (race: exit between check and registration)', async () => {
    // exitCode is null at the moment drain() runs; 'close' is emitted right
    // after — the close listener must have been registered BEFORE any state
    // check, otherwise the event is lost and the promise hangs forever.
    const child = mockChild();
    const runner = runnerWithActive(child);
    const p = runner.drain();
    child.emit('close', 0);
    await expect(p).resolves.toBeUndefined();
  });

  it('resolves when the child dies via the error event', async () => {
    const child = mockChild();
    const runner = runnerWithActive(child);
    const p = runner.drain();
    child.emit('error', new Error('boom'));
    await expect(p).resolves.toBeUndefined();
  });

  it('force-resolves via the watchdog when close never comes (fake timers)', async () => {
    const child = mockChild(); // alive, nothing ever emitted
    const runner = runnerWithActive(child);
    vi.useFakeTimers();
    try {
      const p = runner.drain();
      vi.advanceTimersByTime(15_000 + 1); // makeRunner timeoutMs = 15_000
      await expect(p).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('watchdog is capped at 60s regardless of timeoutMs', async () => {
    const child = mockChild();
    const runner = new PiSubprocessRunner({
      piBinary: fakePi,
      cwd: dir,
      observerModel: { id: 'x' },
      consolidatorModel: { id: 'x' },
      timeoutMs: 10 * 60 * 1000, // 10 min — watchdog must cap at 60s
    });
    (runner as unknown as { active: Map<string, any> }).active.set('mock', child);
    vi.useFakeTimers();
    try {
      const p = runner.drain();
      vi.advanceTimersByTime(60 * 1000 + 1);
      await expect(p).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('resolves for a live child that closes normally (real timers)', async () => {
    const child = mockChild();
    const runner = runnerWithActive(child);
    const p = runner.drain();
    setTimeout(() => child.emit('close', 0), 20);
    await expect(p).resolves.toBeUndefined();
  });
});
