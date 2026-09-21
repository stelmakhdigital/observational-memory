/**
 * pi-coding-agent extension entry for Observational Memory.
 *
 * Usage: install as a pi package or point `extensions` at this file
 * (see README). Commands: /om [on|off], /om:status, /om:compact,
 * /om:consolidate. Default gate: OFF (FR-7.2).
 *
 * Wiring (spikes S1/S2):
 * - ledger: pi.appendEntry('om', …) — branch-local, survives resume, invisible
 *   to the LLM context;
 * - compaction: session_before_compact returns the deterministic OM block as
 *   the summary (model-free); firstKeptEntryId = tail boundary;
 * - gap markers: injected as hidden custom messages (context-visible anchors);
 * - workers: headless `pi -p --mode json` subprocesses (PiSubprocessRunner).
 */
import path from 'node:path';
import {
  MemoryStore,
  OmOrchestrator,
  type CompactionBlock,
  type EventSink,
  type OmStatus,
  type RunInfo,
  type WorkerResult,
} from '../../core/index.js';
import { loadPiAdapterConfig, type PiAdapterConfig } from './config.js';
import { PiHistorySource } from './history.js';
import { PiLedgerStore, OM_CUSTOM_TYPE } from './ledger.js';
import { PiSubprocessRunner } from './runner.js';
import type {
  PiApi,
  PiCommandContext,
  PiCompactPreparation,
  PiContext,
  PiEntry,
} from './types.js';

interface Runtime {
  config: PiAdapterConfig;
  orch: OmOrchestrator;
  memory: MemoryStore;
  lastCtx: PiContext | null;
}

export interface OmExtension {
  runtime(): Runtime | null;
}

