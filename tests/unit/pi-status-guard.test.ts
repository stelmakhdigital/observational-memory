/**
 * Regression: the TUI boot-ctx ui object may lack setStatus (pi 0.87.x,
 * interactive mode). The status line is decorative — a missing method must
 * never break the pipeline (commands, compaction, workers).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ext from '../../src/adapters/pi/index.js';

let cwd: string;

function makeEnv() {
  const entries = Array.from({ length: 2 }, (_, i) => ({
    type: 'message',
    id: `e${i}`,
    parentId: i > 0 ? 'e0' : null,
    timestamp: new Date().toISOString(),
    message: { role: i === 0 ? 'user' : 'assistant', content: 'x'.repeat(40) },
  }));
  const handlers = new Map<string, (e: unknown, ctx: unknown) => void | Promise<void>>();
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const pi = {
    on: (name: string, h: (e: unknown, ctx: unknown) => void | Promise<void>) => handlers.set(name, h),
    appendEntry: () => {},
    sendMessage: () => {},
    registerCommand: (name: string, opts: { handler: (args: string, ctx: unknown) => Promise<void> }) =>
      commands.set(name, opts),
    registerTool: () => {},
  } as never;
  ext(pi);

  // The reported shape: ui exists, but WITHOUT setStatus (boot-ctx of TUI).
  const ctx = {
    ui: { notify: () => {} },
    hasUI: false,
    cwd,
    sessionManager: {
      getBranch: () => entries,
      getEntries: () => entries,
      getSessionId: () => 'sess-guard',
      getHeader: () => ({ id: 'sess-guard', cwd, timestamp: new Date().toISOString() }),
    },
    isIdle: () => true,
    getContextUsage: () => undefined,
    compact: () => {},
    model: { provider: 'test', id: 'test-model' },
  };
  return { handlers, commands, ctx };
}

beforeEach(() => {
  cwd = mkdtempSync(path.join(tmpdir(), 'om-guard-'));
  mkdirSync(path.join(cwd, '.pi'), { recursive: true });
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

describe('ui without setStatus (TUI boot-ctx regression)', () => {
  it('/om on and /om:status work without throwing', async () => {
    const env = makeEnv();
    await env.handlers.get('session_start')!(undefined, env.ctx);
    await expect(env.commands.get('om')!.handler('on', env.ctx)).resolves.toBeUndefined();
    await expect(env.commands.get('om:status')!.handler('', env.ctx)).resolves.toBeUndefined();
  });

  it('session_shutdown clears status without throwing', async () => {
    const env = makeEnv();
    await env.handlers.get('session_start')!(undefined, env.ctx);
    await env.commands.get('om')!.handler('on', env.ctx);
    await expect(env.handlers.get('session_shutdown')!(undefined, env.ctx)).resolves.toBeUndefined();
  });

  it('hasUI=true with a degraded ui (no notify/setStatus) does not throw', async () => {
    const env = makeEnv();
    // Live TUI shape: hasUI is true, but the ui object lacks the methods.
    (env.ctx as { hasUI: boolean }).hasUI = true;
    (env.ctx as { ui: unknown }).ui = {};
    await env.handlers.get('session_start')!(undefined, env.ctx);
    await expect(env.commands.get('om')!.handler('on', env.ctx)).resolves.toBeUndefined();
    await expect(env.commands.get('om:status')!.handler('', env.ctx)).resolves.toBeUndefined();
  });
});

describe('/om argument handling', () => {
  it('unknown arg does NOT toggle the gate; bare /om still toggles', async () => {
    const env = makeEnv();
    await env.handlers.get('session_start')!(undefined, env.ctx);
    await env.commands.get('om')!.handler('on', env.ctx);
    let logged = '';
    const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      logged += a.join(' ') + '\n';
    });
    try {
      // The live smoke trap: `/om status` (typo for /om:status) must be a no-op.
      await env.commands.get('om')!.handler('status', env.ctx);
      await env.commands.get('om:status')!.handler('', env.ctx);
      expect(logged).toContain('Unknown /om arg');
      expect(logged).toContain('OM on'); // still on — not silently disabled
      // Bare /om keeps the toggle behavior.
      await env.commands.get('om')!.handler('', env.ctx);
      await env.commands.get('om:status')!.handler('', env.ctx);
      expect(logged).toContain('OM off');
    } finally {
      spy.mockRestore();
    }
  });
});
