/**
 * Serialize: versioned ledger payload envelopes (FR-2.1, NFR-1).
 *
 * Ledger entries survive resume and may outlive the code that wrote them, so
 * payloads are versioned (forward-only migrations). Corrupt payloads are
 * skipped with a warning — an append-only ledger is never rewritten in place.
 */
import type {
  CostEntry,
  EnabledEntry,
  GapMarker,
  LastErrorEntry,
  Observation,
  RunEntry,
  TombstoneReport,
} from '../types.js';

export const PAYLOAD_VERSION = 1;

export type LedgerPayloadMap = {
  'om.observation': Observation;
  'om.tombstone': TombstoneReport;
  'om.cost': CostEntry;
  'om.gap-marker': GapMarker;
  'om.enabled': EnabledEntry;
  'om.run': RunEntry;
  'om.lastError': LastErrorEntry;
};

export type PayloadType = keyof LedgerPayloadMap;

export interface Envelope<T> {
  v: number;
  data: T;
}

const isStr = (v: unknown): v is string => typeof v === 'string';
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Wrap a payload for storage. */
export function serialize<K extends PayloadType>(type: K, data: LedgerPayloadMap[K]): string {
  const env: Envelope<LedgerPayloadMap[K]> = { v: PAYLOAD_VERSION, data };
  return JSON.stringify(env);
}

/**
 * Parse + validate a stored payload. Returns null (not throws) when the
 * payload is corrupt, unknown, or from an unsupported version (NFR-1).
 */
export function parse<K extends PayloadType>(
  type: K,
  raw: string,
  warn?: (msg: string) => void,
): LedgerPayloadMap[K] | null {
  let env: unknown;
  try {
    env = JSON.parse(raw);
  } catch {
    warn?.(`[${type}] unparseable payload, skipping`);
    return null;
  }
  if (!isObj(env) || typeof env.v !== 'number' || !isObj(env.data)) {
    warn?.(`[${type}] malformed envelope, skipping`);
    return null;
  }
  if (env.v !== PAYLOAD_VERSION) {
    warn?.(`[${type}] unsupported payload version ${String(env.v)}, skipping`);
    return null;
  }
  const d = env.data;
  switch (type) {
    case 'om.observation':
      if (!isStr(d.id) || !isStr(d.coversUpToId) || !isStr(d.content) || typeof d.tokenCount !== 'number' || !isStr(d.createdAt))
        return null;
      break;
    case 'om.tombstone':
      if (!Array.isArray(d.observationIds) || typeof d.journeyChanged !== 'boolean' || !Array.isArray(d.topics))
        return null;
      break;
    case 'om.cost':
      if (!isStr(d.runId) || typeof d.usd !== 'number') return null;
      break;
    case 'om.gap-marker':
      if (!isStr(d.id) || typeof d.ms !== 'number') return null;
      break;
    case 'om.enabled':
      if (typeof d.enabled !== 'boolean') return null;
      break;
    case 'om.run':
      if (!isStr(d.runId) || typeof d.status !== 'string') return null;
      break;
    case 'om.lastError':
      if (!isStr(d.message)) return null;
      break;
  }
  return d as unknown as LedgerPayloadMap[K];
}
