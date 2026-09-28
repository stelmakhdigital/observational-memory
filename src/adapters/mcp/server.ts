/**
 * MCP (Model Context Protocol) server for Observational Memory — the cheap
 * "other adapter" (v0.7): exposes session memory as read-only tools to ANY
 * MCP client (Claude Code, Codex, your own host).
 *
 * Run:   npm run build && OM_MCP_ROOT=<memory root> OM_MCP_SESSION=<sessionId> npm run mcp
 * Env:
 *   OM_MCP_ROOT              — memory root dir (the one from createOmSession / pi .memory)
 *   OM_MCP_SESSION           — session id (sanitized the same way as MemoryStore). In
 *                              pi-session mode it doubles as the session-id cross-check:
 *                              only a pi session file whose header id
 *                              (first line {"type":"session","id":...}) matches is used —
 *                              for both the explicit OM_MCP_PI_SESSION path and the
 *                              auto-scan — so the server never answers from ANOTHER
 *                              project's session (om_status shows `session: <id>`)
 *   OM_MCP_SHARED            — optional shared topics dir (default: <root>/shared)
 *   OM_MCP_PI_SESSION        — optional EXACT path to a pi session JSONL to read the
 *                              ledger from (pi stores om.* as custom entries in the
 *                              session file, not in <root>/<sessionId>/ledger.jsonl)
 *   OM_MCP_PI_SESSIONS_DIR   — optional sessions dir for auto-scan (default
 *                              ~/.pi/agent/sessions): the most recent .jsonl (≤50 newest
 *                              files by mtime) containing om.* entries AND (when
 *                              OM_MCP_SESSION is set) whose header session id matches
 *                              it, is used as the ledger source
 *
 * Ledger source (om_status/om_recall), first match wins:
 *   1. OM_MCP_PI_SESSION (if the file has valid om.* entries)
 *   2. auto-scanned pi session (OM_MCP_PI_SESSIONS_DIR)
 *   3. embedded <root>/<sessionId>/ledger.jsonl (FileLedgerStore)
 * Pi-session mode is READ-ONLY and covers one session file (a linear history —
 * pi branch semantics under /tree are NOT reconstructed: known limitation).
 * om_topics always reads the shared topic files in the memory root.
 *
 * Tools (all deterministic, no LLM):
 *   om_status — pool/tokens/topics/cost snapshot
 *   om_recall — BM25-lite search (query, limit, since, until)
 *   om_topics — durable topics + journey
 *
 * Transport: JSON-RPC 2.0 over stdio (line-delimited), MCP protocol basics
 * (initialize / tools/list / tools/call). See src/core/recall.ts for the
 * search implementation.
 */
import { createInterface } from 'node:readline';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildSessionRecallDocs, recallSearch, renderRecallHits } from '../../core/recall.js';
import { FileLedgerStore, defaultLedgerFile } from '../../core/ledger/file-store.js';
import { MemoryStore } from '../../core/memory-store.js';
import { foldPool } from '../../core/ledger/pool.js';
import { sumCosts } from '../../core/cost.js';
import { estimateTokens } from '../../core/tokens.js';
import type { LedgerEntryType, LedgerStore, TypedLedgerEntry } from '../../core/types.js';
import { readPiLedger, scanForPiSession } from './pi-ledger.js';

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_NAME = 'observational-memory-mcp';
const SERVER_VERSION = '0.4.0';

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

const TOOLS = [
  {
    name: 'om_status',
    description: 'Observational memory status for the configured session: active observations, tokens, topics, cost.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'om_recall',
    description:
      'Search the session’s observational memory (observations, durable topics, journey, extracted values). '
      + 'Deterministic BM25-lite, no LLM. Optional since/until (ISO dates) filter observations by time.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'number' },
        since: { type: 'string' },
        until: { type: 'string' },
      },
      required: ['query'],
    },
  },
  {
    name: 'om_topics',
    description: 'List durable memory topics (front-matter) and the session journey.',
    inputSchema: { type: 'object', properties: {} },
  },
];

function envRoot(): string {
  const root = process.env.OM_MCP_ROOT;
  if (!root) throw new Error('OM_MCP_ROOT env is required');
  return path.resolve(root);
}

function envSession(): string {
  const s = process.env.OM_MCP_SESSION;
  if (!s) throw new Error('OM_MCP_SESSION env is required');
  return s;
}

interface McpState {
  ledger: LedgerStore;
  /** Where om_status/om_recall read the ledger from (user-visible in om_status). */
  ledgerSource: 'embedded' | 'pi-session';
  ledgerFile: string;
  /** Header session id of the pi-session file (null for the embedded ledger). */
  ledgerSessionId: string | null;
  memory: MemoryStore;
  sessionId: string;
}

