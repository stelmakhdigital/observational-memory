import { beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { handleMcpRequest } from '../../src/adapters/mcp/server.js';
import { readPiLedger, scanForPiSession } from '../../src/adapters/mcp/pi-ledger.js';
import { FileLedgerStore, defaultLedgerFile } from '../../src/core/ledger/file-store.js';

let dir: string;
const S = 'mcp-sess';

function omLine(payload: Record<string, unknown>): string {
  return JSON.stringify({
    type: 'custom',
    customType: 'om',
    data: payload,
    id: 'c1',
    parentId: 'm1',
    timestamp: '2026-01-06T00:00:00Z',
  });
}

/** A realistic pi session JSONL: header, messages, om entries, garbage. */
function writePiSession(file: string): void {
  const lines = [
    JSON.stringify({ type: 'session', version: 3, id: 'sess', timestamp: '2026-01-05T23:59:00Z', cwd: '/tmp' }),
    JSON.stringify({ type: 'message', id: 'm1', parentId: null, timestamp: '2026-01-05T23:59:30Z', message: { role: 'user', content: 'hi' } }),
    omLine({ type: 'om.observation', data: { id: 'om-1', coversUpToId: 'm2', content: 'chose sqlite for the storage layer', tokenCount: 9, createdAt: '2026-01-06T00:00:00Z' }, at: '2026-01-06T00:00:00Z' }),
    'not json at all', // crash-tail / garbage line
    '',
    omLine({ type: 'om.cost', data: { runId: 'r1', role: 'observer', usd: 0.012, at: '2026-01-06T00:00:01Z' }, at: '2026-01-06T00:00:01Z', meta: { runId: 'r1' } }),
    omLine({ type: 'om.observation', data: { id: 42 }, at: 'x' }), // corrupt payload → skipped
    JSON.stringify({ type: 'custom', customType: 'other', data: { type: 'om.observation', data: { id: 'om-x' } } }), // foreign
    omLine({ type: 'om.tombstone', data: { observationIds: [], topics: ['a.md'], journeyChanged: false }, at: '2026-01-06T00:01:00Z' }),
  ];
  writeFileSync(file, lines.join('\n') + '\n', 'utf8');
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'om-mcp-pi-'));
  process.env.OM_MCP_ROOT = dir;
  process.env.OM_MCP_SESSION = S;
  delete process.env.OM_MCP_PI_SESSION;
  delete process.env.OM_MCP_PI_SESSIONS_DIR;
});

function call(name: string, args: Record<string, unknown> = {}): string {
  const res = handleMcpRequest({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments: args },
  }) as { result?: { content?: Array<{ text: string }>; isError?: boolean } };
  expect(res.result).toBeTruthy();
  if (res.result!.isError) throw new Error(res.result!.content![0]!.text);
  return res.result!.content![0]!.text;
}

describe('readPiLedger (pi session JSONL parse)', () => {
  it('parses om entries, skips messages/garbage/corrupt payloads', () => {
    const file = path.join(dir, 's.jsonl');
    writePiSession(file);
    const res = readPiLedger(file);
    expect(res).not.toBeNull();
    expect(res!.omEntries).toBe(3); // observation + cost + tombstone
    const obs = res!.store.read('om.observation');
    expect(obs).toHaveLength(1);
    expect(obs[0]!.data.id).toBe('om-1');
    expect(obs[0]!.at).toBe('2026-01-06T00:00:00Z');
    expect(res!.store.read('om.cost')[0]!.data.usd).toBe(0.012);
    expect(res!.store.read('om.tombstone')[0]!.data.observationIds).toEqual([]);
    expect(res!.store.read()).toHaveLength(3);
  });

  it('returns null for missing file and for a file without om entries', () => {
    expect(readPiLedger(path.join(dir, 'nope.jsonl'))).toBeNull();
    const plain = path.join(dir, 'plain.jsonl');
    writeFileSync(plain, JSON.stringify({ type: 'message', id: 'm1', parentId: null, timestamp: 't', message: {} }) + '\n');
    expect(readPiLedger(plain)).toBeNull();
  });
});

