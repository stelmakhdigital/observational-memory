/**
 * pi-coding-agent extension entry for Observational Memory.
 *
 * Usage: install as a pi package or point `extensions` at this file
 * (see README). Commands: /om [on|off], /om:status, /om:compact,
 * /om:consolidate. Default gate: OFF (FR-7.2).
 *
 * S4: the factory below is wiring only; the pieces live in sibling modules:
 *  - resume.ts     — auto-resume prompt / retryable-error regex / runEndedUnfinished
 *  - ui.ts         — guarded UI helpers (notify/status/diag)
 *  - boot.ts       — resolveWorkerModel + buildRuntime
 *  - sink.ts       — the orchestrator EventSink
 *  - commands.ts   — /om* command handlers
 *  - recall-tool.ts— the om_recall tool
 *
 * Wiring (spikes S1/S2):
 * - ledger: pi.appendEntry('om', …) — branch-local, survives resume, invisible
 *   to the LLM context;
 * - compaction: session_before_compact returns the deterministic OM block as
 *   the summary (model-free); firstKeptEntryId = tail boundary;
 * - gap markers: injected as hidden custom messages (context-visible anchors);
 * - workers: headless `pi -p --mode json` subprocesses (PiSubprocessRunner).
 */
import { buildRuntime, type Runtime } from './boot.js';
import { registerCommands } from './commands.js';
import { firstBranchEntryIdAfter } from './history.js';
import { registerRecallTool } from './recall-tool.js';
// Back-compat: exported from here since earlier versions.
import { runEndedUnfinished } from './resume.js';
export { runEndedUnfinished };
import { makeSink } from './sink.js';
import { createUi } from './ui.js';
import type {
  PiApi,
  PiCompactPreparation,
  PiContext,
} from './types.js';

export type { Runtime } from './boot.js';

export interface OmExtension {
  runtime(): Runtime | null;
}

export default function observationalMemory(pi: PiApi): OmExtension {
  let rt: Runtime | null = null;

  const debug = (m: string) => {
    if (rt?.config.om.debugLog) console.error(`[om] ${m}`);
  };
  const ui = createUi();
  const sink = makeSink({ pi, getRt: () => rt, debug, ui });

  const track = (ctx: PiContext): Runtime => {
    rt ??= buildRuntime({ pi, ctx, debug, ui, sink });
    rt.lastCtx = ctx;
    return rt;
  };

  // Id of the first entry AFTER the tail boundary (firstKeptEntryId).
  // C1: resolved within the current branch (getBranch), never across branches.
  const firstEntryIdAfter = (ctx: PiContext, boundary: string, fallback: string): string =>
    firstBranchEntryIdAfter(ctx.sessionManager, boundary, fallback);

  pi.on('session_start', (_e, ctx) => {
    track(ctx);
  });
  pi.on('turn_end', (_e, ctx) => {
    const r = track(ctx);
    r.orch.onTurnEnd();
  });
  pi.on('agent_end', async (e, ctx) => {
    const r = track(ctx);
    await r.orch.onAgentEnd({
      runUnfinished: runEndedUnfinished((e as { messages?: unknown })?.messages),
    });
  });
  pi.on('model_select', (_e, ctx) => {
    // Early activation (v2): the prompt cache is invalidated anyway.
    track(ctx).orch.onModelChange();
  });
  pi.on('session_before_compact', async (event, ctx) => {
    const r = track(ctx);
    if (!r.orch.isEnabled()) return; // default pi compaction when OM is off
    const prep: PiCompactPreparation = (event as { preparation?: PiCompactPreparation })?.preparation ?? {
      firstKeptEntryId: '',
      tokensBefore: 0,
    };
    // A5: the hook is async (pi awaits it) — quiescently wait for in-flight
    // observers so the rendered block is complete. The old synchronous
    // render ("best effort") raced pending commits and silently dropped
    // their observations from the summary.
    await r.orch.drainForCompaction();
    const { block, tailBoundaryId } = r.orch.compactionPlan();
    return {
      compaction: {
        summary: block.text,
        firstKeptEntryId: firstEntryIdAfter(ctx, tailBoundaryId, prep.firstKeptEntryId),
        tokensBefore: prep.tokensBefore,
      },
    };
  });
  pi.on('session_shutdown', async (_e, ctx) => {
    const r = rt;
    if (!r) return;
    await r.orch.shutdown();
    r.lastCtx && ui.setUiStatus(r.lastCtx, undefined);
    // A1: pi 0.87.1 sends session_shutdown (reason 'new' | 'resume' | 'fork')
    // when /new or /resume switches sessions WITHIN the same process. Drop
    // the old Runtime so the next session_start/track() boots a fresh
    // orchestrator/ledger/memory for the new session (worker models and cwd
    // are re-resolved there). Guarded: if a new Runtime was already booted
    // meanwhile we must not null it. Double-shutdown is a no-op (rt is null).
    if (rt === r) rt = null;
    r.lastCtx = null;
  });

  registerRecallTool(pi, track);
  registerCommands(pi, { track, ui });

  return {
    runtime: () => rt,
  };
}
