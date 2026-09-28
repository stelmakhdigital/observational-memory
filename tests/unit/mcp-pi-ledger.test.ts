import { beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, openSync, utimesSync, writeFileSync, writeSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { handleMcpRequest } from '../../src/adapters/mcp/server.js';
import { readAllSync, readPiLedger, readPiSessionId, scanForPiSession } from '../../src/adapters/mcp/pi-ledger.js';
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
function writePiSession(file: string, id = 'sess'): void {
  const lines = [
    JSON.stringify({ type: 'session', version: 3, id, timestamp: '2026-01-05T23:59:00Z', cwd: '/tmp' }),
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

  it('returns the header session id (null for missing file / non-header first line)', () => {
    const file = path.join(dir, 's.jsonl');
    writePiSession(file, 'abc-123');
    expect(readPiLedger(file)!.sessionId).toBe('abc-123');
    expect(readPiSessionId(file)).toBe('abc-123');
    expect(readPiSessionId(path.join(dir, 'nope.jsonl'))).toBeNull();
    const headless = path.join(dir, 'headless.jsonl');
    writeFileSync(headless, omLine({ type: 'om.observation', data: { id: 'o', coversUpToId: 'm', content: 'x', tokenCount: 1, createdAt: 't' } }) + '\n');
    expect(readPiSessionId(headless)).toBeNull();
  });

  it('expectedSessionId filter: matching id passes, foreign id / missing header → null', () => {
    const file = path.join(dir, 's.jsonl');
    writePiSession(file, 'abc-123');
    expect(readPiLedger(file, 'abc-123')!.omEntries).toBe(3);
    expect(readPiLedger(file, 'other')).toBeNull();
    // headerless file with om entries: id cannot be verified → rejected when asked
    const headless = path.join(dir, 'headless.jsonl');
    writeFileSync(headless, omLine({ type: 'om.observation', data: { id: 'o', coversUpToId: 'm', content: 'x', tokenCount: 1, createdAt: 't' } }) + '\n');
    expect(readPiLedger(headless)!.omEntries).toBe(1);
    expect(readPiLedger(headless, 'any-id')).toBeNull();
  });

  it('reads the TAIL: om entries after >READ_BYTES of padding are found, head entries are not (A2)', () => {
    const file = path.join(dir, 'big.jsonl');
    const headObs = omLine({ type: 'om.observation', data: { id: 'om-head', coversUpToId: 'm0', content: 'old head observation', tokenCount: 4, createdAt: 't' } });
    const tailObs = omLine({ type: 'om.observation', data: { id: 'om-tail', coversUpToId: 'm9', content: 'fresh tail observation', tokenCount: 5, createdAt: 't' } });
    const pad = Buffer.alloc(26 * 1024 * 1024, 0x78); // >READ_BYTES (25 МБ) of 'x'
    // file = header + head obs + 26MB pad + tail obs → head obs is outside the 25MB tail window
    const fd = openSync(file, 'w');
    writeSync(fd, `${JSON.stringify({ type: 'session', version: 3, id: 'sess', timestamp: 't', cwd: '/tmp' })}\n${headObs}\n`);
    writeSync(fd, pad);
    writeSync(fd, `\n${tailObs}\n`);
    closeSync(fd);
    const res = readPiLedger(file);
    expect(res).not.toBeNull();
    expect(res!.omEntries).toBe(1); // only the tail entry — head is beyond the window
    expect(res!.store.read('om.observation')[0]!.data.id).toBe('om-tail');
    // and the session id still comes from the header (separate head read)
    expect(res!.sessionId).toBe('sess');
  });
});

describe('readAllSync (A14 short-read loop)', () => {
  const fakeRead = (chunk: number, total: number) =>
    (_fd: number, buf: Buffer, off: number, len: number, pos: number): number => {
      const n = Math.min(chunk, len, Math.max(0, total - pos));
      for (let i = 0; i < n; i++) buf[off + i] = 97 + ((pos + i) % 26); // 'a'..
      return n;
    };

  it('reassembles the range across short reads (chunk=3) with correct positions', () => {
    const total = 100;
    const buf = readAllSync(7, 0, 10, fakeRead(3, total));
    expect(buf.toString()).toBe('abcdefghij');
  });

  it('handles a single full read and an EOF (0) mid-read → shorter result, no zero-fill', () => {
    expect(readAllSync(7, 5, 4, fakeRead(1000, 9)).toString()).toBe('fghi');
    // read reports 5 bytes once, then EOF (0): only those 5 come back (old code zero-filled the rest)
    let calls = 0;
    const n = readAllSync(7, 0, 10, () => (calls++ === 0 ? 5 : 0)).length;
    expect(n).toBe(5);
  });

  it('advances the absolute position across loop iterations (from=10)', () => {
    expect(readAllSync(7, 10, 5, fakeRead(2, 100)).toString()).toBe('klmno');
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

  it('expectedSessionId: picks the matching session even when a foreign one is newer (A3)', () => {
    const sessions = path.join(dir, 'sessions');
    const aDir = path.join(sessions, '--tmp-a--');
    const bDir = path.join(sessions, '--tmp-b--');
    for (const d of [aDir, bDir]) mkdirSync(d, { recursive: true });
    const foreign = path.join(aDir, 'foreign.jsonl'); // newest, session id 'sess-a'
    const own = path.join(bDir, 'own.jsonl'); // older, session id 'sess-b'
    writePiSession(foreign, 'sess-a');
    writePiSession(own, 'sess-b');
    const t = (ms: number) => new Date(ms);
    utimesSync(foreign, t(2000), t(2000));
    utimesSync(own, t(1000), t(1000));
    // without filter: the foreign (newer) session wins
    expect(scanForPiSession(sessions)).toBe(foreign);
    // with filter: only the matching session id is eligible
    expect(scanForPiSession(sessions, 'sess-b')).toBe(own);
    // unknown id: nothing matches
    expect(scanForPiSession(sessions, 'sess-c')).toBeNull();
  });

  it('returns null for a missing dir', () => {
    expect(scanForPiSession(path.join(dir, 'no-such-dir'))).toBeNull();
  });
});

describe('MCP tools over a pi session (M5)', () => {
  it('OM_MCP_PI_SESSION: status source=pi-session, recall finds pi observations', () => {
    const file = path.join(dir, 'pi', 'sess.jsonl');
    mkdirSync(path.dirname(file), { recursive: true });
    writePiSession(file, S);
    process.env.OM_MCP_PI_SESSION = file;

    const status = call('om_status');
    expect(status).toContain(`source: pi-session — ${file}`);
    expect(status).toContain(`session: ${S}`); // header id visible next to source (A3)
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
    writePiSession(piFile, S);
    process.env.OM_MCP_PI_SESSIONS_DIR = path.join(dir, 'sessions');
    expect(call('om_status')).toContain(`source: pi-session — ${piFile}`);
    expect(call('om_recall', { query: 'sqlite storage' })).toContain('[observation]');

    // A3: foreign session id → auto-scan must NOT pick it (OM_MCP_SESSION is the cross-check)
    process.env.OM_MCP_SESSION = 'some-other-session';
    expect(call('om_status')).toContain('source: embedded —');
  });

  it('A3: two projects — OM_MCP_SESSION selects the matching session, foreign id falls back to embedded', () => {
    const sessions = path.join(dir, 'sessions');
    const aDir = path.join(sessions, '--tmp-a--');
    const bDir = path.join(sessions, '--tmp-b--');
    for (const d of [aDir, bDir]) mkdirSync(d, { recursive: true });
    const foreign = path.join(aDir, 'foreign.jsonl'); // newest mtime, id 'sess-a'
    const own = path.join(bDir, 'own.jsonl'); // older, id 'sess-b'
    writePiSession(foreign, 'sess-a');
    writePiSession(own, 'sess-b');
    const t = (ms: number) => new Date(ms);
    utimesSync(foreign, t(2000), t(2000));
    utimesSync(own, t(1000), t(1000));

    // (a) OM_MCP_SESSION = the second (older) session → it wins over the newer foreign one
    process.env.OM_MCP_SESSION = 'sess-b';
    process.env.OM_MCP_PI_SESSIONS_DIR = sessions;
    expect(call('om_status')).toContain(`source: pi-session — ${own}`);
    expect(call('om_status')).toContain('session: sess-b');

    // (b) OM_MCP_SESSION set but no matching pi file → embedded fallback with source marker
    process.env.OM_MCP_SESSION = 'sess-c';
    expect(call('om_status')).toContain('source: embedded —');

    // explicit path with foreign id is rejected too → embedded
    process.env.OM_MCP_SESSION = 'sess-c';
    process.env.OM_MCP_PI_SESSION = own;
    expect(call('om_status')).toContain('source: embedded —');
  });

  it('explicit OM_MCP_PI_SESSION wins over the scan; invalid explicit falls back to embedded', () => {
    const sessions = path.join(dir, 'sessions', '--tmp--');
    mkdirSync(sessions, { recursive: true });
    const scannedFile = path.join(sessions, 'scanned.jsonl');
    writePiSession(scannedFile, S);
    const explicitFile = path.join(dir, 'explicit.jsonl');
    writePiSession(explicitFile, S);
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
    writePiSession(file, S);
    process.env.OM_MCP_PI_SESSION = file;
    const text = call('om_topics');
    expect(text).toContain('Db');
  });
});
