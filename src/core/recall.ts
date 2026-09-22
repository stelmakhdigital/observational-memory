/**
 * Recall (v0.5): deterministic, model-free search over session memory —
 * observations (active + consolidated), durable topic files, JOURNEY.md and
 * stored extractor values. BM25-lite scoring; no LLM, no embeddings, no DB.
 *
 * This is the "fetch the raw details" layer: the compaction block is injected
 * once, but the agent (or the user via /om:recall) can ask memory questions
 * mid-conversation. Temporal queries (since/until) filter observations by
 * their creation time (v0.7).
 */
import type {
  LedgerStore,
  MemoryRoot,
  Observation,
  ObservationPriority,
} from './types.js';

export type RecallKind = 'observation' | 'topic' | 'journey' | 'extracted' | 'shared-topic';

export interface RecallDoc {
  kind: RecallKind;
  /** Stable doc id: observation id / topic file name / 'journey' / 'extracted:<id>'. */
  id: string;
  /** Human-readable title (topic name, extractor id, 'observation <id>'). */
  title: string;
  /** Full searchable text. */
  text: string;
  /** ISO timestamp (observation createdAt; '' for files). */
  at: string;
  /** Observation-only extras. */
  status?: 'active' | 'consolidated';
  priority?: ObservationPriority;
  sourceRange?: { fromId: string; toId: string };
}

export interface RecallOptions {
  /** Max hits (default 10). */
  limit?: number;
  /** Temporal filter on observation createdAt: ISO date/dateTime, inclusive lower bound. */
  since?: string;
  /** Inclusive upper bound. */
  until?: string;
  /** Include consolidated (tombstoned) observations (default true). */
  includeConsolidated?: boolean;
}

export interface RecallHit {
  kind: RecallKind;
  id: string;
  title: string;
  /** First ~240 chars of the doc text. */
  snippet: string;
  score: number;
  at: string;
  status?: 'active' | 'consolidated';
  priority?: ObservationPriority;
  sourceRange?: { fromId: string; toId: string };
}

const STOPWORDS = new Set(
  (
    'the a an and or but of to in on at by for with from is are was were be been ' +
    'this that these those it its as if then than so not no yes i you he she we they ' +
    'me my your our their him her them what which who when where why how can could ' +
    'should would will do does did has have had there here about into over under ' +
    'the из на по для с и в не был была было были есть то что а о у к как это уже ' +
    'его её их ему ей им им я ты он она они мне тебе нам вам мой моя моё ваш ваша ' +
    'который которая которые чем кто где когда'
  )
    .split(/\s+/)
    .filter(Boolean),
);

/** Tokenize: lowercase, keep latin/cyrillic words ≥ 2 chars, drop stopwords. */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const m of text.toLowerCase().matchAll(/[a-zа-яё0-9_\-\.]{2,}/g)) {
    const t = m[0];
    if (!STOPWORDS.has(t)) out.push(t);
  }
  return out;
}

/**
 * BM25-lite: per-term idf × tf, document-length smoothing. Deterministic:
 * ties break by (at asc, id asc). k1=1.5, b=0.75 (classic BM25 constants).
 */
export function bm25(
  docs: readonly RecallDoc[],
  query: string,
  opts: { limit?: number } = {},
): Array<{ doc: RecallDoc; score: number }> {
  const qTerms = tokenize(query);
  if (qTerms.length === 0 || docs.length === 0) return [];
  const n = docs.length;
  const docTerms = docs.map((d) => tokenize(d.text));
  const docLens = docTerms.map((t) => t.length);
  const avgLen = docLens.reduce((a, b) => a + b, 0) / Math.max(1, n);
  // document frequency per query term
  const df = new Map<string, number>();
  for (const t of qTerms) {
    let c = 0;
    for (const dt of docTerms) if (dt.includes(t)) c++;
    df.set(t, c);
  }
  const scored: Array<{ doc: RecallDoc; score: number }> = [];
  docs.forEach((d, i) => {
    const dt = docTerms[i]!;
    const len = docLens[i]!;
    const tf = new Map<string, number>();
    for (const t of dt) tf.set(t, (tf.get(t) ?? 0) + 1);
    let score = 0;
    for (const t of qTerms) {
      const f = tf.get(t) ?? 0;
      if (f === 0) continue;
      const dft = df.get(t) ?? 0;
      const idf = Math.log(1 + (n - dft + 0.5) / (dft + 0.5));
      const k1 = 1.5;
      const b = 0.75;
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * len) / Math.max(avgLen, 1))));
    }
    if (score > 0) scored.push({ doc: d, score });
  });
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // Deterministic tie-break: dated (fresh) docs before undated file docs;
    // among dated — newest first (fresh memory wins); then id.
    if ((a.doc.at === '') !== (b.doc.at === '')) return a.doc.at === '' ? 1 : -1;
    if (a.doc.at !== b.doc.at) return b.doc.at.localeCompare(a.doc.at);
    return a.doc.id < b.doc.id ? -1 : a.doc.id > b.doc.id ? 1 : 0;
  });
  const limit = opts.limit ?? 10;
  return scored.slice(0, limit);
}

