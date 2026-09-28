/**
 * Self-eval harness (v0.6): runs scripted sessions through the REAL pipeline
 * (real LLM workers via PiSubprocessRunner, real MemoryStore/FileLedgerStore)
 * and measures what a memory system actually delivers:
 *
 *  - fact survival: what fraction of `expectedFacts` is still findable in the
 *    memory corpus (observations + topics + journey + extracted values)
 *    after observe → consolidate → extract; a fact may carry alternative
 *    spellings (string[] — any-of), since the model writes in EN or RU;
 *  - poison test: `forbiddenFacts` must NEVER appear in the corpus (anti-
 *    poisoning / injection resistance);
 *  - compaction cases (`compact: true`): low thresholds force a compaction;
 *    the rendered OM block size is reported (`block Ntok`) and early-history
 *    facts must survive in memory, not in the raw context;
 *  - compression: raw history tokens vs memory corpus tokens;
 *  - cost: USD of all background LLM runs for the session;
 *  - wall-time: per-case and total wallMs (with a local $0 model the cost
 *    metric is useless, wall-time is the real performance signal);
 *  - recall: BM25 recallSearch() over the memory corpus (cross-lingual
 *    cases) — a second, non-substring measurement mechanism;
 *  - gap-markers: `gapMarkers: true` enables markers (1h threshold) and
 *    onAgentEnd per turn; the om.gap-marker ledger entry is the assertion;
 *  - tail-race (E1): `noPumpLastTurns: N` appends the last N turns WITHOUT
 *    onTurnEnd — the shutdown final pump must still observe them.
 *
 * Case design rules (learned the hard way):
 *  - a case's total must be >= chunkTokens (150) or NOTHING gets observed;
 *  - expectedFacts must lie in the OBSERVED region: the chunker never emits a
 *    trailing <chunkTokens remainder (in live sessions it stays in context;
 *    in eval the case just ends), so put facts out of the last ~150 tokens;
 *  - the model output language is not guaranteed — use alternative spellings.
 *
 * Run:  npm run eval
 * Env:  OM_PI_BIN            pi binary (default: pi)
 *       OM_EVAL_MODEL        model id for all workers (default: claude-sonnet-4-6)
 *       OM_EVAL_OBSERVER     observer model override
 *       OM_EVAL_CONSOLIDATOR consolidator/extractor/reflect model override
 *       OM_EVAL_VERBOSE=1    log worker activity
 *
 * The harness is deterministic in plumbing; the LLM makes fact survival a
 * probabilistic metric — run it after prompt changes to catch regressions.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildSessionRecallDocs,
  createOmSession,
  estimateTokens,
  recallSearch,
  sumCosts,
  type OmSession,
} from '../src/core/index.js';
import { DemoHistory } from '../src/core/testing.js';
import { PiSubprocessRunner } from '../src/adapters/pi/runner.js';

/** A turn: plain text, or an object with an explicit pause before it (gap-markers case). */
type EvalTurn = string | { text: string; /** Pause before this turn, ms (gap-markers case). */ gapBeforeMs?: number };

interface EvalCase {
  id: string;
  description?: string;
  turns: EvalTurn[];
  expectedFacts: Array<string | string[]>;
  /** Poison test: substrings that must NOT appear in the memory corpus. */
  forbiddenFacts?: Array<string | string[]>;
  /** Trigger compaction: low compactAtContextTokens for this case. */
  compact?: boolean;
  /** Gap-markers case: enable markers (1h threshold) + onAgentEnd per turn; expect >= 1 om.gap-marker. */
  gapMarkers?: boolean;
  /** E1 tail-race case: the last N turns are appended WITHOUT onTurnEnd before shutdown. */
  noPumpLastTurns?: number;
  /** Cross-lingual recall: recallSearch() queries over the memory corpus; ok if any alt gets >= 1 hit. */
  recallQueries?: Array<{ query: string; alts?: string[] }>;
}