export default function observationalMemory(pi: PiApi): OmExtension {
  let rt: Runtime | null = null;

  const debug = (m: string) => {
    if (rt?.config.om.debugLog) console.error(`[om] ${m}`);
  };

  const sink: EventSink = {
    onStatus(s: OmStatus) {
      const ctx = rt?.lastCtx;
      if (!ctx) return;
      if (!s.enabled) {
        ctx.ui.setStatus('om', undefined);
        return;
      }
      ctx.ui.setStatus('om', `OM ${s.activeObservations} obs · $${s.costUsd.toFixed(3)}`);
    },
    onCompactionBlock(_b: CompactionBlock) {
      // The actual block is rendered inside session_before_compact (fresh
      // history); here we just trigger pi's compaction flow.
      const ctx = rt?.lastCtx;
      if (ctx && ctx.isIdle()) ctx.compact();
    },
    onRunStarted(r: RunInfo) {
      debug(`run ${r.runId} (${r.role}) started`);
    },
    onRunFinished(r: RunInfo, w: WorkerResult) {
      debug(`run ${r.runId} finished ok=${w.ok}${w.costUsd ? ` cost=$${w.costUsd}` : ''}`);
    },
    onError(e) {
      rt?.lastCtx?.ui.notify(`OM: ${e.message}`, 'error');
      debug(`error: ${e.message}`);
    },
    onGapMarker(g) {
      pi.sendMessage(
        {
          customType: 'om',
          content: `[temporal anchor] ${g.humanDuration} passed since the previous message (observational memory)`,
          display: false,
        },
        { triggerTurn: false },
      );
      debug(`gap marker: ${g.humanDuration}`);
    },
  };

  function boot(ctx: PiContext): Runtime {
    if (rt) return rt;
    const config = loadPiAdapterConfig(ctx.cwd);
    const header = ctx.sessionManager.getHeader();
    const sessionId = ctx.sessionManager.getSessionId() || header.id;
    const memory = new MemoryStore(config.memoryDir);

    const history = new PiHistorySource(
      () => ctx.sessionManager,
      () => ctx,
      { chunkTokens: config.om.chunkTokens, chunkOverlapTokens: config.om.chunkOverlapTokens },
    );
    const ledger = new PiLedgerStore(
      (data) => pi.appendEntry(OM_CUSTOM_TYPE, data),
      () => ctx.sessionManager.getEntries(),
    );
    const runner = new PiSubprocessRunner({
      piBinary: config.piBinary,
      cwd: ctx.cwd,
      observerModel: config.om.models.observer,
      consolidatorModel: config.om.models.consolidator,
      sessionLabel: path.basename(ctx.cwd),
      journeyTargetTokens: config.om.journeyTargetTokens,
      timeoutMs: config.workerTimeoutMs,
      debug,
    });
    const orch = new OmOrchestrator({
      config: config.om,
      sessionId,
      forkParentSessionId: header.parentSession,
      history,
      ledger,
      runner,
      memory,
      sink,
      log: debug,
    });
    orch.restoreEnabled();
    rt = { config, orch, memory, lastCtx: ctx };
    debug(`booted (enabled=${orch.isEnabled()}, sessionId=${sessionId})`);
    return rt;
  }

  const track = (ctx: PiContext): Runtime => {
    const r = boot(ctx);
    r.lastCtx = ctx;
    return r;
  };

  // Id of the first entry AFTER the tail boundary (firstKeptEntryId).
  const firstEntryIdAfter = (ctx: PiContext, boundary: string, fallback: string): string => {
    if (boundary === '') return fallback;
    const entries: PiEntry[] = ctx.sessionManager.getEntries();
    const idx = entries.findIndex((e) => e.id === boundary);
    if (idx === -1) return fallback;
    return entries[idx + 1]?.id ?? fallback;
  };

  pi.on('session_start', (_e, ctx) => {
    track(ctx);
  });
  pi.on('turn_end', (_e, ctx) => {
    const r = track(ctx);
    r.orch.onTurnEnd();
  });
  pi.on('agent_end', async (_e, ctx) => {
    const r = track(ctx);
    await r.orch.onAgentEnd();
  });
  pi.on('session_before_compact', (event, ctx) => {
    const r = track(ctx);
    if (!r.orch.isEnabled()) return; // default pi compaction when OM is off
    const prep: PiCompactPreparation = (event as { preparation?: PiCompactPreparation })?.preparation ?? {
      firstKeptEntryId: '',
      tokensBefore: 0,
    };
    // Wait for in-flight observers so the block is complete (best effort).
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
    r.lastCtx?.ui.setStatus('om', undefined);
  });

  // ---- commands (FR-7.1) ------------------------------------------------

  const report = (ctx: PiCommandContext, lines: string[]) => {
    const out = lines.join('\n');
    if (ctx.hasUI) for (const l of lines) ctx.ui.notify(l, 'info');
    else console.log(out);
  };

  pi.registerCommand('om', {
    description: 'Toggle observational memory for this session (on/off)',
    handler: async (args, ctx) => {
      const r = track(ctx);
      const t = args.trim().toLowerCase();
      if (t === 'on') r.orch.setEnabled(true);
      else if (t === 'off') r.orch.setEnabled(false);
      else r.orch.setEnabled(!r.orch.isEnabled());
      report(ctx, [r.orch.isEnabled() ? 'Observational memory: ON' : 'Observational memory: OFF']);
    },
  });

  pi.registerCommand('om:status', {
    description: 'Observational memory status',
    handler: async (_args, ctx) => {
      const r = track(ctx);
      const s = r.orch.status();
      report(ctx, [
        `OM ${s.enabled ? 'on' : 'off'}${s.passive ? ' (passive)' : ''}`,
        `pool: ${s.activeObservations} observations (~${s.poolTokens} tokens)`,
        `consolidator: ${s.consolidationPending ? 'running' : 'idle'}`,
        `memory: ${s.topicCount} topics, journey ~${s.journeyTokens} tokens`,
        `context: ${s.contextTokens ?? '?'} tokens`,
        `session cost: $${s.costUsd.toFixed(3)} (${s.runs} runs)`,
        `in flight: ${s.inFlight.map((i) => i.role).join(', ') || 'none'}`,
        s.lastError ? `last error: ${s.lastError.message}` : '',
      ].filter(Boolean));
    },
  });

  pi.registerCommand('om:compact', {
    description: 'Force an observational-memory compaction now',
    handler: async (_args, ctx) => {
      const r = track(ctx);
      if (!r.orch.isEnabled()) {
        report(ctx, ['OM is off — enable with /om on first.']);
        return;
      }
      report(ctx, ['Compacting with observational memory…']);
      await r.orch.forceCompact();
    },
  });

  pi.registerCommand('om:consolidate', {
    description: 'Force a consolidation now (ignore pool threshold)',
    handler: async (_args, ctx) => {
      const r = track(ctx);
      if (!r.orch.isEnabled()) {
        report(ctx, ['OM is off — enable with /om on first.']);
        return;
      }
      r.orch.forceConsolidate();
      report(ctx, ['Consolidation started (background). Check /om:status.']);
    },
  });

  return {
    runtime: () => rt,
  };
}
