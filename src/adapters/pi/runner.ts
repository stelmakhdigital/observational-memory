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
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseConsolidationReport, parseExtractorOutput, parseObserverOutput, parseReflectionReport } from '../../core/worker-output.js';
import { renderObserverPrompt } from '../../core/prompts/observer.js';
import { renderConsolidatorPrompt } from '../../core/prompts/consolidator.js';
import { renderExtractorPrompt } from '../../core/prompts/extractor.js';
import { renderReflectPrompt } from '../../core/prompts/reflector.js';
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
  /** Defaults to consolidatorModel when absent (v0.6). */
  reflectModel?: ModelRef;
  sessionLabel?: string;
  journeyTargetTokens?: number;
  /** v0.4: priority-tag instructions in the observer prompt. */
  priorityEnabled?: boolean;
  timeoutMs?: number;
  debug?: (msg: string) => void;
}

function modelFlag(ref: ModelRef): string {
  const base = ref.provider ? `${ref.provider}/${ref.id}` : ref.id;
  return ref.thinking && ref.thinking !== 'off' ? `${base}:${ref.thinking}` : base;
}

interface JsonlOutcome {
  /** n10: ALL non-empty assistant texts from message_end events, in order. */
  texts: string[];
  /** The last non-empty assistant text ('' when none). */
  text: string;
  costUsd: number;
  error?: string;
}

/** Parse a pi JSONL event stream into (assistant texts, cost total). */
export function parsePiJsonl(stdout: string): JsonlOutcome {
  const texts: string[] = [];
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
      const t = contentText(ev.message.content);
      // n10: keep EVERY non-empty assistant turn (multi-turn workers with tool
      // calls emit several message_end events; the final report is NOT always
      // the last one).
      if (t.trim()) texts.push(t);
    }
  }
  return { texts, text: texts[texts.length - 1] ?? '', costUsd };
}

/**
 * n10: pick the report body from the assistant turns — the NEWEST turn that
 * parses as the role's output (the parsers are strict→lenient inside). ''
 * when nothing parses (caller falls back to the last non-empty text).
 */