function snippetOf(text: string, max = 240): string {
  const flat = text.replace(/\s*\n[ \t]*(?:\n[ \t]*)*/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

/**
 * Score + shape docs into hits, applying temporal filters (observations only).
 * Deterministic for given docs/query/options.
 */
export function recallSearch(
  docs: readonly RecallDoc[],
  query: string,
  opts: RecallOptions = {},
): RecallHit[] {
  const includeConsolidated = opts.includeConsolidated ?? true;
  const since = opts.since ? new Date(opts.since).getTime() : null;
  const until = opts.until ? new Date(opts.until).getTime() : null;
  const filtered = docs.filter((d) => {
    if (d.kind === 'observation') {
      if (d.status === 'consolidated' && !includeConsolidated) return false;
      if (d.at) {
        const t = new Date(d.at).getTime();
        if (Number.isFinite(t)) {
          if (since !== null && t < since) return false;
          if (until !== null && t > until) return false;
        }
      }
    }
    return true;
  });
  return bm25(filtered, query, { limit: opts.limit ?? 10 }).map(({ doc, score }) => ({
    kind: doc.kind,
    id: doc.id,
    title: doc.title,
    snippet: snippetOf(doc.text),
    score: Math.round(score * 1000) / 1000,
    at: doc.at,
    status: doc.status,
    priority: doc.priority,
    sourceRange: doc.sourceRange,
  }));
}

/**
 * Render hits as a compact text block (tool/command output). Deterministic.
 * Returns '' when there are no hits (callers decide the fallback text).
 */
export function renderRecallHits(
  hits: readonly RecallHit[],
  opts: { sessionId?: string } = {},
): string {
  if (hits.length === 0) return '';
  const lines = hits.map((h, i) => {
    const bits: string[] = [`${i + 1}. [${h.kind}] ${h.title}`];
    if (h.priority && h.priority !== 'routine') bits.push(`(${h.priority})`);
    if (h.status === 'consolidated') bits.push('(consolidated)');
    if (h.at) bits.push(h.at.slice(0, 16).replace('T', ' '));
    if (h.sourceRange && opts.sessionId)
      bits.push(`source: session ${opts.sessionId} ${h.sourceRange.fromId} → ${h.sourceRange.toId}`);
    bits.push(`score=${h.score}`);
    return `${bits.join(' · ')}\n   ${h.snippet}`;
  });
  return lines.join('\n');
}

/** Build RecallDocs from active + consolidated observations. */
export function observationDocs(
  active: readonly Observation[],
  consolidated: readonly Observation[],
): RecallDoc[] {
  const mk = (o: Observation, status: 'active' | 'consolidated'): RecallDoc => ({
    kind: 'observation',
    id: o.id,
    title: `observation ${o.id}`,
    text: o.content,
    at: o.createdAt,
    status,
    priority: o.priority,
    sourceRange: o.sourceRange,
  });
  return [
    ...active.map((o) => mk(o, 'active')),
    ...consolidated.map((o) => mk(o, 'consolidated')),
  ];
}

/**
 * Build the full session recall corpus (observations active + consolidated,
 * session topics, shared topics, journey, extracted values). Shared between
 * the orchestrator and read-only consumers (MCP server, eval).
 */
export function buildSessionRecallDocs(
  ledger: LedgerStore,
  memory: MemoryRoot,
  sessionId: string,
): RecallDoc[] {
  const obs = ledger.read<'om.observation'>('om.observation').map((e) => e.data);
  const tombstones = (ledger.read('om.tombstone') as Array<{ data: { observationIds: string[] } }>).map((e) => e.data);
  const removed = new Set(tombstones.flatMap((t) => t.observationIds));
  return [
    ...observationDocs(
      obs.filter((o) => !removed.has(o.id)),
      obs.filter((o) => removed.has(o.id)),
    ),
    ...memory.listTopics(sessionId).map((t) => ({
      kind: 'topic' as const,
      id: t.file,
      title: t.topic,
      text: memory.readTopic(sessionId, t.file),
      at: '',
    })),
    ...memory.listSharedTopics().map((t) => ({
      kind: 'shared-topic' as const,
      id: `shared/${t.file}`,
      title: `${t.topic} (shared)`,
      text: memory.readSharedTopic(t.file),
      at: '',
    })),
    {
      kind: 'journey' as const,
      id: 'journey',
      title: 'Journey',
      text: memory.readJourney(sessionId),
      at: '',
    },
    ...memory.listExtracted(sessionId).map((id) => ({
      kind: 'extracted' as const,
      id: `extracted:${id}`,
      title: `extractor: ${id}`,
      text: JSON.stringify(memory.loadExtracted(sessionId, id) ?? null),
      at: '',
    })),
  ];
}
