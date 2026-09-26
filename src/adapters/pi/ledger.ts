/**
 * PiLedgerStore: the core LedgerStore seam backed by pi custom entries
 * (pi.appendEntry + sessionManager.getBranch).
 *
 * Properties that matter (verified in pi 0.86.1, spike S2):
 * - Custom entries are appended as children of the current leaf and advance
 *   the leaf → branch-local (they stay with their branch under /tree).
 * - Custom entries do NOT participate in the LLM context (display/state only).
 * - Entries survive resume; the caller feeds `read()` the CURRENT branch
 *   (getBranch, C1), so it is filtered to that branch by construction and
 *   further filtered by customType.
 */
import type {
  LedgerEntryType,
  LedgerPayload,
  LedgerStore,
  TombstoneReport,
  TypedLedgerEntry,
} from '../../core/types.js';
import type { PiEntry } from './types.js';

export const OM_CUSTOM_TYPE = 'om';

/** Loose payload shape check (NFR-1: corrupt payloads are skipped, never throw). */
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

export class PiLedgerStore implements LedgerStore {
  constructor(
    private readonly appendFn: (data: unknown) => void,
    private readonly entries: () => PiEntry[],
    private readonly now: () => Date = () => new Date(),
  ) {}

  append<T extends LedgerEntryType>(entry: TypedLedgerEntry<T>): void {
    this.appendFn({
      type: entry.type,
      data: entry.data,
      at: entry.at,
      meta: entry.meta,
    });
  }

  read<T extends LedgerEntryType>(type?: T): TypedLedgerEntry<T>[] {
    const out: TypedLedgerEntry<T>[] = [];
    for (const e of this.entries()) {
      if (e.type !== 'custom' || e.customType !== OM_CUSTOM_TYPE || typeof e.data !== 'object' || e.data === null)
        continue;
      const rec = e.data as { type?: string; data?: unknown; at?: string; meta?: { runId?: string } };
      if (typeof rec.type !== 'string') continue;
      const etype = rec.type as LedgerEntryType;
      if (type && etype !== type) continue;
      if (!payloadOk(etype, rec.data)) continue;
      out.push({
        type: etype as unknown as T,
        data: rec.data as LedgerPayload[T],
        at: typeof rec.at === 'string' ? rec.at : e.timestamp,
        meta: rec.meta,
      });
    }
    return out;
  }

  tombstone(observationIds: string[], report: Omit<TombstoneReport, 'observationIds'>): void {
    this.appendFn({
      type: 'om.tombstone',
      data: { observationIds, ...report },
      at: this.now().toISOString(),
    });
  }
}
