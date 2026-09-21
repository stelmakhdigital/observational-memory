/**
 * PiSubprocessRunner: the ModelRunner seam backed by headless pi subprocesses.
 *
 * Each worker is an ordinary `pi -p --mode json` run (auditable, uses the
 * user's configured providers/auth). The prompt is rendered by the core
 * (renderObserverPrompt / renderConsolidatorPrompt); the JSONL event stream
 * provides the final assistant text and cumulative usage (cost.total).
 *
 * NOTE (v1.1): worker subprocesses run with `--no-builtin-tools` + the worker
 * extension (worker.ts): observer — no tools; consolidator/extractor — scoped
 * file tools limited to the session memory dir (extractor is read-only in
 * practice: it returns JSON, files are written by the core).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseConsolidationReport, parseExtractorOutput, parseObserverOutput } from '../../core/worker-output.js';
import { renderObserverPrompt } from '../../core/prompts/observer.js';
import { renderConsolidatorPrompt } from '../../core/prompts/consolidator.js';
import { renderExtractorPrompt } from '../../core/prompts/extractor.js';
import type {
  ModelRunner,
  Role,
  WorkerInput,
  WorkerResult,
} from '../../core/types.js';
import type { ModelRef } from '../../core/config.js';
import type { PiUsage } from './types.js';

export interface PiSubprocessRunnerOptions {
  piBinary: string;
  cwd: string;
  observerModel: ModelRef;
  consolidatorModel: ModelRef;
  /** Defaults to consolidatorModel when absent. */
  extractorModel?: ModelRef;
  sessionLabel?: string;
  journeyTargetTokens?: number;
  timeoutMs?: number;
  debug?: (msg: string) => void;
}

function modelFlag(ref: ModelRef): string {
  const base = ref.provider ? `${ref.provider}/${ref.id}` : ref.id;
  return ref.thinking && ref.thinking !== 'off' ? `${base}:${ref.thinking}` : base;
}

interface JsonlOutcome {
  text: string;
  costUsd: number;
  error?: string;
}