function initState(): McpState {
  const root = envRoot();
  const sessionId = envSession();
  const sharedDir = process.env.OM_MCP_SHARED
    ? path.resolve(process.env.OM_MCP_SHARED)
    : existsSync(path.join(root, 'shared'))
      ? path.join(root, 'shared')
      : null;
  // M5: the pi adapter keeps the ledger as custom 'om' entries inside the pi
  // session JSONL — prefer that (read-only) over the embedded ledger file.
  const candidates: string[] = [];
  const explicit = process.env.OM_MCP_PI_SESSION;
  if (explicit) {
    candidates.push(path.resolve(explicit));
  } else {
    const sessionsDir = process.env.OM_MCP_PI_SESSIONS_DIR
      ? path.resolve(process.env.OM_MCP_PI_SESSIONS_DIR)
      : path.join(os.homedir(), '.pi', 'agent', 'sessions');
    const scanned = scanForPiSession(sessionsDir, sessionId);
    if (scanned) candidates.push(scanned);
  }
  const embeddedFile = defaultLedgerFile(root, sessionId);
  let ledger: LedgerStore | null = null;
  let ledgerSource: 'embedded' | 'pi-session' = 'embedded';
  let ledgerFile = embeddedFile;
  let ledgerSessionId: string | null = null;
  for (const c of candidates) {
    // sessionId cross-check: a foreign project's session file is a mismatch, not a hit.
    const res = readPiLedger(c, sessionId);
    if (res) {
      ledger = res.store;
      ledgerSource = 'pi-session';
      ledgerFile = c;
      ledgerSessionId = res.sessionId;
      break;
    }
  }
  if (!ledger) {
    ledger = new FileLedgerStore({
      file: embeddedFile,
      lock: false, // read-only consumer: never block or write locks
      onAppendError: () => {},
    });
  }
  return {
    ledger,
    ledgerSource,
    ledgerFile,
    ledgerSessionId,
    memory: new MemoryStore(root, { sharedDir }),
    sessionId,
  };
}

// A7: lazy init + module state cache. initState() scans up to 50 pi-session
// files (5 MB tail each) and fully parses the chosen ledger — tens of ms per
// call. Cache the result; invalidate on: (a) initialize / notifications/initialized
// (new client session), (b) the ledger source file changed on disk (mtime/size —
// a live pi writes the session file, so fresh entries must show up; file
// deleted → re-init → fallback), (c) any relevant env var changed (env snapshot).
// The statSync freshness check is cheap enough to run on every tools/call.
const STATE_ENV_KEYS = [
  'OM_MCP_ROOT',
  'OM_MCP_SESSION',
  'OM_MCP_SHARED',
  'OM_MCP_PI_SESSION',
  'OM_MCP_PI_SESSIONS_DIR',
] as const;

function envSnapshot(): string {
  return STATE_ENV_KEYS.map((k) => process.env[k] ?? '\u0000').join('\u0001');
}

/** mtime/size fingerprint of the ledger source; null when the file is absent. */
function sourceFingerprint(file: string): { mtimeMs: number; size: number } | null {
  try {
    const st = statSync(file);
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return null;
  }
}

interface CachedState {
  state: McpState;
  env: string;
  sourceFile: string;
  fingerprint: { mtimeMs: number; size: number } | null;
}

let stateCache: CachedState | null = null;
let stateInits = 0;

/** A7 test hooks: reset the cache / count initState() runs. */
export function __mcpResetState(): void {
  stateCache = null;
  stateInits = 0;
}
export function __mcpStateInitCount(): number {
  return stateInits;
}

export function invalidateMcpState(): void {
  stateCache = null;
}

function getState(): McpState {
  if (stateCache) {
    if (envSnapshot() === stateCache.env) {
      const fp = sourceFingerprint(stateCache.sourceFile);
      const same =
        (fp === null && stateCache.fingerprint === null) ||
        (fp !== null &&
          stateCache.fingerprint !== null &&
          fp.mtimeMs === stateCache.fingerprint.mtimeMs &&
          fp.size === stateCache.fingerprint.size);
      if (same) return stateCache.state; // fresh
    }
    stateCache = null; // env or source changed (or source vanished) → re-init
  }
  stateInits++;
  const state = initState();
  stateCache = {
    state,
    env: envSnapshot(),
    sourceFile: state.ledgerFile,
    fingerprint: sourceFingerprint(state.ledgerFile),
  };
  return state;
}

