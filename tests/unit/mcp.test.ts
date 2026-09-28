import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { handleMcpRequest } from '../../src/adapters/mcp/server.js';
import { MemoryStore, renderTopicFile } from '../../src/core/memory-store.js';
import { FileLedgerStore, defaultLedgerFile } from '../../src/core/ledger/file-store.js';

let dir: string;
const S = 'mcp-sess';

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'om-mcp-'));
  // seed a ledger + memory so the tools have something to read
  const file = defaultLedgerFile(dir, S);
  const store = new FileLedgerStore({ file, lock: false });
  const at = '2026-01-05T00:00:00Z';
  store.append({
    type: 'om.observation',
    data: {
      id: 'om-20260105000000-01',
      coversUpToId: 'm5',
      content: 'decided to use the websocket protocol for sync',
      tokenCount: 12,
      createdAt: at,
      priority: 'important',
      sourceRange: { fromId: 'm1', toId: 'm5' },
    },
    at,
  });
  const mem = new MemoryStore(dir, { sharedDir: null });
  const sdir = mem.sessionDir(S);
  mkdirSync(sdir, { recursive: true });
  writeFileSync(path.join(sdir, 'stack.md'), renderTopicFile('Stack', 'Tech choices', S, 'websocket for sync'));
  writeFileSync(path.join(sdir, 'JOURNEY.md'), '## 2026-01-05 — chose the sync protocol\n');
  mem.renderIndex(S);
});

function call(name: string, args: Record<string, unknown> = {}): any {
  const res = handleMcpRequest({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments: args },
  }) as { result?: { content?: Array<{ text: string }>; isError?: boolean } };
  expect(res.result).toBeTruthy();
  return res.result!.content![0]!.text;
}

describe('MCP server (v0.7)', () => {
  it('initialize handshake', () => {
    const res = handleMcpRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05' },
    }) as { result: { protocolVersion: string; serverInfo: { name: string }; capabilities: { tools: unknown } } };
    expect(res.result.protocolVersion).toBe('2024-11-05');
    expect(res.result.serverInfo.name).toContain('observational-memory');
    expect(res.result.capabilities.tools).toBeTruthy();
  });

  it('notifications get no reply', () => {
    expect(handleMcpRequest({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
  });

  // A11: ANY notification (not just initialized) must get no reply, and the
  // stdio transport already skips writing null — verified here via the
  // dispatcher contract: res === null ⇒ nothing written to stdout.
  it('notifications/cancelled and other notifications get no reply (A11)', () => {
    expect(handleMcpRequest({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 5 } })).toBeNull();
    expect(handleMcpRequest({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: 1 } })).toBeNull();
    // and the transport must not write for them
    const writes: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    vi.spyOn(process.stdout, 'write').mockImplementation(((s: string) => {
      writes.push(String(s));
      return true;
    }) as typeof process.stdout.write);
    // re-dispatch through the same rule the transport uses
    for (const line of ['{"jsonrpc":"2.0","method":"notifications/cancelled"}', '{"jsonrpc":"2.0","method":"notifications/progress","params":{}}']) {
      const res = handleMcpRequest(JSON.parse(line));
      if (res !== null) writes.push(JSON.stringify(res));
    }
    vi.restoreAllMocks();
    expect(writes).toEqual([]);
    void origWrite;
  });

  it('ping → empty result (A11)', () => {
    const res = handleMcpRequest({ jsonrpc: '2.0', id: 7, method: 'ping' }) as { result: unknown };
    expect(res.result).toEqual({});
  });

  it('unknown method → -32601', () => {
    const res = handleMcpRequest({ jsonrpc: '2.0', id: 2, method: 'nope' }) as {
      error: { code: number };
    };
    expect(res.error.code).toBe(-32601);
  });

  it('tools/list exposes the read-only tools', () => {
    const res = handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) as {
      result: { tools: Array<{ name: string }> };
    };
    expect(res.result.tools.map((t) => t.name)).toEqual(['om_status', 'om_recall', 'om_topics']);
  });

  describe('with OM_MCP_ROOT/SESSION env', () => {
    beforeEach(() => {
      process.env.OM_MCP_ROOT = dir;
      process.env.OM_MCP_SESSION = S;
      // keep these tests on the embedded ledger: no pi-session auto-scan
      delete process.env.OM_MCP_PI_SESSION;
      process.env.OM_MCP_PI_SESSIONS_DIR = path.join(dir, 'no-sessions');
    });

    it('om_status reports observations, topics and cost', () => {
      const text = call('om_status');
      expect(text).toContain(`session: ${S}`);
      expect(text).toContain('active observations: 1');
      expect(text).toContain('Stack');
      expect(text).toContain('session cost: $0.000');
    });

    it('om_status reads the ledger exactly once (A16)', () => {
      // seed 5 entry types so any per-type shortcut in toolStatus would show
      const store = new FileLedgerStore({ file: defaultLedgerFile(dir, S), lock: false });
      const at = '2026-01-05T01:00:00Z';
      store.append({ type: 'om.tombstone', data: { observationIds: [], topics: [], journeyChanged: false }, at });
      store.append({ type: 'om.cost', data: { runId: 'r1', role: 'observer', usd: 0.0021, at }, at });
      store.append({ type: 'om.lastError', data: { message: 'boom', at }, at });
      store.append({ type: 'om.gap-marker', data: { id: 'g1', at, humanDuration: '1 мин', ms: 60000 }, at });
      const spy = vi.spyOn(FileLedgerStore.prototype, 'read');
      const text = call('om_status');
      expect(text).toContain('active observations: 1');
      expect(text).toContain('session cost: $0.002 (1 runs)');
      expect(text).toContain('last error: boom');
      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockRestore();
    });

    it('om_recall finds the observation and the topic', () => {
      const text = call('om_recall', { query: 'websocket sync' });
      expect(text).toContain('[observation]');
      expect(text).toContain('Stack');
      expect(text).toContain('source:');
      // temporal filter: before the fact date → the observation drops out
      // (file docs like topics/journey are not time-filtered, by design)
      const none = call('om_recall', { query: 'websocket sync', until: '2025-01-01' });
      expect(none).not.toContain('[observation]');
      expect(none).toContain('[topic]');
    });

    it('om_recall without query is an error result', () => {
      const res = handleMcpRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'om_recall', arguments: {} },
      }) as { result: { isError?: boolean; content: Array<{ text: string }> } };
      expect(res.result.isError).toBe(true);
      expect(res.result.content[0]!.text).toContain('query is required');
    });

    it('om_topics lists topics and journey', () => {
      const text = call('om_topics');
      expect(text).toContain('Stack: Tech choices');
      expect(text).toContain('chose the sync protocol');
    });

    it('unknown tool name → error result, no throw', () => {
      const res = handleMcpRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'om_hacks', arguments: {} },
      }) as { result: { isError?: boolean; content: Array<{ text: string }> } };
      expect(res.result.isError).toBe(true);
      expect(res.result.content[0]!.text).toContain('unknown tool');
    });
  });
});
