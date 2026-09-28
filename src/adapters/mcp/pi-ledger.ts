/**
 * Pi-session ledger source for the MCP server (M5).
 *
 * The pi adapter stores its ledger as custom entries (customType 'om') inside
 * the pi session JSONL (~/.pi/agent/sessions/<cwd-encoded>/*.jsonl), NOT in
 * <root>/<sessionId>/ledger.jsonl — so a plain FileLedgerStore sees zero
 * observations for pi sessions. This module reads a session file directly and
 * exposes its om.* entries as a read-only LedgerStore in the same shape that
 * FileLedgerStore returns (so pool fold / recall work unchanged).
 *
 * The mcp adapter stays dependency-free (no import of adapters/pi): the
 * payload validation below is a deliberate ~30-line duplicate of
 * src/adapters/pi/ledger.ts — keep the two in sync.
 *
 * Known limitation (see README, MCP section): a session file is ONE linear
 * history; pi branch semantics (branch-local ledger under /tree) cannot be
 * reconstructed here, so entries from ALL branches are visible. Fine for a
 * read-only consumer, but be aware of it after tree navigation.
 */
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import path from 'node:path';
import type { LedgerEntryType, LedgerPayload, LedgerStore, TypedLedgerEntry } from '../../core/types.js';

/** Tail-cap for scanning (om entries are appended over time → the tail is what matters). */
export const SCAN_BYTES = 5 * 1024 * 1024;
/** Only the N newest .jsonl files (by mtime) are considered during the scan. */
export const SCAN_FILE_LIMIT = 50;
/** Hard cap when fully parsing one session file. */
export const READ_BYTES = 25 * 1024 * 1024;

/** S3: the shared strict payload validator (core/ledger/payload.ts). */
import { omPayloadOk } from '../../core/ledger/payload.js';

/** Read-only LedgerStore over parsed pi-session om entries (append is a no-op). */
export class PiSessionLedger implements LedgerStore {
  constructor(private readonly entries: TypedLedgerEntry<LedgerEntryType>[]) {}

  append(): void {
    /* read-only consumer */
  }

  tombstone(): void {
    /* read-only consumer */
  }

  read<T extends LedgerEntryType>(type?: T): TypedLedgerEntry<T>[] {
    return this.entries
      .filter((e) => !type || e.type === type)
      .map((e) => ({ ...e })) as TypedLedgerEntry<T>[];
  }
}

/**
 * Read `len` bytes starting at `from`, looping while a single readSync call
 * may return fewer (short read) — without the loop a partial last read is
 * zero-filled and the freshest (tail) line becomes corrupt and is dropped.
 * Returns fewer bytes than `len` only at EOF. `read` is injectable for tests.
 */
export function readAllSync(
  fd: number,
  from: number,
  len: number,
  read: (fd: number, buf: Buffer, offset: number, length: number, position: number) => number,
): Buffer {
  const out = Buffer.alloc(len);
  let off = 0;
  while (off < len) {
    const n = read(fd, out, off, len - off, from + off);
    if (n <= 0) break; // EOF
    off += n;
  }
  return off < len ? out.subarray(0, off) : out;
}

