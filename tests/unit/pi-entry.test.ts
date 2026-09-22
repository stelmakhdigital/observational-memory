import { describe, expect, it, vi } from 'vitest';
import ext from '../../src/adapters/pi/index.js';

/** Minimal structural PiApi stub — just enough to be passed to the factory. */
function makePi() {
  const handlers = new Map<string, unknown>();
  const commands = new Map<string, unknown>();
  const tools = new Map<string, unknown>();
  const appended: unknown[] = [];
  const sent: unknown[] = [];
  return {
    handlers,
    commands,
    tools,
    appended,
    sent,
    pi: {
      on: (name: string, h: unknown) => {
        handlers.set(name, h);
      },
      appendEntry: (t: string, d?: unknown) => {
        appended.push([t, d]);
      },
      sendMessage: (m: unknown, o?: unknown) => {
        sent.push([m, o]);
      },
      registerCommand: (name: string, opts: unknown) => {
        commands.set(name, opts);
      },
      registerTool: (t: { name: string }) => {
        tools.set(t.name, t);
      },
    } as never,
  };
}

describe('pi adapter entry (smoke)', () => {
  it('default export is a factory function', () => {
    expect(typeof ext).toBe('function');
  });

  it('registers the expected event handlers and commands', () => {
    const { pi, handlers, commands, tools } = makePi();
    ext(pi);
    for (const ev of ['session_start', 'turn_end', 'agent_end', 'session_before_compact', 'session_shutdown']) {
      expect(handlers.has(ev), `handler ${ev}`).toBe(true);
    }
    for (const cmd of ['om', 'om:status', 'om:compact', 'om:consolidate', 'om:extract', 'om:recall', 'om:reflect', 'om:seed-from']) {
      expect(commands.has(cmd), `command ${cmd}`).toBe(true);
    }
    // v0.5: the agent-facing recall tool is registered at boot
    expect(tools.has('om_recall')).toBe(true);
  });

  it('boot is lazy: no ledger writes until a session event', () => {
    const { pi, appended } = makePi();
    ext(pi);
    expect(appended).toEqual([]); // nothing persisted at registration time
  });

  it('exposes a runtime() accessor that starts null', () => {
    const { pi } = makePi();
    const handle = ext(pi);
    expect(handle.runtime()).toBeNull();
  });
});
