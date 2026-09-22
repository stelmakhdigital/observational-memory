/**
 * Embedded demo: Observational Memory core inside a fake host agent — no pi,
 * no LLM (a scripted ModelRunner plays the workers).
 *
 * Run: npm run demo
 * (builds to dist/ with tsc, then executes dist/examples/embedded-demo.js)
 */
import { mkdtempSync, rmSync, mkdirSync, appendFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createOmSession,
  estimateTokens,
  MessageChunker,
  resolveConfig,
  type HistorySource,
  type ModelRunner,
  type OmMessage,
  type Role,
  type WorkerInput,
  type WorkerResult,
} from '../src/core/index.js';

// ---------------------------------------------------------------------------
// 1) Host history: a tiny in-memory conversation implementing HistorySource.
// ---------------------------------------------------------------------------
class DemoHistory implements HistorySource {
  messages: OmMessage[] = [];
  private readonly chunker: MessageChunker;

  constructor() {
    this.chunker = new MessageChunker({ chunkTokens: 5 });
  }
  add(id: string, text: string): void {
    this.messages.push({ id, text, tokens: estimateTokens(text) });
  }
  nextChunk(since: { coversUpToId: string; observedTokens: number }) {
    return this.chunker.next(this.messages, since);
  }
  currentTokens(): number {
    return this.messages.reduce((s, m) => s + (m.tokens ?? 0), 0);
  }
  unobservedTokens(sinceId: string): number {
    const idx = this.messages.findIndex((m) => m.id === sinceId);
    const start = idx === -1 ? 0 : idx + 1;
    return this.messages.slice(start).reduce((s, m) => s + (m.tokens ?? 0), 0);
  }
  isIdle(): boolean {
    return true;
  }
  tailVerbatim(sinceId: string): string {
    const idx = this.messages.findIndex((m) => m.id === sinceId);
    return this.messages.slice(idx === -1 ? 0 : idx + 1).map((m) => m.text).join('\n');
  }
  tailStartIdFor(): string {
    return '';
  }
  lastMessageAt(): Date | null {
    return new Date();
  }
}

// ---------------------------------------------------------------------------
// 2) Scripted ModelRunner: plays the observer/consolidator workers.
//    The "consolidator" writes the topic file itself — exactly what a real
//    LLM worker would do with its file tools.
// ---------------------------------------------------------------------------
class ScriptedRunner implements ModelRunner {
  constructor(private readonly sessionDirOf: () => string) {}
  async run(role: Role, input: WorkerInput): Promise<WorkerResult> {
    await new Promise((r) => setTimeout(r, 5));
    if (role === 'observer') {
      const firstLine = input.chunk!.text.split('\n')[0] ?? '';
      return {
        runId: input.runId,
        ok: true,
        costUsd: 0.001,
        observations: [{ text: `Host discussed: ${firstLine.slice(0, 80)}`, priority: 'routine' as const }],
      };
    }
    if (role === 'consolidator') {
      const dir = input.pool!.sessionDir;
      const lines = input.pool!.observations.map((o) => `- ${o.content}`).join('\n');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        path.join(dir, 'demo-topic.md'),
        `---\ntopic: Demo topic\ndescription: Consolidated demo observations\nsession: demo\n---\n\n# Demo topic\n${lines}\n`,
        'utf8',
      );
      appendFileSync(
        path.join(dir, 'JOURNEY.md'),
        `## ${new Date().toISOString().slice(0, 10)} — Demo consolidation\nConsolidated ${input.pool!.observations.length} observations.\n`,
        'utf8',
      );
      return {
        runId: input.runId,
        ok: true,
        costUsd: 0.002,
        consolidation: {
          topics: ['demo-topic.md'],
          tombstoneIds: input.pool!.observations.map((o) => o.id),
          droppedIds: [],
          journeyChanged: true,
        },
      };
    }
    if (role === 'extractor') {
      return {
        runId: input.runId,
        ok: true,
        costUsd: 0.0005,
        extraction: { profile: { language: 'English', stack: 'Go', focus: 'rate limiting' } },
      };
    }
    return { runId: input.runId, ok: false, error: `unexpected role ${role}` };
  }
}

// ---------------------------------------------------------------------------
// 3) The demo itself.
// ---------------------------------------------------------------------------
async function demo(): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), 'om-demo-'));
  const history = new DemoHistory();
  const session = createOmSession({
    root,
    sessionId: 'demo-session',
    history,
    runner: new ScriptedRunner(() => sessionDir),
    config: resolveConfig({
      chunkTokens: 5,
      poolTargetTokens: 3,
      consolidateAtPoolTokens: 10,
    }),
    log: (m) => process.stderr.write(`[om] ${m}\n`),
  });
  const sessionDir = session.memory.sessionDir('demo-session');

  console.log('memory root:', root);
  console.log('gate (restored):', session.orchestrator.isEnabled());
  session.orchestrator.setEnabled(true);
  console.log('gate after enable:', session.orchestrator.isEnabled());

  history.add('u1', 'Let us build a rate limiter with a sliding window in Go.');
  history.add('a1', 'Done: token bucket plus window, tests are green.');
  session.orchestrator.onTurnEnd();
  await session.orchestrator.shutdown();
  const s1 = session.orchestrator.status();
  console.log(`after turn: ${s1.activeObservations} observation(s), cost $${s1.costUsd.toFixed(3)}`);

  session.orchestrator.forceConsolidate();
  await session.orchestrator.shutdown();
  const s2 = session.orchestrator.status();
  console.log(
    `after consolidation: ${s2.topicCount} topic(s), pool ${s2.poolTokens} tokens, cost $${s2.costUsd.toFixed(3)}`,
  );

  console.log('\n--- compaction block (first 600 chars) ---');
  console.log(session.orchestrator.compactBlock().text.slice(0, 600));
  rmSync(root, { recursive: true, force: true });
  console.log('\ndone. (temp memory dir cleaned)');
}

void demo();