export function pickReportBody(texts: string[], role: Role): string {
  for (let i = texts.length - 1; i >= 0; i--) {
    const t = texts[i]!;
    const parsed =
      role === 'observer' ? parseObserverOutput(t)
      : role === 'extractor' ? parseExtractorOutput(t)
      : role === 'reflect' ? parseReflectionReport(t)
      : parseConsolidationReport(t);
    if (parsed.ok) return t;
  }
  return '';
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
    // Worker extension: source tree runs (pi/jiti) load worker.ts; built
    // dist/ runs (eval, npm scripts) load worker.js. Prefer whichever exists.
    const ts = fileURLToPath(new URL('./worker.ts', import.meta.url));
    const js = fileURLToPath(new URL('./worker.js', import.meta.url));
    this.workerExt = existsSync(ts) ? ts : js;
  }

  async run(role: Role, input: WorkerInput): Promise<WorkerResult> {
    const debug = this.o.debug ?? (() => {});
    const prompt =
      role === 'observer'
        ? renderObserverPrompt(input, {
            sessionLabel: this.o.sessionLabel,
            priorityEnabled: this.o.priorityEnabled ?? true,
          })
        : role === 'extractor'
          ? renderExtractorPrompt(input, { sessionLabel: this.o.sessionLabel })
          : role === 'reflect'
            ? renderReflectPrompt(input, {
                session: (this.o.sessionLabel ?? '').slice(-32) || 'session',
                journeyTargetTokens: this.o.journeyTargetTokens ?? 1000,
              })
            : renderConsolidatorPrompt(input, {
                session: (this.o.sessionLabel ?? '').slice(-32) || 'session',
                journeyTargetTokens: this.o.journeyTargetTokens ?? 1000,
              });
    const model =
      role === 'observer' ? this.o.observerModel : role === 'reflect' ? (this.o.reflectModel ?? this.o.consolidatorModel) : (this.o.extractorModel ?? this.o.consolidatorModel);
    const workerDir = role === 'consolidator' ? (input.pool?.sessionDir ?? this.o.cwd)
      : role === 'reflect' ? (input.reflect?.sessionDir ?? this.o.cwd)
      : this.o.cwd;
    const args = [
      '-p',
      '--mode', 'json',
      '--model', modelFlag(model),
      '--no-extensions',
      '--no-builtin-tools',
      // Ephemeral run: do NOT persist the worker's own session to
      // ~/.pi/agent/sessions/<project>/ (every worker would leave a JSONL).
      '--no-session',
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
        // detached:true on POSIX → child becomes the leader of a NEW process
        // group, so we can SIGKILL the whole tree (grandchildren that hold the
        // stdio pipes open would otherwise prevent 'close'). stdio pipes are
        // unaffected.
        proc = spawn(this.o.piBinary, args, {
          cwd: this.o.cwd,
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: process.platform !== 'win32',
        });
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
        this.killTree(proc);
        // Stop accumulating stdout/stderr: a grandchild may keep the pipes open
        // and streaming data into `stdout`/`stderr` forever.
        proc.stdout?.removeAllListeners('data');
        proc.stderr?.removeAllListeners('data');
        finish({ runId: input.runId, ok: false, error: `worker timed out after ${this.o.timeoutMs}ms` });
      }, this.o.timeoutMs ?? 10 * 60 * 1000);
      // Safe to unref: while the child is alive the loop cannot exit anyway;
      // if the child dies first, the timer is cleared in 'close'. Unref avoids
      // the timer alone pinning the pi process for the full timeout.
      timer.unref();

      proc.stdout?.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
      proc.stderr?.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
      proc.on('error', (e) => {
        clearTimeout(timer);
        finish({ runId: input.runId, ok: false, error: `process error: ${e.message}` });
      });
      proc.on('close', (code) => {
        clearTimeout(timer);
        // Reap any grandchildren left in the worker's process group (they can
        // outlive the direct child and hold the stdio pipes open).
        this.killTree(proc);
        const { texts, text, costUsd } = parsePiJsonl(stdout);
        // n10: a multi-turn worker (consolidator with tool calls) may end with
        // a message_end that is NOT the report — take the newest turn that
        // parses as the role's output; fallback: last non-empty text.
        const body = pickReportBody(texts, role) || text.trim() || stdout.trim();
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
        if (role === 'reflect') {
          const rf = parseReflectionReport(body);
          if (!rf.ok) {
            finish({ runId: input.runId, ok: false, costUsd: costUsd > 0 ? costUsd : undefined, error: rf.error });
            return;
          }
          finish({
            runId: input.runId,
            ok: true,
            costUsd: costUsd > 0 ? costUsd : undefined,
            reflection: { topics: rf.topics, journeyChanged: rf.journeyChanged },
          });
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
    const debug = this.o.debug ?? (() => {});
    const waiters = [...this.active.values()];
    await Promise.all(
      waiters.map(
        (p) =>
          new Promise<void>((r) => {
            // M1 race fix: listeners are registered FIRST, before any state
            // check — a child can exit between the check and `once('close')`
            // and the close event would be lost (→ promise never resolves).
            let resolved = false;
            let watchdog: NodeJS.Timeout | undefined;
            const done = () => {
              if (resolved) return;
              resolved = true;
              if (watchdog) clearTimeout(watchdog);
              r();
            };
            p.once('close', done);
            p.once('error', done);
            // Already dead before we entered drain — resolve immediately
            // (the close listener above is harmless: `done` is idempotent).
            if (p.exitCode !== null || p.killed) done();
            // Watchdog: no path to an infinite hang. If 'close' never comes
            // (lost event, unkillable grandchild, …) force-resolve.
            watchdog = setTimeout(
              () => {
                debug(
                  `[om] drain: watchdog fired for pid=${p.pid ?? '?'} (exitCode=${p.exitCode}, killed=${p.killed}) — forcing resolve`,
                );
                done();
              },
              Math.min(this.o.timeoutMs ?? 10 * 60 * 1000, 60 * 1000),
            );
          }),
      ),
    );
  }

  /**
   * Kill the worker's entire process group (POSIX: child was spawned with
   * detached:true → it is the group leader). Grandchildren that outlive the
   * direct child can hold the stdio pipes open and block 'close'.
   */
  private killTree(p: ChildProcess): void {
    const pid = p.pid;
    if (pid == null) return;
    if (process.platform !== 'win32') {
      try {
        process.kill(-pid, 'SIGKILL');
        return;
      } catch {
        /* no such group — fall back to the direct child */
      }
    }
    try {
      p.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
}
