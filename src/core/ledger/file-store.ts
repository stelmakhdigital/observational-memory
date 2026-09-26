/**
 * FileLedgerStore: the append-only ledger seam backed by a JSONL file
 * (one line per entry, one file per session). Agent-agnostic storage used by
 * embedded integrations (no pi); the pi adapter uses pi.appendEntry instead.
 *
 * Guarantees (single-writer, crash-safe commits):
 * - The sibling lock `<file>.lock` ({pid, at}) is created with O_EXCL
 *   (open 'wx' semantics): two concurrent OM processes can NEVER both own
 *   the ledger — the loser sees EEXIST, then either blocks (fresh lock of a
 *   live foreign pid) or takes over (dead pid / stale age). Every append
 *   RE-CHECKS that we still own the lock before writing (a lock taken or
 *   stolen from under us blocks appends via onAppendError, never a throw).
 * - A commit is ONE write of the full line on an O_APPEND fd + fsync. A
 *   line on disk is therefore either a complete committed line or a partial
 *   prefix of one.
 * - On open: if the LAST line of the file is invalid (partial write left by
 *   a crash), it is dropped, truncated off the file, and reported via
 *   `onRepair(lineNo)` + `repairCount` — never silently. The truncation is
 *   idempotent, so a re-open does not re-report. Committed (complete) lines
 *   are never lost or rewritten. Invalid *middle* lines are corruption, not
 *   crash artifacts: skipped and reported via onCorrupt.
 * - All read operations are served from an in-memory index built once per
 *   open (append updates it in O(1)). The lock guarantees a single writer,
 *   so the file is never re-read after open — a full readFileSync+parse per
 *   read would degrade quadratically on long sessions and block the event
 *   loop.
 *
 * Semantics: strictly append-only (the sole exception being the truncation
 * of a crashed partial tail line at open). Branch-locality is NOT a property
 * of this store: a session file is one linear history (FR mapping is the
 * adapter's job).
 */
import { constants as fsc, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, truncateSync, unlinkSync, writeSync } from 'node:fs';
import path from 'node:path';
import type { LedgerEntryType, LedgerPayload, LedgerStore, TombstoneReport, TypedLedgerEntry } from '../types.js';

export interface FileLedgerStoreOptions {
  /** File path, e.g. <root>/<sessionId>/ledger.jsonl. */
  file: string;
  /** Warn callback for corrupt lines (default: silent). */
  onCorrupt?: (lineNo: number, error: string) => void;
  /** Warn callback when an append fails (e.g. dir vanished, lock contention).
   *  Default: console.error. Never throws: OM must not crash the host (NFR-1). */
  onAppendError?: (error: string) => void;
  /**
   * Crash-repair callback: invoked with the line number when the last line of
   * the file was a partial write (crash mid-append) and got dropped+truncated
   * at open. The repair is durable (file is fixed), so it fires once per
   * crash, not on every re-open.
   */
  onRepair?: (lineNo: number) => void;
  /**
   * Crash-durability: a sibling lock file (<file>.lock, {pid, at}) guards
   * against TWO OM processes writing the same session ledger (a host wiring
   * bug). Created with O_EXCL (atomic); a live, fresh lock from another pid
   * blocks appends (via onAppendError, never a throw); stale locks are taken
   * over. Disable with lock: false (single-process hosts / read-only use).
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

function isErrno(e: unknown, code: string): boolean {
  return e instanceof Error && 'code' in e && (e as NodeJS.ErrnoException).code === code;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export class FileLedgerStore implements LedgerStore {
  private readonly file: string;
  private readonly onCorrupt: (lineNo: number, error: string) => void;
  private readonly onAppendError: (error: string) => void;
  private readonly onRepair: (lineNo: number) => void;
  private readonly lockFile: string;
  private readonly lockEnabled: boolean;
  private readonly lockStaleMs: number;
  /** Set when a live foreign lock blocks appends (diagnostics). */
  blockedBy?: string;
  /** In-memory index: all entries in commit order (rebuilt only at open/repair). */
  private index: TypedLedgerEntry<LedgerEntryType>[] = [];
  /** Number of crash-repairs (partial tail lines) applied at open. */
  private repairCount = 0;

