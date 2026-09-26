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
import { Type } from 'typebox';
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
import type { ModelRef } from '../../core/config.js';
import { firstBranchEntryIdAfter, PiHistorySource } from './history.js';
import { PiLedgerStore, OM_CUSTOM_TYPE } from './ledger.js';
import { PiSubprocessRunner } from './runner.js';
import type {
  PiApi,
  PiCommandContext,
  PiCompactPreparation,
  PiContext,
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

  /**
   * n11: an empty worker model id means "inherit the host model" (the model
   * the agent itself runs on). The runner takes static ModelRefs at boot, so
   * the host model is resolved here (ctx.model at boot; mid-session model
   * switches do not re-target already-built workers). Explicit ids pass
   * through untouched; explicit provider/thinking are honored alongside an
   * inherited id.
   */
  const resolveWorkerModel = (
    ref: ModelRef | undefined,
    role: string,
    ctx: PiContext,
    fallback?: ModelRef,
  ): ModelRef => {
    // extractor/reflect default to the consolidator model (runner semantics).
    const r = ref ?? fallback;
    if (r && r.id) return r;
    if (ctx.model) {
      return {
        provider: r?.provider ?? ctx.model.provider,
        id: ctx.model.id,
        ...(r?.thinking ? { thinking: r.thinking } : {}),
      };
    }
    // Host model unknown too: fail loudly (a clearly-named id makes the
    // subprocess error obvious instead of a cryptic spawn failure).
    const msg =
      `worker "${role}" has no model configured (models.${role}.id) and the host model is unknown — ` +
      `worker runs will fail; set "observational-memory".models.${role} in settings`;
    console.error(`[om] ${msg}`);
    if (ctx.hasUI) ctx.ui.notify(`OM: ${msg}`, 'error');
    return { ...(r ?? {}), id: 'om-unconfigured-model' };
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
    const memory = new MemoryStore(config.memoryDir, {
      sharedDir: config.om.shared.enabled ? path.join(config.memoryDir, 'shared') : null,
    });

    const history = new PiHistorySource(
      () => ctx.sessionManager,
      () => ctx,
      {
        chunkTokens: config.om.chunkTokens,
        chunkOverlapTokens: config.om.chunkOverlapTokens,
        attachments: config.attachments,
      },
    );
    const ledger = new PiLedgerStore(
      (data) => pi.appendEntry(OM_CUSTOM_TYPE, data),
      // C1: current branch only — om.* custom entries are branch-local
      // (children of the leaf), so the branch contains exactly the ledger
      // of the current /tree branch.
      () => ctx.sessionManager.getBranch(),
    );
    const consolidatorModel = resolveWorkerModel(config.om.models.consolidator, 'consolidator', ctx);
    const runner = new PiSubprocessRunner({
      piBinary: config.piBinary,
      cwd: ctx.cwd,
      observerModel: resolveWorkerModel(config.om.models.observer, 'observer', ctx),
      consolidatorModel,
      extractorModel: resolveWorkerModel(config.om.models.extractor, 'extractor', ctx, consolidatorModel),
      reflectModel: resolveWorkerModel(config.om.models.reflect, 'reflect', ctx, consolidatorModel),
      sessionLabel: path.basename(ctx.cwd),
      journeyTargetTokens: config.om.journeyTargetTokens,
      priorityEnabled: config.om.priority.enabled,
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
  pi.on('agent_end', async (_e, ctx) => {
    const r = track(ctx);
    await r.orch.onAgentEnd();
  });
  pi.on('model_select', (_e, ctx) => {
    // Early activation (v2): the prompt cache is invalidated anyway.
    track(ctx).orch.onModelChange();
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

  // v0.5: the agent itself can query memory mid-conversation (deterministic,
  // no LLM). Registered at boot; the gate is checked at call time.
  pi.registerTool({
    name: 'om_recall',
    label: 'OM Recall',
    description:
      'Search this session’s observational memory (observations, durable topics, journey, extracted values). '
      + 'Use when you need a fact, decision or earlier detail that is no longer in the visible context. '
      + 'Deterministic BM25-lite search — no LLM. Optional since/until (ISO dates) filter observations by time.',
    promptSnippet: 'Search the session’s observational memory (facts, decisions, history)',
    promptGuidelines: [
      'Use om_recall before re-asking the user for context that may already be in memory.',
    ],
    parameters: Type.Object({
      query: Type.String({ description: 'What to look for' }),
      limit: Type.Optional(Type.Number({ description: 'Max hits (default 10)' })),
      since: Type.Optional(Type.String({ description: 'Only observations created on/after (ISO date)' })),
      until: Type.Optional(Type.String({ description: 'Only observations created on/before (ISO date)' })),
    }),
    async execute(_toolCallId: string, params: { query: string; limit?: number; since?: string; until?: string }, _signal: unknown, _onUpdate: unknown, ctx: PiContext) {
      const r = track(ctx);
      if (!r.orch.isEnabled()) {
        return { content: [{ type: 'text', text: 'Observational memory is off (enable with /om on).' }], details: {} };
      }
      const text = r.orch.recallText(params.query, {
        limit: params.limit,
        since: params.since,
        until: params.until,
      });
      return { content: [{ type: 'text', text }], details: {} };
    },
  });

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
        s.extractedCount !== undefined ? `extracted: ${s.extractedCount} values` : '',
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

  pi.registerCommand('om:extract', {
    description: 'Force a structured-extractor refresh now (profile, current task, …)',
    handler: async (_args, ctx) => {
      const r = track(ctx);
      if (!r.orch.isEnabled()) {
        report(ctx, ['OM is off — enable with /om on first.']);
        return;
      }
      r.orch.forceExtract();
      report(ctx, ['Extraction started (background). Check /om:status.']);
    },
  });

  pi.registerCommand('om:recall', {
    description: 'Search this session’s observational memory: /om:recall <query> [limit N] [since DATE] [until DATE]',
    handler: async (args, ctx) => {
      const r = track(ctx);
      if (!r.orch.isEnabled()) {
        report(ctx, ['OM is off — enable with /om on first.']);
        return;
      }
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      let limit: number | undefined;
      let since: string | undefined;
      let until: string | undefined;
      const rest: string[] = [];
      for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i]!;
        if (t.toLowerCase() === 'limit') limit = Number(tokens[++i]);
        else if (t.toLowerCase() === 'since') since = tokens[++i];
        else if (t.toLowerCase() === 'until') until = tokens[++i];
        else rest.push(t);
      }
      const query = rest.join(' ');
      if (!query) {
        report(ctx, ['Usage: /om:recall <query> [limit N] [since DATE] [until DATE]']);
        return;
      }
      report(ctx, [r.orch.recallText(query, { limit, since, until })]);
    },
  });

  pi.registerCommand('om:reflect', {
    description: 'Force a sleep-time memory reorganization pass now (topics/INDEX/JOURNEY)',
    handler: async (_args, ctx) => {
      const r = track(ctx);
      if (!r.orch.isEnabled()) {
        report(ctx, ['OM is off — enable with /om on first.']);
        return;
      }
      r.orch.forceReflect();
      report(ctx, ['Reflect pass started (background). Check /om:status.']);
    },
  });

  pi.registerCommand('om:seed-from', {
    description: 'Seed this session’s memory from another session: /om:seed-from <sessionId>',
    handler: async (args, ctx) => {
      const r = track(ctx);
      const parent = args.trim();
      if (!parent) {
        report(ctx, ['Usage: /om:seed-from <sessionId>']);
        return;
      }
      const did = r.memory.seedFrom(parent, ctx.sessionManager.getSessionId(), { force: true });
      report(ctx, [did ? `Memory seeded from ${parent}.` : `No memory found for ${parent} (or nothing to copy).`]);
    },
  });

  return {
    runtime: () => rt,
  };
}
