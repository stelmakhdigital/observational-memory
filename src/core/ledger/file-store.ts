/**
 * FileLedgerStore: the append-only ledger seam backed by a JSONL file
 * (one line per entry, one file per session). Agent-agnostic storage used by
 * embedded integrations (no pi); the pi adapter uses pi.appendEntry instead.
 *
 * Semantics: strictly append-only — corrupted lines are skipped on read (warn
 * via callback), never rewritten. Branch-locality is NOT a property of this
 * store: a session file is one linear history (FR mapping is the adapter's job).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { LedgerEntryType, LedgerPayload, LedgerStore, TombstoneReport, TypedLedgerEntry } from '../types.js';

export interface FileLedgerStoreOptions {
  /** File path, e.g. <root>/<sessionId>/ledger.jsonl. */
  file: string;
  /** Warn callback for corrupt lines (default: silent). */
  onCorrupt?: (lineNo: number, error: string) => void;
  /** Warn callback when an append fails (e.g. dir vanished). Default: console.error.
   *  Never throws: OM must not crash the host (NFR-1). */
  onAppendError?: (error: string) => void;
}

export class FileLedgerStore implements LedgerStore {
  private readonly file: string;
  private readonly onCorrupt: (lineNo: number, error: string) => void;
  private readonly onAppendError: (error: string) => void;

  constructor(opts: FileLedgerStoreOptions) {
    this.file = opts.file;
    this.onCorrupt = opts.onCorrupt ?? (() => {});
    this.onAppendError = opts.onAppendError ?? ((e) => console.error(`[om] ledger append failed: ${e}`));
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
    } catch {
      /* created lazily on append; read-tolerant */
    }
  }

  private parseLine(line: string): TypedLedgerEntry<LedgerEntryType> | null {
    try {
      const e = JSON.parse(line) as { type?: LedgerEntryType; data?: unknown; at?: string; meta?: unknown };
      if (!e.type || !e.data || !e.at) return null;
      return {
        type: e.type,
        data: e.data as LedgerPayload[LedgerEntryType],
        at: e.at,
        meta: e.meta as { runId?: string } | undefined,
      };
    } catch {
      return null;
    }
  }

  append<T extends LedgerEntryType>(entry: TypedLedgerEntry<T>): void {
    try {
      appendFileSync(this.file, JSON.stringify(entry) + '\n', 'utf8');
    } catch (e) {
      this.onAppendError(e instanceof Error ? e.message : String(e));
    }
  }

  read<T extends LedgerEntryType>(type?: T): TypedLedgerEntry<T>[] {
    if (!existsSync(this.file)) return [];
    const out: TypedLedgerEntry<T>[] = [];
    const lines = readFileSync(this.file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (!line.trim()) return;
      const e = this.parseLine(line);
      if (!e) {
        this.onCorrupt(i + 1, 'unparseable ledger line skipped');
        return;
      }
      if (type && e.type !== type) return;
      out.push(e as TypedLedgerEntry<T>);
    });
    return out;
  }

  tombstone(observationIds: string[], report: Omit<TombstoneReport, 'observationIds'>): void {
    const at = new Date().toISOString();
    this.append({
      type: 'om.tombstone',
      data: { observationIds, ...report },
      at,
    });
  }

  /** All entries (any type), commit order — for debugging/testing. */
  entries(): TypedLedgerEntry<LedgerEntryType>[] {
    return this.read();
  }
}

/** Stable helper: default ledger file for a memory root + session. */
export function defaultLedgerFile(root: string, sessionId: string): string {
  // mirror MemoryStore sanitization lightly: session ids are safe in practice
  const safe = sessionId.replace(/[^\w.-]/g, '_') || 'unnamed';
  return path.join(root, safe, 'ledger.jsonl');
}