function readRange(file: string, from: number, len: number): string | null {
  try {
    const fd = openSync(file, 'r');
    try {
      return readAllSync(fd, from, len, readSync).toString('utf8');
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

/**
 * Session id from the first JSONL line — pi writes a header like
 * {"type":"session","version":3,"id":"<uuid>","timestamp":...,"cwd":...}.
 * Returns null when the file/header is missing or the first line is not a
 * session header (NFR-1: corrupt heads never throw).
 */
export function readPiSessionId(file: string): string | null {
  try {
    const { size } = statSync(file);
    if (size === 0) return null;
    const head = readRange(file, 0, Math.min(size, 8192));
    if (!head) return null;
    const nl = head.indexOf('\n');
    const first = nl === -1 ? head : head.slice(0, nl);
    const h = JSON.parse(first) as { type?: string; id?: string };
    return h.type === 'session' && typeof h.id === 'string' ? h.id : null;
  } catch {
    return null;
  }
}

export interface PiLedgerResult {
  store: PiSessionLedger;
  omEntries: number;
  /** Session id from the header line, null when the header is missing. */
  sessionId: string | null;
}

/**
 * Parse a pi session JSONL into a read-only ledger. Returns null when the
 * file is missing/unreadable, contains no valid om.* entries, or — when
 * `expectedSessionId` is given — its header session id differs (a foreign
 * project's session must never be answered from). Reads the TAIL (last
 * READ_BYTES): fresh om entries are appended at the end of the file; for
 * files larger than READ_BYTES the window may start mid-line, and that
 * partial first line is skipped like any corrupt line.
 * Garbage lines (crash tails, foreign tools) are skipped, never thrown.
 */
export function readPiLedger(file: string, expectedSessionId?: string): PiLedgerResult | null {
  const sessionId = readPiSessionId(file);
  if (expectedSessionId !== undefined && sessionId !== expectedSessionId) return null;
  let raw: string;
  try {
    const { size } = statSync(file);
    if (size === 0) return null;
    const from = Math.max(0, size - READ_BYTES);
    const r = readRange(file, from, size - from);
    if (r === null) return null;
    raw = r;
  } catch {
    return null;
  }
  const entries: TypedLedgerEntry<LedgerEntryType>[] = [];
  for (const line of raw.split('\n')) {
    if (!line.includes('"om"')) continue; // cheap prefilter
    let e: {
      type?: string;
      customType?: string;
      data?: unknown;
      timestamp?: string;
    };
    try {
      e = JSON.parse(line) as typeof e;
    } catch {
      continue; // corrupt line (NFR-1)
    }
    if (e.type !== 'custom' || e.customType !== 'om' || typeof e.data !== 'object' || e.data === null) continue;
    const rec = e.data as { type?: string; data?: unknown; at?: string; meta?: { runId?: string } };
    if (typeof rec.type !== 'string') continue;
    const etype = rec.type as LedgerEntryType;
    if (!omPayloadOk(etype, rec.data)) continue;
    entries.push({
      type: etype,
      data: rec.data as LedgerPayload[LedgerEntryType],
      at: typeof rec.at === 'string' ? rec.at : typeof e.timestamp === 'string' ? e.timestamp : '1970-01-01T00:00:00Z',
      meta: rec.meta,
    });
  }
  if (entries.length === 0) return null;
  return { store: new PiSessionLedger(entries), omEntries: entries.length, sessionId };
}

function collectJsonl(dir: string, out: string[]): void {
  let names;
  try {
    names = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const n of names) {
    const p = path.join(dir, n.name);
    if (n.isDirectory()) collectJsonl(p, out);
    else if (n.isFile() && n.name.endsWith('.jsonl')) out.push(p);
  }
}

/**
 * Find the most recent session file (by mtime) containing om entries under
 * `sessionsDir` (typically ~/.pi/agent/sessions). Only the SCAN_FILE_LIMIT
 * newest .jsonl files are checked (tail read, SCAN_BYTES each). When
 * `expectedSessionId` is given, files whose header session id differs are
 * skipped (a foreign project's session must never win the auto-scan).
 * Returns null when nothing matches or the dir is missing.
 */
export function scanForPiSession(sessionsDir: string, expectedSessionId?: string): string | null {
  if (!existsSync(sessionsDir)) return null;
  const files: string[] = [];
  collectJsonl(sessionsDir, files);
  const newest = files
    .map((f) => ({ f, mtime: statSync(f).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, SCAN_FILE_LIMIT);
  for (const { f } of newest) {
    if (expectedSessionId !== undefined && readPiSessionId(f) !== expectedSessionId) continue;
    let size: number;
    try {
      size = statSync(f).size;
    } catch {
      continue;
    }
    const len = Math.min(size, SCAN_BYTES);
    const tail = readRange(f, size - len, len);
    if (tail !== null && tail.includes('"customType":"om"')) return f;
  }
  return null;
}
