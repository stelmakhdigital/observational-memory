/**
 * FileLedgerStore: the append-only ledger seam backed by a JSONL file
 * (one line per entry, one file per session). Agent-agnostic storage used by
 * embedded integrations (no pi); the pi adapter uses pi.appendEntry instead.
 *
 * Semantics: strictly append-only — corrupted lines are skipped on read (warn
 * via callback), never rewritten. Branch-locality is NOT a property of this
 * store: a session file is one linear history (FR mapping is the adapter's job).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  /**
   * Crash-durability (v0.6): a sibling lock file (<file>.lock, {pid, at})
   * guards against TWO OM processes writing the same session ledger (a
   * host wiring bug). A live, fresh lock from another pid blocks appends
   * (via onAppendError, never a throw); stale locks are taken over.
   * Disable with lock: false (single-process hosts).
   */
  lock?: boolean;
  /** Lock staleness threshold (ms, default 10 min). */
  lockStaleMs?: number;
}

const DEFAULT_LOCK_STALE_MS = 10 * 60 * 1000;

interface LockInfo {
  pid: number;
  at: string;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means the process exists but we can't signal it → alive.
    return e instanceof Error && 'code' in e && (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export class FileLedgerStore implements LedgerStore {
  private readonly file: string;
  private readonly onCorrupt: (lineNo: number, error: string) => void;
  private readonly onAppendError: (error: string) => void;
  private readonly lockFile: string;
  private readonly lockEnabled: boolean;
  private readonly lockStaleMs: number;
  /** Set when a live foreign lock blocks appends (diagnostics). */
  blockedBy?: string;

  constructor(opts: FileLedgerStoreOptions) {
    this.file = opts.file;
    this.onCorrupt = opts.onCorrupt ?? (() => {});
    this.onAppendError = opts.onAppendError ?? ((e) => console.error(`[om] ledger append failed: ${e}`));
    this.lockEnabled = opts.lock ?? true;
    this.lockStaleMs = opts.lockStaleMs ?? DEFAULT_LOCK_STALE_MS;
    this.lockFile = `${this.file}.lock`;
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
    } catch {
      /* created lazily on append; read-tolerant */
    }
    if (this.lockEnabled) this.acquireLock();
  }

  private acquireLock(): void {
    const existing = this.readLock();
    if (existing && existing.pid !== process.pid) {
      const age = Date.now() - new Date(existing.at).getTime();
      const fresh = Number.isFinite(age) && age < this.lockStaleMs;
      if (fresh && pidAlive(existing.pid)) {
        this.blockedBy = `pid ${existing.pid} (lock ${new Date(existing.at).toISOString()})`;
        return; // another live OM process owns this ledger
      }
    }
    // Take over (no lock, own lock, dead pid, or stale): best-effort write.
    try {
      writeFileSync(this.lockFile, JSON.stringify({ pid: process.pid, at: new Date().toISOString() } satisfies LockInfo), 'utf8');
      this.blockedBy = undefined;
    } catch (e) {
      this.onAppendError(`lock write failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private readLock(): LockInfo | null {
    try {
      const v = JSON.parse(readFileSync(this.lockFile, 'utf8')) as Partial<LockInfo>;
      if (typeof v.pid === 'number' && typeof v.at === 'string') return { pid: v.pid, at: v.at };
      return null;
    } catch {
      return null;
    }
  }

  /** True when appends are blocked by a live foreign lock (diagnostics). */
  isBlocked(): boolean {
    return this.blockedBy !== undefined;
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
    if (this.lockEnabled && this.blockedBy) {
      this.onAppendError(`append refused: ledger locked by ${this.blockedBy}`);
      return;
    }
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
