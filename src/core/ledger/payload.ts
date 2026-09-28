/**
 * Payload validation for ledger entries (S3: single validator for all
 * consumers — FileLedgerStore, PiLedgerStore, the MCP pi-session reader).
 *
 * FR-2.1 versioning: ledger entries are stored WITHOUT a version field
 * (`{type, data, at, meta}` — no envelope). Migrations are manual; an entry
 * of an unknown type or with a malformed payload is skipped, never thrown
 * (NFR-1).
 */
import type {
  LedgerEntryType,
  LedgerPayload,
  TypedLedgerEntry,
} from '../types.js';

const isStr = (v: unknown): v is string => typeof v === 'string';
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Strict shape check of a stored payload (the strictest of the former
 * per-consumer validators). Returns false for corrupt/foreign data —
 * callers skip such entries, they never throw.
 */
export function omPayloadOk(type: LedgerEntryType, data: unknown): data is LedgerPayload[LedgerEntryType] {
  if (!isObj(data)) return false;
  const d = data;
  switch (type) {
    case 'om.observation':
      return (
        isStr(d.id) &&
        isStr(d.coversUpToId) &&
        isStr(d.content) &&
        typeof d.tokenCount === 'number' &&
        isStr(d.createdAt)
      );
    case 'om.tombstone':
      if (!Array.isArray(d.observationIds)) return false;
      if (typeof d.journeyChanged !== 'boolean') return false;
      if (!Array.isArray(d.topics)) return false;
      // written by consolidations (FR-1.3 watermark survival)
      if (d.maxCoversUpToId !== undefined && !isStr(d.maxCoversUpToId)) return false;
      if (d.maxSeq !== undefined && typeof d.maxSeq !== 'number') return false;
      return true;
    case 'om.cost':
      return isStr(d.runId) && typeof d.usd === 'number';
    case 'om.gap-marker':
      return isStr(d.id) && typeof d.ms === 'number';
    case 'om.enabled':
      return typeof d.enabled === 'boolean';
    case 'om.run':
      return isStr(d.runId) && typeof d.status === 'string';
    case 'om.lastError':
      return isStr(d.message);
    default:
      return false;
  }
}

/** Parse a stored payload; null when corrupt or unknown (NFR-1). */
export function parseOmPayload<K extends LedgerEntryType>(
  type: K,
  data: unknown,
): LedgerPayload[K] | null {
  return omPayloadOk(type, data) ? (data as LedgerPayload[K]) : null;
}

const ENTRY_TYPES: ReadonlySet<string> = new Set<string>([
  'om.observation',
  'om.tombstone',
  'om.cost',
  'om.gap-marker',
  'om.enabled',
  'om.run',
  'om.lastError',
]);

/**
 * Parse + validate one raw ledger line (JSONL format: `{type, data, at, meta}`).
 * Returns null when the line is not a valid OM entry (corrupt line, unknown
 * type, malformed payload, missing `at`). `meta.runId` is kept only when it
 * is a string (it is informational; anything else is dropped, not fatal).
 */
export function parseOmLine(
  line: string,
): TypedLedgerEntry<LedgerEntryType> | null {
  let rec: unknown;
  try {
    rec = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isObj(rec)) return null;
  const { type, data, at, meta } = rec as { type?: unknown; data?: unknown; at?: unknown; meta?: unknown };
  if (typeof type !== 'string' || !ENTRY_TYPES.has(type)) return null;
  if (!isStr(at)) return null;
  if (!omPayloadOk(type as LedgerEntryType, data)) return null;
  return {
    type: type as LedgerEntryType,
    data: data as LedgerPayload[LedgerEntryType],
    at,
    meta: isObj(meta) && isStr(meta.runId) ? { runId: meta.runId } : undefined,
  };
}
