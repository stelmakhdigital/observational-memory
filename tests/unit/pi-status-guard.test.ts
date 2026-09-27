/**
 * Regression: the TUI boot-ctx ui object may lack setStatus (pi 0.87.x,
 * interactive mode). The status line is decorative — a missing method must
 * never break the pipeline (commands, compaction, workers).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
});
