import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PiSubprocessRunner, parsePiJsonl } from '../../src/adapters/pi/runner.js';

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
const text = isExtractor
  ? extractorText
  : isObserver
  ? 'OBSERVATIONS\\n- fake obs 1\\n- fake obs 2\\nEND_OBSERVATIONS'
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
    expect(out.costUsd).toBe(0.003);
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
    expect(r.observations).toEqual(['fake obs 1', 'fake obs 2']);
    expect(r.costUsd).toBe(0.003);
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
