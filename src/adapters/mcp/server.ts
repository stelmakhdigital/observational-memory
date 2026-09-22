/**
 * MCP (Model Context Protocol) server for Observational Memory — the cheap
 * "other adapter" (v0.7): exposes session memory as read-only tools to ANY
 * MCP client (Claude Code, Codex, your own host).
 *
 * Run:   npm run build && OM_MCP_ROOT=<memory root> OM_MCP_SESSION=<sessionId> npm run mcp
 * Env:
 *   OM_MCP_ROOT     — memory root dir (the one from createOmSession / pi .memory)
 *   OM_MCP_SESSION  — session id (sanitized the same way as MemoryStore)
 *   OM_MCP_SHARED   — optional shared topics dir (default: <root>/shared)
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
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildSessionRecallDocs, recallSearch, renderRecallHits } from '../../core/recall.js';
import { FileLedgerStore, defaultLedgerFile } from '../../core/ledger/file-store.js';
import { MemoryStore } from '../../core/memory-store.js';
import { foldPool } from '../../core/ledger/pool.js';
import { sumCosts } from '../../core/cost.js';
import { estimateTokens } from '../../core/tokens.js';

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
  ledger: FileLedgerStore;
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
  return {
    ledger: new FileLedgerStore({
      file: defaultLedgerFile(root, sessionId),
      lock: false, // read-only consumer: never block or write locks
      onAppendError: () => {},
    }),
    memory: new MemoryStore(root, { sharedDir }),
    sessionId,
  };
}

function toolStatus(s: McpState): ToolResult {
  const obsAll = s.ledger.read('om.observation').map((e) => e.data);
  const tombstones = s.ledger.read('om.tombstone');
  const removed = new Set(tombstones.flatMap((t) => t.data.observationIds));
  const active = obsAll.filter((o) => !removed.has(o.id));
  const activeTokens = active.reduce((t, o) => t + o.tokenCount, 0);
  const costs = sumCosts(s.ledger.read('om.cost'));
  const lastErr = s.ledger.read('om.lastError');
  const topics = s.memory.listTopics(s.sessionId);
  const journey = s.memory.readJourney(s.sessionId);
  const text = [
    `session: ${s.sessionId}`,
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
  const id = req.id ?? null;
  const fail = (code: number, message: string) => ({
    jsonrpc: '2.0',
    id,
    error: { code, message },
  });
  if (req.method === 'initialize') {
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
  if (req.method === 'notifications/initialized' || req.method === 'initialized') return null;
  if (req.method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
  }
  if (req.method === 'tools/call') {
    const name = String(req.params?.name ?? '');
    const args = (req.params?.arguments ?? {}) as Record<string, unknown>;
    try {
      const s = initState();
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