interface CaseReport {
  id: string;
  description?: string;
  historyTokens: number;
  memoryTokens: number;
  compression: number | null;
  observations: number;
  topics: number;
  extracted: string[];
  costUsd: number;
  /** Wall-time of the whole case (turns + forced phases + drain), ms. */
  wallMs: number;
  /** Distinct committed observer chunks (sourceRange.toId). */
  chunkCount: number;
  /** History tokens covered by committed observations (up to the max watermark). */
  observedTokens: number;
  /** om.gap-marker ledger entries (gap-markers case: must be >= 1). */
  gapMarkersFound: number;
  /** recallSearch() results (cross-lingual case). */
  recall: Array<{ query: string; hits: number; ok: boolean }>;
  facts: Array<{ fact: string; found: boolean; where: string[] }>;
  forbidden: Array<{ fact: string; leaked: boolean; where: string[] }>;
  compactionBlockTokens: number | null;
  survival: number | null;
  errors: string[];
}

const CASES_DIR = (() => {
  // built: dist/eval/cases (if present); source-tree run: eval/cases from cwd
  const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cases');
  return existsSync(dist) ? dist : path.resolve(process.cwd(), 'eval', 'cases');
})();
const VERBOSE = process.env.OM_EVAL_VERBOSE === '1';
const log = (...a: unknown[]) => {
  if (VERBOSE) console.error('[eval]', ...a);
};

function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

