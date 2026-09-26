/**
 * Auto-resume after auto-compaction (FR-3, ported from pi-observational-memory,
 * MIT): after our auto-compaction (onAgentEnd path) completes, a hidden
 * custom message triggers a new agent turn — but ONLY when the just-ended run
 * left the task unfinished. Manual compactions never resume.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ext, { runEndedUnfinished } from '../../src/adapters/pi/index.js';

// ---------------------------------------------------------------------------
// runEndedUnfinished: pure decision unit
// ---------------------------------------------------------------------------

const asst = (stopReason: string, errorMessage?: string) => ({
  role: 'assistant',
  content: [{ type: 'text', text: 'partial work…' }],
  ...(stopReason ? { stopReason } : {}),
  ...(errorMessage ? { errorMessage } : {}),
});

describe('runEndedUnfinished (adapter decision)', () => {
  it('is false for non-arrays and empty runs', () => {
    expect(runEndedUnfinished(undefined)).toBe(false);
    expect(runEndedUnfinished(null)).toBe(false);
    expect(runEndedUnfinished([])).toBe(false);
    expect(runEndedUnfinished([{ role: 'user', content: 'hi' }])).toBe(false);
  });

  it('is false for a clean stop (terminal turn is left to stop)', () => {
    expect(runEndedUnfinished([asst('stop')])).toBe(false);
    expect(runEndedUnfinished([asst('end_turn')])).toBe(false);
  });

  it('is true for a truncated output (length) — task cut mid-way', () => {
    expect(runEndedUnfinished([asst('length')])).toBe(true);
  });

  it('is false for a RETRYABLE error (pi auto-retries itself)', () => {
    expect(runEndedUnfinished([asst('error', 'upstream rate limit: 429 too many requests')])).toBe(false);
    expect(runEndedUnfinished([asst('error', 'server error 503 service unavailable')])).toBe(false);
    expect(runEndedUnfinished([asst('error', 'connection refused')])).toBe(false);
  });

  it('is true for a non-retryable error / error without a message', () => {
    expect(runEndedUnfinished([asst('error', 'billing: invalid api key')])).toBe(true);
    expect(runEndedUnfinished([asst('error')])).toBe(true);
  });

  it('is false for user abort', () => {
    expect(runEndedUnfinished([asst('aborted')])).toBe(false);
  });

  it('uses the LAST assistant message of the run', () => {
    expect(runEndedUnfinished([asst('length'), { role: 'toolResult', content: 'x' }, asst('stop')])).toBe(false);
    expect(runEndedUnfinished([asst('stop'), asst('length')])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Full adapter flow with a mocked pi + ctx
// ---------------------------------------------------------------------------

interface CompactionOpts {
  customInstructions?: string;
  onComplete?: (result: unknown) => void;
  onError?: (error: Error) => void;
}

let cwd: string;

function makeEnv(overrides: Record<string, unknown> = {}) {
  const sent: unknown[][] = [];
  const compacted: CompactionOpts[] = [];
  const entries = Array.from({ length: 6 }, (_, i) => ({
    type: 'message',
    id: `e${i}`,
    parentId: i > 0 ? `e${i - 1}` : null,
    timestamp: new Date().toISOString(),
    message: { role: i % 2 === 0 ? 'user' : 'assistant', content: 'y'.repeat(60) },
  }));
  const handlers = new Map<string, (e: unknown, ctx: unknown) => void | Promise<void>>();
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const pi = {
    on: (name: string, h: (e: unknown, ctx: unknown) => void | Promise<void>) => {
      handlers.set(name, h);
    },
    appendEntry: () => {},
    sendMessage: (m: unknown, o?: unknown) => {
      sent.push([m, o]);
    },
    registerCommand: (name: string, opts: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
      commands.set(name, opts);
    },
    registerTool: () => {},
  } as never;
  ext(pi);

  const ctx = {
    ui: { setStatus: () => {}, notify: () => {} },
    hasUI: false,
    cwd,
    sessionManager: {
      getBranch: () => entries,
      getEntries: () => entries,
      getSessionId: () => 'sess-resume',
      getHeader: () => ({ id: 'sess-resume', cwd, timestamp: new Date().toISOString() }),
    },
    isIdle: () => true,
    getContextUsage: () => undefined,
    compact: (opts?: CompactionOpts) => {
      compacted.push(opts ?? {});
    },
    model: { provider: 'test', id: 'test-model' },
  };

  return { sent, compacted, handlers, commands, ctx };
}

async function enableOm(env: ReturnType<typeof makeEnv>): Promise<void> {
  env.handlers.get('session_start')!(undefined, env.ctx);
  await env.commands.get('om')!.handler('on', env.ctx);
}

function agentEndEvent(stopReason: string, errorMessage?: string): unknown {
  return {
    type: 'agent_end',
    messages: [
      { role: 'user', content: 'do the task' },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'working…' }],
        stopReason,
        ...(errorMessage ? { errorMessage } : {}),
      },
    ],
  };
}

beforeEach(() => {
  cwd = mkdtempSync(path.join(tmpdir(), 'om-resume-'));
  // Project settings: low compact threshold so 6 × 60-char messages (~90
  // estimated tokens) trigger our auto-compaction.
  mkdirSync(path.join(cwd, '.pi'), { recursive: true });
  writeFileSync(
    path.join(cwd, '.pi', 'settings.json'),
    JSON.stringify({ 'observational-memory': { compactAtContextTokens: 50, passive: false } }),
  );
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

describe('auto-resume after AUTO compaction', () => {
  it('sends a hidden resume message (triggerTurn) when the run ended unfinished', async () => {
    const env = makeEnv();
    await enableOm(env);
    await env.handlers.get('agent_end')!(agentEndEvent('length'), env.ctx);

    // auto-compaction was triggered via ctx.compact()
    expect(env.compacted.length).toBe(1);
    expect(env.sent).toEqual([]); // nothing before the compaction completes
    env.compacted[0]!.onComplete!({});

    expect(env.sent.length).toBe(1);
    const [msg, options] = env.sent[0]!;
    expect(msg).toMatchObject({
      customType: 'om-resume',
      content: expect.stringContaining('Continue exactly where you left off'),
      display: false,
    });
    expect(options).toEqual({ triggerTurn: true });
  });

  it('does NOT resume a clean terminal stop', async () => {
    const env = makeEnv();
    await enableOm(env);
    await env.handlers.get('agent_end')!(agentEndEvent('stop'), env.ctx);
    expect(env.compacted.length).toBe(1);
    env.compacted[0]!.onComplete!({});
    expect(env.sent).toEqual([]);
  });

  it('does NOT resume a retryable error (pi auto-retries itself)', async () => {
    const env = makeEnv();
    await enableOm(env);
    await env.handlers.get('agent_end')!(
      agentEndEvent('error', '429 rate limit, retry delay 30s'),
      env.ctx,
    );
    expect(env.compacted.length).toBe(1);
    env.compacted[0]!.onComplete!({});
    expect(env.sent).toEqual([]);
  });

  it('does NOT resume when resumeAfterMidRunCompaction is disabled', async () => {
    const env = makeEnv();
    writeFileSync(
      path.join(cwd, '.pi', 'settings.json'),
      JSON.stringify({
        'observational-memory': { compactAtContextTokens: 50, passive: false, resumeAfterMidRunCompaction: false },
      }),
    );
    await enableOm(env);
    await env.handlers.get('agent_end')!(agentEndEvent('length'), env.ctx);
    expect(env.compacted.length).toBe(1);
    env.compacted[0]!.onComplete!({});
    expect(env.sent).toEqual([]);
  });

  it('does NOT resume a MANUAL /om:compact', async () => {
    const env = makeEnv();
    await enableOm(env);
    await env.commands.get('om:compact')!.handler('', env.ctx);
    expect(env.compacted.length).toBe(1);
    env.compacted[0]!.onComplete!({});
    expect(env.sent).toEqual([]);
  });
});
