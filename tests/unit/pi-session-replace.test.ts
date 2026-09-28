/**
 * A1: pi 0.87.1 sends `session_shutdown` (reason 'new' | 'resume' | 'fork')
 * when /new or /resume switches sessions WITHIN the same process. The adapter
 * must drop its Runtime so the next session_start boots a fresh
 * orchestrator/ledger/memory for the NEW session — never reusing the old one.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ext from '../../src/adapters/pi/index.js';

function makeCtx(sessionId: string, cwd: string, modelId: string) {
  return {
    ui: undefined,
    hasUI: false,
    cwd,
    model: { provider: 'test', id: modelId },
    sessionManager: {
      // A freshly switched session has an empty branch (new session file).
      getBranch: () => [],
      getEntries: () => [],
      getSessionId: () => sessionId,
      getHeader: () => ({ id: sessionId, cwd, timestamp: new Date().toISOString() }),
    },
    isIdle: () => true,
    getContextUsage: () => undefined,
    compact: () => {},
  } as never;
}

function makeEnv() {
  const handlers = new Map<string, (e: unknown, ctx: unknown) => void | Promise<void>>();
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const appended: unknown[] = [];
  const pi = {
    on: (name: string, h: (e: unknown, ctx: unknown) => void | Promise<void>) => handlers.set(name, h),
    appendEntry: (_t: string, d: unknown) => {
      appended.push(d);
    },
    sendMessage: () => {},
    registerCommand: (name: string, opts: { handler: (args: string, ctx: unknown) => Promise<void> }) =>
      commands.set(name, opts),
    registerTool: () => {},
  } as never;
  const handle = ext(pi);
  return { handlers, commands, appended, handle };
}

/** The private orchestrator sessionId (not part of the public API). */
const orchSessionId = (rt: { orch: unknown }): string =>
  (rt.orch as unknown as { sessionId: string }).sessionId;

/** The private runner options (not part of the public API). */
const runnerOptions = (rt: { orch: unknown }) =>
  ((rt.orch as unknown as { d: { runner: unknown } }).d.runner as unknown as { o: { cwd: string; observerModel: { id?: string } } }).o;

let cwd1: string;
let cwd2: string;

beforeEach(() => {
  cwd1 = mkdtempSync(path.join(tmpdir(), 'om-replace-1-'));
  cwd2 = mkdtempSync(path.join(tmpdir(), 'om-replace-2-'));
  mkdirSync(path.join(cwd1, '.pi'), { recursive: true });
  // The NEW session lives in a different project dir with its OWN worker
  // model in project settings — proves boot re-resolves models from the new
  // ctx (no caching of the previous session's model/cwd).
  mkdirSync(path.join(cwd2, '.pi'), { recursive: true });
  writeFileSync(
    path.join(cwd2, '.pi', 'settings.json'),
    JSON.stringify({ 'observational-memory': { models: { observer: { id: 'sess2-observer' } } } }),
    'utf8',
  );
});
afterEach(() => {
  rmSync(cwd1, { recursive: true, force: true });
  rmSync(cwd2, { recursive: true, force: true });
});

describe('A1: session replacement in the same process', () => {
  it('boots a fresh Runtime for the new session after session_shutdown(reason new)', async () => {
    const { handlers, commands, handle, appended } = makeEnv();

    // --- session 1 ---
    const ctx1 = makeCtx('sess-1', cwd1, 'host-model-1');
    await handlers.get('session_start')!({ reason: 'new' }, ctx1);
    const rt1 = handle.runtime();
    expect(rt1).not.toBeNull();
    expect(orchSessionId(rt1!)).toBe('sess-1');
    await commands.get('om'!)!.handler('on', ctx1);
    expect(rt1!.orch.isEnabled()).toBe(true);
    const appendsAfterEnable1 = appended.length;
    expect(appendsAfterEnable1).toBeGreaterThan(0); // om.enabled persisted

    // --- /new: pi shuts the session down within the same process ---
    await handlers.get('session_shutdown')!({ reason: 'new' }, ctx1);
    expect(handle.runtime()).toBeNull();

    // Double shutdown must not throw (rt already null).
    await expect(
      handlers.get('session_shutdown')!({ reason: 'new' }, ctx1),
    ).resolves.toBeUndefined();
    expect(handle.runtime()).toBeNull();

    // --- session 2: a different session file in a different project dir ---
    const ctx2 = makeCtx('sess-2', cwd2, 'host-model-2');
    await handlers.get('session_start')!({ reason: 'new' }, ctx2);
    const rt2 = handle.runtime();
    expect(rt2).not.toBeNull();
    // Fresh Runtime — not the old one.
    expect(rt2).not.toBe(rt1);
    // The new orchestrator sees the NEW session.
    expect(orchSessionId(rt2!)).toBe('sess-2');
    // Worker models/cwd re-resolved from the new ctx: the new runner picks
    // up the new project's settings (and cwd), not the old session's.
    expect(runnerOptions(rt2!)).not.toBe(runnerOptions(rt1!));
    expect(runnerOptions(rt2!).cwd).toBe(cwd2);
    expect(runnerOptions(rt2!).observerModel.id).toBe('sess2-observer');
    // The new boot tracked the new ctx.
    expect(rt2!.lastCtx).toBe(ctx2);
    // Status is clean: disabled by default (new branch), nothing in flight.
    const s = rt2!.orch.status();
    expect(s.enabled).toBe(false);
    expect(s.inFlight).toEqual([]);
    expect(s.runs).toBe(0);

    // Ledger writes now go through the NEW runtime: enabling in session 2
    // appends a fresh om.enabled entry (read back from the new branch).
    await commands.get('om'!)!.handler('on', ctx2);
    const last = appended[appended.length - 1] as { type: string; data: { enabled: boolean } };
    expect(appended.length).toBe(appendsAfterEnable1 + 1);
    expect(last.type).toBe('om.enabled');
    expect(last.data.enabled).toBe(true);
  });

  it('session_shutdown without a prior boot is a no-op', async () => {
    const { handlers } = makeEnv();
    const ctx = makeCtx('sess-x', cwd1, 'm');
    await expect(
      handlers.get('session_shutdown')!({ reason: 'resume' }, ctx),
    ).resolves.toBeUndefined();
  });
});
