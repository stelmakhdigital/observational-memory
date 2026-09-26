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

/** Loose payload shape check (NFR-1: corrupt payloads are skipped, never throw).
 *  Duplicate of payloadOk in src/adapters/pi/ledger.ts — keep in sync. */
function payloadOk(type: LedgerEntryType, data: unknown): data is LedgerPayload[LedgerEntryType] {
  if (typeof data !== 'object' || data === null) return false;
  const d = data as Record<string, unknown>;
  switch (type) {
    case 'om.observation':
      return (
        typeof d.id === 'string' &&
        typeof d.coversUpToId === 'string' &&
        typeof d.content === 'string' &&
        typeof d.tokenCount === 'number'
      );
    case 'om.tombstone':
      return Array.isArray(d.observationIds);
    case 'om.cost':
      return typeof d.runId === 'string' && typeof d.usd === 'number';
    case 'om.gap-marker':
      return typeof d.id === 'string' && typeof d.ms === 'number';
    case 'om.enabled':
      return typeof d.enabled === 'boolean';
    case 'om.run':
      return typeof d.runId === 'string' && typeof d.status === 'string';
    case 'om.lastError':
      return typeof d.message === 'string';
    default:
      return false;
  }
}

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

function readRange(file: string, from: number, len: number): string | null {
  try {
    const fd = openSync(file, 'r');
    try {
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, from);
      return buf.toString('utf8');
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

/**
 * Parse a pi session JSONL into a read-only ledger. Returns null when the
 * file is missing/unreadable or contains no valid om.* entries.
 * Garbage lines (crash tails, foreign tools) are skipped, never thrown.
 */
export function readPiLedger(file: string): { store: PiSessionLedger; omEntries: number } | null {
  let raw: string;
  try {
    const { size } = statSync(file);
    const len = Math.min(size, READ_BYTES);
    const r = readRange(file, 0, len);
    if (r === null || len === 0) return null;
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
    if (!payloadOk(etype, rec.data)) continue;
    entries.push({
      type: etype,
      data: rec.data as LedgerPayload[LedgerEntryType],
      at: typeof rec.at === 'string' ? rec.at : typeof e.timestamp === 'string' ? e.timestamp : '1970-01-01T00:00:00Z',
      meta: rec.meta,
    });
  }
  if (entries.length === 0) return null;
  return { store: new PiSessionLedger(entries), omEntries: entries.length };
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
 * newest .jsonl files are checked (tail read, SCAN_BYTES each). Returns null
 * when nothing matches or the dir is missing.
 */
export function scanForPiSession(sessionsDir: string): string | null {
  if (!existsSync(sessionsDir)) return null;
  const files: string[] = [];
  collectJsonl(sessionsDir, files);
  const newest = files
    .map((f) => ({ f, mtime: statSync(f).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, SCAN_FILE_LIMIT);
  for (const { f } of newest) {
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