async function runCase(evalCase: EvalCase, root: string): Promise<CaseReport> {
  const model = (p: string | undefined, fallback: string) => (p && p.length > 0 ? p : fallback);
  const base = process.env.OM_EVAL_MODEL ?? 'claude-sonnet-4-6';
  const observerModel = model(process.env.OM_EVAL_OBSERVER, base);
  const consolidatorModel = model(process.env.OM_EVAL_CONSOLIDATOR, base);

  const history = new DemoHistory({ chunkTokens: 150 });
  const runner = new PiSubprocessRunner({
    piBinary: process.env.OM_PI_BIN || 'pi',
    cwd: process.cwd(),
    observerModel: { id: observerModel },
    consolidatorModel: { id: consolidatorModel },
    extractorModel: { id: consolidatorModel },
    reflectModel: { id: consolidatorModel },
    sessionLabel: evalCase.id,
    journeyTargetTokens: 400,
    timeoutMs: 10 * 60_000,
    debug: (m) => log('worker:', m),
  });

  const t0 = Date.now();
  const session: OmSession = createOmSession({
    root,
    sessionId: evalCase.id,
    history,
    runner,
    config: {
      chunkTokens: 150,
      poolTargetTokens: 100,
      consolidateAtPoolTokens: 200,
      compactAtContextTokens: evalCase.compact ? 700 : 1_000_000,
      tailTokens: evalCase.compact ? 200 : 500,
      journeyTargetTokens: 400,
      observerConcurrency: 2,
      reflector: { enabled: false, idleMs: 60_000, minIntervalMs: 3_600_000 },
      // gap-markers case: enabled with a 1h threshold (others: off, as before)
      gapMarkers: { enabled: !!evalCase.gapMarkers, thresholdMs: 3_600_000 },
      earlyActivation: { enabled: false, idleMs: 60_000, minUnobservedTokens: 300 },
      models: { observer: { id: observerModel }, consolidator: { id: consolidatorModel } },
    },
    log: (m) => log('core:', m),
  });

  const errors: string[] = [];
  session.orchestrator.setEnabled(true);
  const noPump = evalCase.noPumpLastTurns ?? 0;
  // gap-markers case: explicit per-turn timestamps (all at base, except the
  // paused turn) so detectGap measures a REAL pause between messages.
  const baseAt = evalCase.gapMarkers ? Date.now() - 30 * 86_400_000 : null;
  let offsetMs = 0;
  for (let i = 0; i < evalCase.turns.length; i++) {
    const raw = evalCase.turns[i]!;
    const turn = typeof raw === 'string' ? { text: raw } : raw;
    offsetMs += turn.gapBeforeMs ?? 0;
    history.add(turn.text, baseAt !== null ? new Date(baseAt + offsetMs) : undefined);
    // E1 tail-race: the last N turns are appended WITHOUT onTurnEnd — the
    // shutdown final pump is the ONLY path that can observe them.
    if (i < evalCase.turns.length - noPump) {
      session.orchestrator.onTurnEnd();
    } else {
      log(`tail-race: no onTurnEnd after turn ${i + 1}`);
    }
    // gap-markers case: onAgentEnd per turn (detectGap measures the pause
    // between the last two messages at agent end).
    if (evalCase.gapMarkers) await session.orchestrator.onAgentEnd();
    // give workers a beat to commit before the next slice is eligible
    await new Promise((r) => setTimeout(r, 1500));
  }
  // force the durable phases to run regardless of thresholds
  session.orchestrator.forceConsolidate();
  await new Promise((r) => setTimeout(r, 1500));
  session.orchestrator.forceExtract();
  // quiescent drain: wait for all in-flight + follow-up workers
  await session.orchestrator.shutdown();

  // ---- metrics -------------------------------------------------------------
  const ledger = session.ledger;
  const allObs = ledger.read('om.observation').map((e) => e.data);
  const tombstoned = new Set(ledger.read('om.tombstone').flatMap((t) => t.data.observationIds));
  const historyTokens = history.currentTokens();
  const docs = buildSessionRecallDocs(ledger, session.memory, evalCase.id);
  const memoryTokens = docs.reduce((s, d) => s + estimateTokens(d.text), 0);
  const corpus = normalize(docs.map((d) => d.text).join('\n'));
  const topics = session.memory.listTopics(evalCase.id);

  // Diagnostics: distinct committed chunks + history tokens they cover.
  const toIds = [...new Set(allObs.map((o) => o.sourceRange?.toId).filter((x): x is string => !!x))];
  const maxToId = toIds.length > 0 ? toIds.reduce((a, b) => (a < b ? b : a)) : null;
  const observedTokens = maxToId
    ? history.messages.filter((m) => m.id <= maxToId).reduce((s, m) => s + (m.tokens ?? 0), 0)
    : 0;

  // Gap-markers case: the pause must be recorded as an om.gap-marker entry.
  const gapMarkersFound = ledger.read('om.gap-marker').length;

  // Cross-lingual recall: BM25 recallSearch() over the memory corpus (NOT a
  // substring over the raw history). ok if any alternative query gets a hit.
  const recall = (evalCase.recallQueries ?? []).map((rq) => {
    const alts = [rq.query, ...(rq.alts ?? [])];
    let best = 0;
    for (const a of alts) best = Math.max(best, recallSearch(docs, a, { limit: 5 }).length);
    return { query: rq.query, hits: best, ok: best > 0 };
  });

  const facts = evalCase.expectedFacts.map((factOrAlts) => {
    // a fact may carry alternative spellings (string[] — any-of), e.g. a
    // language recorded as "Russian" (EN output) or "русский" (RU output).
    const alts: string[] = Array.isArray(factOrAlts) ? factOrAlts : [factOrAlts];
    const label = Array.isArray(factOrAlts) ? factOrAlts[0]! : factOrAlts;
    const needles = alts.map(normalize);
    const where: string[] = [];
    for (const d of docs) {
      const text = normalize(d.text);
      if (needles.some((n) => text.includes(n))) where.push(d.kind);
    }
    return { fact: label, found: where.length > 0, where: [...new Set(where)] };
  });
  const found = facts.filter((f) => f.found).length;

  // Poison test: forbidden content must not reach the memory corpus.
  const forbidden = (evalCase.forbiddenFacts ?? []).map((factOrAlts) => {
    const alts: string[] = Array.isArray(factOrAlts) ? factOrAlts : [factOrAlts];
    const label = Array.isArray(factOrAlts) ? factOrAlts[0]! : factOrAlts;
    const needles = alts.map(normalize);
    const where: string[] = [];
    for (const d of docs) {
      const text = normalize(d.text);
      if (needles.some((n) => text.includes(n))) where.push(d.kind);
    }
    return { fact: label, leaked: where.length > 0, where: [...new Set(where)] };
  });

  // Compaction case: render the block the adapter would inject.
  let compactionBlockTokens: number | null = null;
  if (evalCase.compact) {
    const plan = session.orchestrator.compactionPlan();
    if (plan?.block) compactionBlockTokens = estimateTokens(plan.block.text);
  }

  return {
    id: evalCase.id,
    description: evalCase.description,
    historyTokens,
    memoryTokens,
    compression: memoryTokens > 0 ? Math.round((historyTokens / memoryTokens) * 100) / 100 : null,
    observations: allObs.length,
    topics: topics.length,
    extracted: session.memory.listExtracted(evalCase.id),
    costUsd: sumCosts(ledger.read('om.cost')).totalUsd,
    wallMs: Date.now() - t0,
    chunkCount: toIds.length,
    observedTokens,
    gapMarkersFound,
    recall,
    facts,
    forbidden,
    compactionBlockTokens,
    survival: facts.length > 0 ? Math.round((found / facts.length) * 100) / 100 : null,
    errors,
  };
}

