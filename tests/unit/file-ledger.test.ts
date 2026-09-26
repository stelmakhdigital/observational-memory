import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import * as nodeFs from 'node:fs';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { FileLedgerStore, defaultLedgerFile } from '../../src/core/ledger/file-store.js';

// Wrap node:fs.readFileSync with a pass-through spy (to measure disk reads, n6).
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, readFileSync: vi.fn((...args: Parameters<typeof actual.readFileSync>) => actual.readFileSync(...args)) };
});
const fsReadSpy = () => nodeFs.readFileSync as unknown as Mock;

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'om-fls-'));
  file = path.join(dir, 'sess', 'ledger.jsonl');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const enabled = (v: boolean) => ({
  type: 'om.enabled' as const,
  data: { enabled: v },
  at: new Date().toISOString(),
});

describe('FileLedgerStore', () => {
  it('creates the file lazily and reads empty when absent', () => {
    const store = new FileLedgerStore({ file });
    expect(existsSync(file)).toBe(false); // no file until first append
    expect(store.read()).toEqual([]);
  });

  it('appends and reads entries in commit order (typed)', () => {
    const store = new FileLedgerStore({ file });
    store.append(enabled(true));
    store.append(enabled(false));
    store.append(enabled(true));
    const all = store.read<'om.enabled'>('om.enabled');
    expect(all.map((e) => e.data.enabled)).toEqual([true, false, true]);
    expect(store.read<'om.cost'>('om.cost')).toEqual([]);
  });

  it('tombstone appends an om.tombstone entry', () => {
    const store = new FileLedgerStore({ file });
    store.tombstone(['om-a', 'om-b'], { topics: ['t.md'], journeyChanged: true, maxCoversUpToId: 'm9', maxSeq: 2 });
    const t = store.read<'om.tombstone'>('om.tombstone');
    expect(t.length).toBe(1);
    expect(t[0]!.data.observationIds).toEqual(['om-a', 'om-b']);
    expect(t[0]!.data.topics).toEqual(['t.md']);
  });

  // NOTE: reads are served from the in-memory index built at OPEN (the lock
  // guarantees a single writer, so external writes after open are out of
  // contract). Corrupt-line handling is therefore exercised at open time.

  it('skips corrupt lines and reports via onCorrupt at open', () => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(enabled(true))}\nnot-json{{{\n${JSON.stringify(enabled(false))}\n`, 'utf8');
    const warnings: string[] = [];
    const store = new FileLedgerStore({ file, onCorrupt: (_l, err) => warnings.push(err) });
    const all = store.read<'om.enabled'>('om.enabled');
    expect(all.map((e) => e.data.enabled)).toEqual([true, false]);
    expect(warnings.length).toBe(1);
  });

  it('ignores lines missing required fields', () => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ type: 'om.enabled' }) + '\n' + JSON.stringify(enabled(true)) + '\n', 'utf8');
    const store = new FileLedgerStore({ file });
    expect(store.read('om.enabled').length).toBe(1);
  });

  it('defaultLedgerFile sanitizes the session id and stays under root', () => {
    expect(defaultLedgerFile('/mem', 'a/b')).toBe(path.join('/mem', 'a_b', 'ledger.jsonl'));
    expect(defaultLedgerFile('/mem', 'plain-123')).toBe(path.join('/mem', 'plain-123', 'ledger.jsonl'));
  });
});

describe('FileLedgerStore crash-repair (M4)', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'om-fls-repair-'));
    file = path.join(dir, 'sess', 'ledger.jsonl');
    mkdirSync(path.dirname(file), { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('drops a partial last line (crash mid-append), keeps prior committed lines, signals via onRepair', () => {
    const store = new FileLedgerStore({ file });
    store.append(enabled(true)); // line 1
    store.append(enabled(false)); // line 2
    store.append(enabled(true)); // line 3
    // Simulate a crash mid-write: cut the last line (3) in half.
    const raw = readFileSync(file, 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    writeFileSync(file, raw.slice(0, raw.length - 10), 'utf8');

    const repairs: number[] = [];
    const store2 = new FileLedgerStore({ file, onRepair: (l) => repairs.push(l) });
    expect(repairs).toEqual([3]); // the partial line is line 3
    expect(store2.repairs).toBe(1);
    const all = store2.read<'om.enabled'>('om.enabled');
    expect(all.map((e) => e.data.enabled)).toEqual([true, false]); // lines 1-2 intact

    // The repair is durable: the partial tail is truncated off the file…
    const fixed = readFileSync(file, 'utf8');
    expect(fixed.endsWith('\n')).toBe(true);
    expect(fixed.split('\n').filter((l) => l.trim())).toHaveLength(2);
    // …so a re-open does not re-report.
    const repairs2: number[] = [];
    new FileLedgerStore({ file, onRepair: (l) => repairs2.push(l) });
    expect(repairs2).toEqual([]);
    // And the repaired store keeps working (index consistent with disk).
    store2.append(enabled(false));
    expect(store2.read().length).toBe(3);
  });

  it('still appends after a repaired open; a fresh open sees all surviving committed lines', () => {
    const store = new FileLedgerStore({ file });
    store.append(enabled(true));
    store.append(enabled(false));
    const raw = readFileSync(file, 'utf8');
    writeFileSync(file, raw.slice(0, raw.length - 5), 'utf8'); // crash: line 2 destroyed
    const store2 = new FileLedgerStore({ file });
    store2.append(enabled(false));
    const store3 = new FileLedgerStore({ file }); // fresh open: line 1 survived + re-commit
    expect(store3.read<'om.enabled'>('om.enabled').map((e) => e.data.enabled)).toEqual([true, false]);
  });

  it('does NOT truncate a partial line when BLOCKED (foreign writer in flight)', () => {
    // Lock held by a "live" pid 1 (init) → we are blocked at open.
    writeFileSync(`${file}.lock`, JSON.stringify({ pid: 1, at: new Date().toISOString() }), 'utf8');
    writeFileSync(file, `${JSON.stringify(enabled(true))}\n{"type":"om.enabled","data":{"enabled":fal`, 'utf8');
    const errors: string[] = [];
    const repairs: number[] = [];
    const store = new FileLedgerStore({
      file,
      onAppendError: (e) => errors.push(e),
      onRepair: (l) => repairs.push(l),
    });
    expect(store.isBlocked()).toBe(true);
    store.append(enabled(false)); // refused
    expect(errors.length).toBe(1);
    expect(repairs).toEqual([]); // foreign partial line left untouched
    const onDisk = readFileSync(file, 'utf8');
    expect(onDisk.endsWith('fal')).toBe(true); // not truncated
    expect(store.read().length).toBe(1); // only committed lines indexed
  });
});

describe('FileLedgerStore O_EXCL lock across processes (M4)', () => {
  let dir: string;
  let file: string;
  let child: ChildProcess | undefined;
  const lockPath = () => `${file}.lock`;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'om-fls-lock-'));
    file = path.join(dir, 'sess', 'ledger.jsonl');
    mkdirSync(path.dirname(file), { recursive: true });
  });
  afterEach(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await once(child, 'exit').catch(() => {});
    }
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * A second OM process implementing the SAME lock protocol as FileLedgerStore
   * (O_EXCL create; on EEXIST: block if the foreign lock is live+fresh, else
   * steal+retry). Prints OWNED (keeps running, holding the lock) or
   * BLOCKED (exits 0).
   */
  function foreignOwner(): Promise<{ child: ChildProcess; marker: string }> {
    const script = [
      "const fs = require('node:fs');",
      `const lock = ${JSON.stringify(lockPath())};`,
      "function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }",
      "function info() { try { const v = JSON.parse(fs.readFileSync(lock, 'utf8')); return (typeof v.pid === 'number' && typeof v.at === 'string') ? v : null; } catch { return null; } }",
      'let ok = false;',
      'for (let i = 0; i < 100 && !ok; i++) {',
      '  try {',
      '    const fd = fs.openSync(lock, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o644);',
      "    fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));",
      '    fs.closeSync(fd);',
      '    ok = true;',
      '  } catch (e) {',
      "    if (e.code !== 'EEXIST') process.exit(2);",
      '    const ex = info();',
      '    if (ex && ex.pid !== process.pid) {',
      '      const age = Date.now() - new Date(ex.at).getTime();',
      "      if (Number.isFinite(age) && age < 600000 && alive(ex.pid)) { process.stdout.write('BLOCKED\\n'); process.exit(0); }",
      '    }',
      '    try { fs.unlinkSync(lock); } catch {}',
      '  }',
      '}',
      "if (!ok) { process.stdout.write('FAIL\\n'); process.exit(1); }",
      "process.stdout.write('OWNED\\n');",
      'setInterval(() => {}, 1000);',
    ].join('\n');
    return new Promise((resolve, reject) => {
      const c = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'] });
      let buf = '';
      c.stdout!.on('data', (d: Buffer) => {
        buf += d.toString();
        const marker = buf.includes('OWNED') ? 'OWNED' : buf.includes('BLOCKED') ? 'BLOCKED' : buf.includes('FAIL') ? 'FAIL' : null;
        if (marker) resolve({ child: c, marker });
      });
      c.on('error', reject);
      const t = setTimeout(() => {
        c.kill('SIGKILL');
        reject(new Error('foreign owner timeout'));
      }, 10_000);
      t.unref();
    });
  }

  it('opener wins the O_EXCL race; a concurrent second process is BLOCKED (never both own)', async () => {
    const store = new FileLedgerStore({ file }); // we win the O_EXCL race (opened first)
    expect(store.isBlocked()).toBe(false);
    const { child: c, marker } = await foreignOwner();
    child = c;
    expect(marker).toBe('BLOCKED'); // the child refused to steal a live lock
    // The lock file still carries OUR pid — no false "both own".
    expect((JSON.parse(readFileSync(lockPath(), 'utf8')) as { pid: number }).pid).toBe(process.pid);
    // And we can still append normally.
    store.append(enabled(true));
    expect(store.read().length).toBe(1);
  });

  it('a live foreign lock blocks appends; after the owner dies, stale takeover works', async () => {
    const { child: c, marker } = await foreignOwner();
    child = c;
    expect(marker).toBe('OWNED'); // child owns the lock and keeps running
    expect((JSON.parse(readFileSync(lockPath(), 'utf8')) as { pid: number }).pid).toBe(c.pid);

    const errors: string[] = [];
    const store = new FileLedgerStore({ file, onAppendError: (e) => errors.push(e) });
    expect(store.isBlocked()).toBe(true);
    expect(store.blockedBy).toContain(String(c.pid));
    store.append(enabled(true)); // refused while the foreign owner is alive
    expect(errors.length).toBe(1);
    expect(errors[0]!).toContain('locked');
    expect(existsSync(file)).toBe(false); // nothing written under a foreign lock

    // Owner dies and is reaped → the next append re-checks, sees the dead pid,
    // steals the stale lock and proceeds.
    c.kill('SIGKILL');
    await once(c, 'exit');
    store.append(enabled(true)); // → takeover
    expect(store.isBlocked()).toBe(false);
    expect(errors.length).toBe(1); // no further errors
    expect(store.read().length).toBe(1);
    expect((JSON.parse(readFileSync(lockPath(), 'utf8')) as { pid: number }).pid).toBe(process.pid);
  });
});

describe('FileLedgerStore in-memory index (n6)', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'om-fls-mem-'));
    file = path.join(dir, 'sess', 'ledger.jsonl');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('serves all reads from memory after open: 500 appends, then zero ledger readFileSync calls', () => {
    const store = new FileLedgerStore({ file });
    const at = new Date().toISOString();
    for (let i = 0; i < 500; i++) {
      store.append({
        type: 'om.cost',
        data: { runId: `r${i}`, role: 'observer', usd: 0.001, at },
        at,
      });
    }
    expect(store.read().length).toBe(500);
    expect(store.read('om.cost').length).toBe(500);

    // From here on: no read of the ledger file may hit the disk.
    const spy = fsReadSpy();
    spy.mockClear();
    for (let i = 0; i < 100; i++) {
      store.read();
      store.read('om.cost');
      store.entries();
      store.read('om.tombstone');
    }
    const ledgerReads = spy.mock.calls.filter((c) => c[0] === file).length;
    expect(ledgerReads).toBe(0); // reads are served from the in-memory index

    // …and results stay correct after appends interleaved with reads.
    store.append(enabled(true));
    expect(store.read().length).toBe(501);
    expect(store.read('om.enabled').length).toBe(1);
  });
});