function toolStatus(s: McpState): ToolResult {
  // A16: one ledger read, local filters — embedded stores re-read the whole
  // file per read(type) call, and 5 calls here was pure waste.
  const all = s.ledger.read();
  const of = <T extends LedgerEntryType>(type: T): TypedLedgerEntry<T>[] =>
    all.filter((e) => e.type === type) as TypedLedgerEntry<T>[];
  const obsAll = of('om.observation').map((e) => e.data);
  const tombstones = of('om.tombstone');
  const removed = new Set(tombstones.flatMap((t) => t.data.observationIds));
  const active = obsAll.filter((o) => !removed.has(o.id));
  const activeTokens = active.reduce((t, o) => t + o.tokenCount, 0);
  const costs = sumCosts(of('om.cost'));
  const lastErr = of('om.lastError');
  const topics = s.memory.listTopics(s.sessionId);
  const journey = s.memory.readJourney(s.sessionId);
  const text = [
    `session: ${s.sessionId}`,
    `source: ${s.ledgerSource} — ${s.ledgerFile}`,
    s.ledgerSessionId ? `session: ${s.ledgerSessionId}` : '',
    `active observations: ${active.length} (~${activeTokens} tokens)`,
    `consolidated observations: ${obsAll.length - active.length}`,
    `topics: ${topics.map((t) => t.topic).join(', ') || '(none)'}`,
    `extracted: ${s.memory.listExtracted(s.sessionId).join(', ') || '(none)'}`,
    `journey: ~${estimateTokens(journey)} tokens`,
    `session cost: $${costs.totalUsd.toFixed(3)} (${costs.runs} runs)`,
    lastErr.length > 0 ? `last error: ${lastErr[lastErr.length - 1]!.data.message}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  return { content: [{ type: 'text', text }] };
}

function toolRecall(s: McpState, args: Record<string, unknown>): ToolResult {
  const query = String(args.query ?? '');
  if (!query.trim()) return { content: [{ type: 'text', text: 'query is required' }], isError: true };
  const hits = recallSearch(buildSessionRecallDocs(s.ledger, s.memory, s.sessionId), query, {
    limit: typeof args.limit === 'number' ? args.limit : undefined,
    since: typeof args.since === 'string' ? args.since : undefined,
    until: typeof args.until === 'string' ? args.until : undefined,
  });
  return { content: [{ type: 'text', text: renderRecallHits(hits, { sessionId: s.sessionId }) || '(no matches in memory)' }] };
}

function toolTopics(s: McpState): ToolResult {
  const topics = s.memory
    .listTopics(s.sessionId)
    .map((t) => `- ${t.topic}${t.description ? `: ${t.description}` : ''} [${t.file}]`)
    .join('\n');
  const shared = s.memory
    .listSharedTopics()
    .map((t) => `- ${t.topic}${t.description ? `: ${t.description}` : ''} [shared/${t.file}]`)
    .join('\n');
  const journey = s.memory.readJourney(s.sessionId);
  return {
    content: [
      {
        type: 'text',
        text: [
          `Topics:\n${topics || '(none)'}`,
          shared ? `Shared topics:\n${shared}` : '',
          journey ? `Journey:\n${journey}` : '',
        ]
          .filter(Boolean)
          .join('\n\n'),
      },
    ],
  };
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

/**
 * Pure JSON-RPC dispatcher (exported for tests). Returns a response object,
 * or null for notifications (no reply expected).
 */
export function handleMcpRequest(req: JsonRpcRequest): unknown | null {
  // A11: JSON-RPC/MCP notifications expect NO reply (writing one confuses clients).
  if (req.method?.startsWith('notifications/')) {
    // A7: notifications/initialized marks a new client session → drop the cache.
    if (req.method === 'notifications/initialized') invalidateMcpState();
    return null;
  }
  const id = req.id ?? null;
  const fail = (code: number, message: string) => ({
    jsonrpc: '2.0',
    id,
    error: { code, message },
  });
  if (req.method === 'initialize') {
    invalidateMcpState(); // A7: new client session → fresh state
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: (req.params?.protocolVersion as string) ?? PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      },
    };
  }
  if (req.method === 'ping') return { jsonrpc: '2.0', id, result: {} };
  if (req.method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
  }
  if (req.method === 'tools/call') {
    const name = String(req.params?.name ?? '');
    const args = (req.params?.arguments ?? {}) as Record<string, unknown>;
    try {
      const s = getState();
      const result: ToolResult =
        name === 'om_status'
          ? toolStatus(s)
          : name === 'om_recall'
            ? toolRecall(s, args)
            : name === 'om_topics'
              ? toolTopics(s)
              : { content: [{ type: 'text', text: `unknown tool: ${name}` }], isError: true };
      return { jsonrpc: '2.0', id, result };
    } catch (e) {
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: String(e) }], isError: true } };
    }
  }
  return fail(-32601, `unknown method: ${String(req.method)}`);
}

/** stdio transport (line-delimited JSON-RPC). */
export function startMcpServer(): void {
  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let req: JsonRpcRequest;
    try {
      req = JSON.parse(line) as JsonRpcRequest;
    } catch {
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })}\n`);
      return;
    }
    const res = handleMcpRequest(req);
    if (res !== null) process.stdout.write(`${JSON.stringify(res)}\n`);
  });
  rl.on('close', () => process.exit(0));
}

const isMain =
  typeof process.argv[1] === 'string' &&
  process.argv[1].length > 0 &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) startMcpServer();