  constructor(opts: FileLedgerStoreOptions) {
    this.file = opts.file;
    this.onCorrupt = opts.onCorrupt ?? (() => {});
    this.onAppendError = opts.onAppendError ?? ((e) => console.error(`[om] ledger append failed: ${e}`));
    this.onRepair = opts.onRepair ?? (() => {});
    this.lockEnabled = opts.lock ?? true;
    this.lockStaleMs = opts.lockStaleMs ?? DEFAULT_LOCK_STALE_MS;
    this.lockFile = `${this.file}.lock`;
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
    } catch {
      /* created lazily on append; read-tolerant */
    }
    if (this.lockEnabled) this.acquireLock();
    // Only the lock OWNER may repair: a blocked reader must not truncate a
    // partial line that is the other live writer's in-flight commit.
    this.load(this.blockedBy === undefined);
  }

  /** Number of partial-tail lines repaired (dropped+truncated) at open. */
  get repairs(): number {
    return this.repairCount;
  }

  // ---- lock (O_EXCL, re-checked on every append) ---------------------------------

  /**
   * Atomically take the lock. Loop: O_EXCL create (EEXIST = someone else got
   * there first) → inspect: live+fresh foreign owner → block; otherwise
   * (dead pid, stale age, unparsable, own) unlink and retry the O_EXCL race.
   */
  private acquireLock(): void {
    for (;;) {
      try {
        const fd = openSync(this.lockFile, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL, 0o644);
        try {
          writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() } satisfies LockInfo));
        } finally {
          closeSync(fd);
        }
        this.blockedBy = undefined;
        return;
      } catch (e) {
        if (!isErrno(e, 'EEXIST')) {
          this.onAppendError(`lock create failed: ${errMsg(e)}`);
          return;
        }
        const existing = this.readLock();
        if (this.isLiveForeign(existing)) {
          this.blockedBy = `pid ${existing!.pid} (lock ${new Date(existing!.at).toISOString()})`;
          return;
        }
        // Steal (no readable info, our own lock, dead pid, or stale) and
        // retry the atomic create — a concurrent stealer may win the race.
        try {
          unlinkSync(this.lockFile);
        } catch {
          /* already gone — retry the create */
        }
      }
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

  /** True if `existing` is a fresh lock of a LIVE other pid (must not steal). */
  private isLiveForeign(existing: LockInfo | null): existing is LockInfo {
    if (!existing || existing.pid === process.pid) return false;
    const age = Date.now() - new Date(existing.at).getTime();
    return Number.isFinite(age) && age < this.lockStaleMs && pidAlive(existing.pid);
  }

  /**
   * Re-check lock ownership right before a write. Returns false (and reports
   * via onAppendError) if a live foreign owner holds the lock. Restores the
   * lock if it vanished; takes over stale/dead foreign locks.
   */
  private ensureLock(): boolean {
    if (!this.lockEnabled) return true;
    this.blockedBy = undefined;
    const existing = this.readLock();
    if (existing && existing.pid === process.pid) return true; // still ours
    if (this.isLiveForeign(existing)) {
      this.blockedBy = `pid ${existing!.pid} (lock ${new Date(existing!.at).toISOString()})`;
      this.onAppendError(`append refused: ledger locked by ${this.blockedBy}`);
      return false;
    }
    // Our lock vanished (existing == null) or a foreign stale/dead lock:
    // steal (if needed) and re-acquire atomically.
    if (existing) {
      try {
        unlinkSync(this.lockFile);
      } catch {
        /* already gone */
      }
    }
    this.acquireLock();
    return this.blockedBy === undefined;
  }

  /** True when appends are blocked by a live foreign lock (diagnostics). */
  isBlocked(): boolean {
    return this.blockedBy !== undefined;
  }

  // ---- load / crash-repair / in-memory index -------------------------------------

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

  /**
   * Build the in-memory index from disk (only at open). Crash-repair: if the
   * LAST non-empty line is invalid, it is a partial write from a crash — drop
   * it, truncate the file, and report via onRepair. Invalid middle lines are
   * corruption → onCorrupt, skipped, left in place.
   * @param mayRepair only the lock owner repairs (a blocked reader may see a
   *                  foreign writer's in-flight partial line — never touch it)
   */
  private load(mayRepair: boolean): void {
    this.index = [];
    this.repairCount = 0;
    let text: string;
    try {
      text = readFileSync(this.file, 'utf8');
    } catch {
      return; // no file yet — empty ledger
    }
    const lines = text.split('\n');
    let lastNonEmpty = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i]!.trim()) {
        lastNonEmpty = i;
        break;
      }
    }
    let truncateAt = -1;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (!line.trim()) continue;
      const e = this.parseLine(line);
      if (!e) {
        if (i === lastNonEmpty && !mayRepair) continue; // foreign in-flight line: leave alone
        if (i === lastNonEmpty) {
          // Partial tail line = a write interrupted by a crash (never committed).
          this.repairCount++;
          this.onRepair(i + 1);
          truncateAt = text.length - lines.slice(i).join('\n').length;
        } else {
          this.onCorrupt(i + 1, 'unparseable ledger line skipped');
        }
        continue;
      }
      this.index.push(e);
    }
    if (truncateAt >= 0 && truncateAt < text.length) {
      // Persist the repair (idempotent): the partial line is removed for good,
      // so re-open does not re-report it. Committed lines are untouched.
      try {
        truncateSync(this.file, truncateAt);
      } catch (e) {
        this.onAppendError(`crash-repair truncate failed: ${errMsg(e)}`);
      }
    }
  }

  // ---- LedgerStore ----------------------------------------------------------------

  append<T extends LedgerEntryType>(entry: TypedLedgerEntry<T>): void {
    if (this.lockEnabled && !this.ensureLock()) return;
    let fd = -1;
    try {
      fd = openSync(this.file, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_APPEND, 0o644);
      // ONE write of the whole line + fsync → committed atomically enough:
      // a crash leaves either the full line or a detectable partial prefix.
      writeSync(fd, JSON.stringify(entry) + '\n');
      fsyncSync(fd);
    } catch (e) {
      this.onAppendError(errMsg(e));
      return;
    } finally {
      if (fd >= 0) {
        try {
          closeSync(fd);
        } catch {
          /* ignore */
        }
      }
    }
    this.index.push(entry as TypedLedgerEntry<LedgerEntryType>); // O(1) index update
  }

  /** Read from the in-memory index — no disk I/O (single-writer is lock-guaranteed). */
  read<T extends LedgerEntryType>(type?: T): TypedLedgerEntry<T>[] {
    if (!type) return this.index.slice() as TypedLedgerEntry<T>[];
    const out: TypedLedgerEntry<T>[] = [];
    for (const e of this.index) {
      if (e.type === type) out.push(e as TypedLedgerEntry<T>);
    }
    return out;
  }

  tombstone(observationIds: string[], report: Omit<TombstoneReport, 'observationIds'>): void {
    this.append({
      type: 'om.tombstone',
      data: { observationIds, ...report },
      at: new Date().toISOString(),
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
