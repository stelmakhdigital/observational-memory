import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FileLedgerStore, defaultLedgerFile } from '../../src/core/ledger/file-store.js';

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

  it('skips corrupt lines and reports via onCorrupt', () => {
    const warnings: string[] = [];
    const store = new FileLedgerStore({ file, onCorrupt: (_l, err) => warnings.push(err) });
    store.append(enabled(true));
    appendFileSync(file, 'not-json{{{\n', 'utf8');
    store.append(enabled(false));
    const all = store.read<'om.enabled'>('om.enabled');
    expect(all.map((e) => e.data.enabled)).toEqual([true, false]);
    expect(warnings.length).toBe(1);
  });

  it('ignores lines missing required fields', () => {
    const store = new FileLedgerStore({ file });
    writeFileSync(file, JSON.stringify({ type: 'om.enabled' }) + '\n' + JSON.stringify(enabled(true)) + '\n', 'utf8');
    expect(store.read('om.enabled').length).toBe(1);
  });

  it('defaultLedgerFile sanitizes the session id and stays under root', () => {
    expect(defaultLedgerFile('/mem', 'a/b')).toBe(path.join('/mem', 'a_b', 'ledger.jsonl'));
    expect(defaultLedgerFile('/mem', 'plain-123')).toBe(path.join('/mem', 'plain-123', 'ledger.jsonl'));
  });
});