async function main(): Promise<void> {
  const cases: EvalCase[] = readdirSync(CASES_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(path.join(CASES_DIR, f), 'utf8')) as EvalCase);
  if (cases.length === 0) {
    console.error('no eval cases found in', CASES_DIR);
    process.exit(1);
  }

  const tmp = mkdtempSync(path.join(tmpdir(), 'om-eval-'));
  console.log(`\nObservational Memory self-eval (${cases.length} cases, model: ${process.env.OM_EVAL_MODEL ?? 'claude-sonnet-4-6'})\n`);
  const reports: CaseReport[] = [];
  for (const c of cases) {
    process.stdout.write(`• ${c.id} … `);
    const r = await runCase(c, tmp);
    reports.push(r);
    process.stdout.write(
      `facts ${r.facts.filter((f) => f.found).length}/${r.facts.length}, ` +
      `obs ${r.observations}, topics ${r.topics}, ` +
      (r.recall.length > 0 ? `recall ${r.recall.filter((f) => f.ok).length}/${r.recall.length}, ` : '') +
      (c.gapMarkers ? `gaps ${r.gapMarkersFound > 0 ? '✓' : '✗'}, ` : '') +
      `${r.historyTokens}→${r.memoryTokens} tokens (×${r.compression}, obs ${r.observedTokens}/${r.chunkCount}ch), ` +
      (r.forbidden.length > 0
        ? `poison ${r.forbidden.filter((f) => !f.leaked).length}/${r.forbidden.length} blocked, `
        : '') +
      (r.compactionBlockTokens !== null ? `block ${r.compactionBlockTokens}tok, ` : '') +
      `wall ${(r.wallMs / 1000).toFixed(1)}s, $${r.costUsd.toFixed(3)}\n`,
    );
    for (const f of r.facts) {
      console.log(`    ${f.found ? '✓' : '✗'} ${f.fact}${f.found ? ` [${f.where.join(', ')}]` : ''}`);
    }
    for (const f of r.recall) {
      console.log(`    ${f.ok ? '✓' : '✗'} recall "${f.query}" → ${f.hits} hit(s)`);
    }
    for (const f of r.forbidden) {
      console.log(`    ${f.leaked ? '✗ LEAK' : '✓ blocked'} ${f.fact}${f.leaked ? ` [${f.where.join(', ')}]` : ''}`);
    }
  }

  const avgSurvival =
    reports.length > 0
      ? Math.round((reports.reduce((s, r) => s + (r.survival ?? 0), 0) / reports.length) * 100) / 100
      : null;
  const totalCost = reports.reduce((s, r) => s + r.costUsd, 0);
  const totalLeaks = reports.reduce((s, r) => s + r.forbidden.filter((f) => f.leaked).length, 0);
  const totalWallMs = reports.reduce((s, r) => s + r.wallMs, 0);
  const recallTotals = reports.flatMap((r) => r.recall);
  const gapFailures = reports.filter(
    (r, i) => cases[i]!.gapMarkers && r.gapMarkersFound < 1,
  ).length;
  const summary = {
    at: new Date().toISOString(),
    model: process.env.OM_EVAL_MODEL ?? 'claude-sonnet-4-6',
    avgFactSurvival: avgSurvival,
    poisonLeaks: totalLeaks,
    totalCostUsd: Math.round(totalCost * 10000) / 10000,
    totalWallMs,
    recallOk: recallTotals.filter((f) => f.ok).length,
    recallTotal: recallTotals.length,
    gapFailures,
    reports,
  };
  writeFileSync(path.join(CASES_DIR, '..', 'report.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');
  console.log(
    `\nAverage fact survival: ${avgSurvival} · poison leaks: ${totalLeaks} · ` +
    `recall ${recallTotals.filter((f) => f.ok).length}/${recallTotals.length} · ` +
    `gap failures: ${gapFailures} · ` +
    `total cost: $${totalCost.toFixed(3)} · wall: ${(totalWallMs / 1000).toFixed(1)}s · report: eval/report.json\n`,
  );
  rmSync(tmp, { recursive: true, force: true });
}

main().catch((e) => {
  console.error('eval failed:', e);
  process.exit(1);
});