/** Parse a pi JSONL event stream into (final assistant text, cost total). */
export function parsePiJsonl(stdout: string): JsonlOutcome {
  let text = '';
  let costUsd = 0;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let ev: { type?: string; message?: { role?: string; content?: unknown; usage?: PiUsage }; usage?: PiUsage };
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    const usage: PiUsage | undefined = ev.usage ?? ev.message?.usage;
    if (usage?.cost?.total !== undefined) costUsd = Math.max(costUsd, usage.cost.total);
    if (ev.type === 'message_end' && ev.message?.role === 'assistant') {
      text = contentText(ev.message.content);
    }
  }
  return { text, costUsd };
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (p && typeof p === 'object' && (p as { type?: string; text?: string }).type === 'text' ? (p as { text?: string }).text ?? '' : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

export class PiSubprocessRunner implements ModelRunner {
  private readonly active = new Map<string, ChildProcess>();
  /** Worker extension path (loaded by pi via -e in the worker subprocess). */
  private readonly workerExt: string;

  constructor(private readonly o: PiSubprocessRunnerOptions) {
    this.workerExt = fileURLToPath(new URL('./worker.ts', import.meta.url));
  }

  async run(role: Role, input: WorkerInput): Promise<WorkerResult> {
    const debug = this.o.debug ?? (() => {});
    const prompt =
      role === 'observer'
        ? renderObserverPrompt(input, { sessionLabel: this.o.sessionLabel })
        : role === 'extractor'
          ? renderExtractorPrompt(input, { sessionLabel: this.o.sessionLabel })
          : renderConsolidatorPrompt(input, {
              session: (this.o.sessionLabel ?? '').slice(-32) || 'session',
              journeyTargetTokens: this.o.journeyTargetTokens ?? 1000,
            });
    const model =
      role === 'observer' ? this.o.observerModel : (this.o.extractorModel ?? this.o.consolidatorModel);
    const workerDir = role === 'consolidator' ? (input.pool?.sessionDir ?? this.o.cwd) : this.o.cwd;
    const args = [
      '-p',
      '--mode', 'json',
      '--model', modelFlag(model),
      '--no-extensions',
      '--no-builtin-tools',
      '-e', this.workerExt,
      '--', prompt,
    ];
    const env = {
      ...process.env,
      OM_WORKER: role,
      OM_WORKER_DIR: workerDir,
    };

    return new Promise<WorkerResult>((resolve) => {
      let settled = false;
      const finish = (r: WorkerResult) => {
        if (settled) return;
        settled = true;
        this.active.delete(input.runId);
        resolve(r);
      };

      let proc: ChildProcess;
      try {
        proc = spawn(this.o.piBinary, args, { cwd: this.o.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) {
        finish({ runId: input.runId, ok: false, error: `spawn failed: ${String(e)}` });
        return;
      }
      this.active.set(input.runId, proc);
      debug(`worker ${input.runId} (${role}) started: ${this.o.piBinary} ${args.slice(0, 5).join(' ')}`);

      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        // Resolve immediately: a hung child may hold stdio open (e.g. a grandchild
        // like `sleep`), so we must not wait for 'close'.
        try {
          proc.kill('SIGKILL');
        } catch {
          /* already gone */
        }
        finish({ runId: input.runId, ok: false, error: `worker timed out after ${this.o.timeoutMs}ms` });
      }, this.o.timeoutMs ?? 10 * 60 * 1000);

      proc.stdout?.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
      proc.stderr?.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
      proc.on('error', (e) => {
        clearTimeout(timer);
        finish({ runId: input.runId, ok: false, error: `process error: ${e.message}` });
      });
      proc.on('close', (code) => {
        clearTimeout(timer);
        const { text, costUsd } = parsePiJsonl(stdout);
        const body = text.trim() || stdout.trim();
        if (code !== 0 && !body) {
          finish({
            runId: input.runId,
            ok: false,
            costUsd: costUsd > 0 ? costUsd : undefined,
            error: `exit ${code}: ${stderr.slice(-400) || 'no output'}`,
          });
          return;
        }
        if (role === 'observer') {
          const p = parseObserverOutput(body);
          if (!p.ok) {
            finish({ runId: input.runId, ok: false, costUsd: costUsd > 0 ? costUsd : undefined, error: p.error });
            return;
          }
          finish({ runId: input.runId, ok: true, observations: p.observations, costUsd: costUsd > 0 ? costUsd : undefined });
          return;
        }
        if (role === 'extractor') {
          const x = parseExtractorOutput(body);
          if (!x.ok) {
            finish({ runId: input.runId, ok: false, costUsd: costUsd > 0 ? costUsd : undefined, error: x.error });
            return;
          }
          finish({ runId: input.runId, ok: true, extraction: x.values, costUsd: costUsd > 0 ? costUsd : undefined });
          return;
        }
        const r = parseConsolidationReport(body);
        if (!r.ok) {
          finish({ runId: input.runId, ok: false, costUsd: costUsd > 0 ? costUsd : undefined, error: r.error });
          return;
        }
        finish({
          runId: input.runId,
          ok: true,
          costUsd: costUsd > 0 ? costUsd : undefined,
          consolidation: {
            topics: r.topics,
            tombstoneIds: r.consumedIds,
            droppedIds: r.droppedIds,
            journeyChanged: r.journeyChanged,
          },
        });
      });
    });
  }

  async drain(): Promise<void> {
    const waiters = [...this.active.values()];
    await Promise.all(
      waiters.map(
        (p) =>
          new Promise<void>((r) => {
            if (p.exitCode !== null || p.killed) return r();
            p.once('close', () => r());
            p.once('error', () => r());
          }),
      ),
    );
  }
}
