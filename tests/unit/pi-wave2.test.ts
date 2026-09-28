/**
 * Wave-2 pi-adapter fixes:
 *  - A5: session_before_compact is async and quiescently waits for in-flight
 *    observers (drainForCompaction) BEFORE rendering the block — the old
 *    synchronous render raced pending commits;
 *  - A12: /om:recall "limit" без значения (или нечисло) → usage, не NaN.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ext from '../../src/adapters/pi/index.js';
import { estimateTokens } from '../../src/core/tokens.js';

let cwd: string;

function makeEnv() {
  const entries = Array.from({ length: 2 }, (_, i) => ({
    type: 'message',
    id: `e${i}`,
    parentId: i > 0 ? 'e0' : null,
    timestamp: new Date().toISOString(),
    message: { role: i === 0 ? 'user' : 'assistant', content: 'x'.repeat(40) },
  }));
  const handlers = new Map<string, (e: unknown, ctx: unknown) => unknown>();
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const pi = {
    on: (name: string, h: (e: unknown, ctx: unknown) => unknown) => handlers.set(name, h),
    appendEntry: () => {},
    sendMessage: () => {},
    registerCommand: (name: string, opts: { handler: (args: string, ctx: unknown) => Promise<void> }) =>
      commands.set(name, opts),
    registerTool: () => {},
  } as never;
  const handle = ext(pi);

  const ctx = {
    ui: { notify: () => {}, setStatus: () => {} },
    hasUI: false,
    cwd,
    sessionManager: {
      getBranch: () => entries,
      getEntries: () => entries,
      getSessionId: () => 'sess-wave2',
      getHeader: () => ({ id: 'sess-wave2', cwd, timestamp: new Date().toISOString() }),
    },
    isIdle: () => true,
    getContextUsage: () => undefined,
    compact: () => {},
    model: { provider: 'test', id: 'test-model' },
  };
  return { handle, handlers, commands, ctx };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  cwd = mkdtempSync(path.join(tmpdir(), 'om-pi-wave2-'));
});
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('A5: session_before_compact waits for in-flight observers', () => {
  it('the hook is async, awaits drainForCompaction BEFORE compactionPlan, and returns the compaction', async () => {
    const env = makeEnv();
    await env.handlers.get('session_start')!(undefined, env.ctx);
    await env.commands.get('om')!.handler('on', env.ctx);

    const rt = env.handle.runtime()!;
    let planCalls = 0;
    const origPlan = rt.orch.compactionPlan.bind(rt.orch);
    rt.orch.compactionPlan = () => {
      planCalls++;
      return origPlan();
    };
    // Gated drain: simulates an in-flight observer the hook must wait for.
    let releaseDrain!: () => void;
    const gate = new Promise<void>((r) => {
      releaseDrain = r;
    });
    rt.orch.drainForCompaction = async () => {
      await gate;
    };

    const hook = env.handlers.get('session_before_compact')!;
    const p = hook(
      { preparation: { firstKeptEntryId: 'e1', tokensBefore: 5 } },
      env.ctx,
    ) as Promise<{ compaction: { summary: string; firstKeptEntryId: string; tokensBefore: number } }>;

    // The hook must be awaiting the drain: the plan is not rendered yet.
    await sleep(20);
    expect(planCalls).toBe(0);

    releaseDrain();
    const res = await p;
    expect(planCalls).toBe(1);
    expect(res.compaction.tokensBefore).toBe(5);
    expect(res.compaction.firstKeptEntryId).toBe('e1');
    expect(typeof res.compaction.summary).toBe('string');
  });

  it('returns undefined (default pi compaction) when OM is off', async () => {
    const env = makeEnv();
    await env.handlers.get('session_start')!(undefined, env.ctx);
    const hook = env.handlers.get('session_before_compact')!;
    const res = await hook({ preparation: { firstKeptEntryId: 'e1', tokensBefore: 5 } }, env.ctx);
    expect(res).toBeUndefined();
  });
});

describe('compaction tail clamp (stalled observer)', () => {
  it('caps firstKeptEntryId so the retained tail fits the model window', async () => {
    // 40 messages x 20_000 chars ≈ 5_000 tokens each = 200K tokens total.
    const entries = Array.from({ length: 40 }, (_, i) => ({
      type: 'message',
      id: `e${i}`,
      parentId: i > 0 ? `e${i - 1}` : null,
      timestamp: new Date().toISOString(),
      message: { role: i % 2 ? 'assistant' : 'user', content: 'x'.repeat(20_000) },
    }));
    const handlers = new Map<string, (e: unknown, ctx: unknown) => unknown>();
    const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
    const pi = {
      on: (name: string, h: (e: unknown, ctx: unknown) => unknown) => handlers.set(name, h),
      appendEntry: () => {},
      sendMessage: () => {},
      registerCommand: (name: string, opts: { handler: (args: string, ctx: unknown) => Promise<void> }) =>
        commands.set(name, opts),
      registerTool: () => {},
    } as never;
    const handle = ext(pi);
    const ctx = {
      ui: { notify: () => {}, setStatus: () => {} },
      hasUI: false,
      cwd,
      sessionManager: {
        getBranch: () => entries,
        getEntries: () => entries,
        getSessionId: () => 'sess-clamp',
        getHeader: () => ({ id: 'sess-clamp', cwd, timestamp: new Date().toISOString() }),
      },
      isIdle: () => true,
      // 128K window: cap = 128K − 96K headroom − block ≈ 31K tokens.
      getContextUsage: () => ({ tokens: 200_000, contextWindow: 131_072, percent: 152 }),
      compact: () => {},
      model: { provider: 'test', id: 'test-model' },
    } as never;

    await handlers.get('session_start')!(undefined, ctx);
    await commands.get('om')!.handler('on', ctx);

    const rt = handle.runtime()!;
    // Stalled observer: the plan's tail boundary sits at e2, so the unclamped
    // retained tail is ~190K tokens — far above the window.
    const block = {
      observations: '',
      memoryMap: '',
      journey: '',
      currentTask: '',
      verbatimTail: '',
      gapMarkers: '',
      text: 'block',
      generatedAt: new Date().toISOString(),
    };
    rt.orch.compactionPlan = () => ({ block, tailBoundaryId: 'e2' });

    const hook = handlers.get('session_before_compact')!;
    const res = (await hook(
      { preparation: { firstKeptEntryId: 'fallback', tokensBefore: 200_000 } },
      ctx,
    )) as { compaction: { summary: string; firstKeptEntryId: string; tokensBefore: number } };

    // Without the clamp the hook would keep everything after e2 → 'e3'.
    expect(res.compaction.firstKeptEntryId).not.toBe('e3');
    // Retained tail after firstKept fits the cap (+ at most one message, ~3_125
    // tokens each — dense-run estimate of 20_000 'x').
    const keptIdx = entries.findIndex((e) => e.id === res.compaction.firstKeptEntryId);
    expect(keptIdx).toBeGreaterThan(20);
    const keptTokens = entries
      .slice(keptIdx)
      .reduce((s, e) => s + estimateTokens(String((e.message as { content: string }).content)), 0);
    expect(keptTokens).toBeLessThanOrEqual(34_700 + 3_125);
    expect(res.compaction.summary).toBe('block');
  });
});

describe('A12: /om:recall limit validation', () => {
  const run = async (args: string) => {
    const env = makeEnv();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await env.handlers.get('session_start')!(undefined, env.ctx);
    await env.commands.get('om')!.handler('on', env.ctx);
    await env.commands.get('om:recall')!.handler(args, env.ctx);
    const lines = log.mock.calls.map((c) => String(c[0]));
    return { lines, log };
  };

  it('"limit" without a value → usage message (not a NaN crash)', async () => {
    const { lines } = await run('show limit');
    expect(lines.some((l) => l.includes('Usage: /om:recall'))).toBe(true);
    expect(lines.some((l) => l.includes('NaN'))).toBe(false);
  });

  it('"limit abc" (non-number) → usage message', async () => {
    const { lines } = await run('show limit abc');
    expect(lines.some((l) => l.includes('Usage: /om:recall'))).toBe(true);
  });

  it('valid limit works (no usage message)', async () => {
    const { lines } = await run('show limit 3');
    expect(lines.some((l) => l.includes('Usage: /om:recall'))).toBe(false);
  });

  it('invalid since/until dates → usage message (R7 surfaces OmError gracefully)', async () => {
    for (const args of ['show since not-a-date', 'show until bad-date']) {
      const { lines } = await run(args);
      expect(lines.some((l) => l.includes('Usage: /om:recall')), args).toBe(true);
    }
  });
});