describe('scanForPiSession', () => {
  it('picks the newest .jsonl containing om entries (by mtime), skips others', () => {
    const sessions = path.join(dir, 'sessions');
    const cwd = path.join(sessions, '--tmp-x--');
    const cwd2 = path.join(sessions, '--tmp-y--');
    for (const d of [cwd, cwd2]) mkdirSync(d, { recursive: true });
    const noOm = path.join(cwd, 'a.jsonl');
    const withOmOld = path.join(cwd2, 'b.jsonl');
    const withOmNew = path.join(cwd2, 'c.jsonl');
    writeFileSync(noOm, JSON.stringify({ type: 'message', id: 'm', parentId: null, timestamp: 't', message: {} }));
    writePiSession(withOmOld);
    writePiSession(withOmNew);
    const t = (ms: number) => new Date(ms);
    utimesSync(noOm, t(3000), t(3000)); // newest, but no om → skipped
    utimesSync(withOmOld, t(1000), t(1000));
    utimesSync(withOmNew, t(2000), t(2000)); // newest WITH om → chosen
    expect(scanForPiSession(sessions)).toBe(withOmNew);
  });

  it('returns null for a missing dir', () => {
    expect(scanForPiSession(path.join(dir, 'no-such-dir'))).toBeNull();
  });
});

describe('MCP tools over a pi session (M5)', () => {
  it('OM_MCP_PI_SESSION: status source=pi-session, recall finds pi observations', () => {
    const file = path.join(dir, 'pi', 'sess.jsonl');
    mkdirSync(path.dirname(file), { recursive: true });
    writePiSession(file);
    process.env.OM_MCP_PI_SESSION = file;

    const status = call('om_status');
    expect(status).toContain(`source: pi-session — ${file}`);
    expect(status).toContain('active observations: 1');
    expect(status).toContain('session cost: $0.012');

    const recall = call('om_recall', { query: 'sqlite storage' });
    expect(recall).toContain('[observation]');
    expect(recall).toContain('chose sqlite');
  });

  it('auto-scan (OM_MCP_PI_SESSIONS_DIR) is used when no explicit session; embedded otherwise', () => {
    // no sessions dir → embedded fallback with the marker
    process.env.OM_MCP_PI_SESSIONS_DIR = path.join(dir, 'no-sessions');
    const file = defaultLedgerFile(dir, S);
    const store = new FileLedgerStore({ file, lock: false });
    store.append({
      type: 'om.observation',
      data: { id: 'om-emb', coversUpToId: 'm1', content: 'embedded ledger observation', tokenCount: 5, createdAt: '2026-01-06T00:00:00Z' },
      at: '2026-01-06T00:00:00Z',
    });
    expect(call('om_status')).toContain('source: embedded —');
    expect(call('om_recall', { query: 'embedded ledger' })).toContain('[observation]');

    // sessions dir with an om session → switched to pi-session
    const sessions = path.join(dir, 'sessions', '--tmp--');
    mkdirSync(sessions, { recursive: true });
    const piFile = path.join(sessions, 'd.jsonl');
    writePiSession(piFile);
    process.env.OM_MCP_PI_SESSIONS_DIR = path.join(dir, 'sessions');
    expect(call('om_status')).toContain(`source: pi-session — ${piFile}`);
    expect(call('om_recall', { query: 'sqlite storage' })).toContain('[observation]');
  });

  it('explicit OM_MCP_PI_SESSION wins over the scan; invalid explicit falls back to embedded', () => {
    const sessions = path.join(dir, 'sessions', '--tmp--');
    mkdirSync(sessions, { recursive: true });
    const scannedFile = path.join(sessions, 'scanned.jsonl');
    writePiSession(scannedFile);
    const explicitFile = path.join(dir, 'explicit.jsonl');
    writePiSession(explicitFile);
    process.env.OM_MCP_PI_SESSION = explicitFile;
    process.env.OM_MCP_PI_SESSIONS_DIR = path.join(dir, 'sessions');
    expect(call('om_status')).toContain(`source: pi-session — ${explicitFile}`);

    // explicit file without om entries → embedded (scan is NOT consulted)
    const empty = path.join(dir, 'empty.jsonl');
    writeFileSync(empty, JSON.stringify({ type: 'message', id: 'm', parentId: null, timestamp: 't', message: {} }));
    process.env.OM_MCP_PI_SESSION = empty;
    expect(call('om_status')).toContain('source: embedded —');
  });

  it('om_topics is unaffected by the ledger source (shared topic files)', () => {
    const sdir = path.join(dir, S);
    mkdirSync(sdir, { recursive: true });
    writeFileSync(path.join(sdir, 'Db.md'), '---\ntopic: Db\n---\nnotes\n');
    const file = path.join(dir, 'pi.jsonl');
    writePiSession(file);
    process.env.OM_MCP_PI_SESSION = file;
    const text = call('om_topics');
    expect(text).toContain('Db');
  });
});
