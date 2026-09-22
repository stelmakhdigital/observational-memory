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
 *  - cost: USD of all background LLM runs for the session.
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
  DemoHistory,
  estimateTokens,
  sumCosts,
  type OmSession,
} from '../src/core/index.js';
import { PiSubprocessRunner } from '../src/adapters/pi/runner.js';

interface EvalCase {
  id: string;
  description?: string;
  turns: string[];
  expectedFacts: Array<string | string[]>;
  /** Poison test: substrings that must NOT appear in the memory corpus. */
  forbiddenFacts?: Array<string | string[]>;
  /** Trigger compaction: low compactAtContextTokens for this case. */
  compact?: boolean;
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
      gapMarkers: { enabled: false, thresholdMs: 600_000 },
      earlyActivation: { enabled: false, idleMs: 60_000, minUnobservedTokens: 300 },
      models: { observer: { id: observerModel }, consolidator: { id: consolidatorModel } },
    },
    log: (m) => log('core:', m),
  });

  const errors: string[] = [];
  session.orchestrator.setEnabled(true);
  for (let i = 0; i < evalCase.turns.length; i++) {
    history.add(evalCase.turns[i]!);
    session.orchestrator.onTurnEnd();
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
      `${r.historyTokens}→${r.memoryTokens} tokens (×${r.compression}), ` +
      (r.forbidden.length > 0
        ? `poison ${r.forbidden.filter((f) => !f.leaked).length}/${r.forbidden.length} blocked, `
        : '') +
      (r.compactionBlockTokens !== null ? `block ${r.compactionBlockTokens}tok, ` : '') +
      `$${r.costUsd.toFixed(3)}\n`,
    );
    for (const f of r.facts) {
      console.log(`    ${f.found ? '✓' : '✗'} ${f.fact}${f.found ? ` [${f.where.join(', ')}]` : ''}`);
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
  const summary = {
    at: new Date().toISOString(),
    model: process.env.OM_EVAL_MODEL ?? 'claude-sonnet-4-6',
    avgFactSurvival: avgSurvival,
    poisonLeaks: totalLeaks,
    totalCostUsd: Math.round(totalCost * 10000) / 10000,
    reports,
  };
  writeFileSync(path.join(CASES_DIR, '..', 'report.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');
  console.log(
    `\nAverage fact survival: ${avgSurvival} · poison leaks: ${totalLeaks} · ` +
    `total cost: $${totalCost.toFixed(3)} · report: eval/report.json\n`,
  );
  rmSync(tmp, { recursive: true, force: true });
}

main().catch((e) => {
  console.error('eval failed:', e);
  process.exit(1);
});
