/**
 * Runtime boot (S4: extracted from index.ts): worker-model resolution and
 * assembly of the Runtime (config → memory/history/ledger/runner/orchestrator).
 */
import path from 'node:path';
import { MemoryStore, OmOrchestrator, type EventSink } from '../../core/index.js';
import type { ModelRef } from '../../core/config.js';
import { loadPiAdapterConfig, type PiAdapterConfig } from './config.js';
import { PiHistorySource } from './history.js';
import { PiLedgerStore, OM_CUSTOM_TYPE } from './ledger.js';
import { PiSubprocessRunner } from './runner.js';
import type { UiOps } from './ui.js';
import type { PiApi, PiContext } from './types.js';

export interface Runtime {
  config: PiAdapterConfig;
  orch: OmOrchestrator;
  memory: MemoryStore;
  lastCtx: PiContext | null;
}

/**
 * n11: an empty worker model id means "inherit the host model" (the model
 * the agent itself runs on). The runner takes static ModelRefs at boot, so
 * the host model is resolved here (ctx.model at boot; mid-session model
 * switches do not re-target already-built workers). Explicit ids pass
 * through untouched; explicit provider/thinking are honored alongside an
 * inherited id.
 */
export function resolveWorkerModel(
  ref: ModelRef | undefined,
  role: string,
  ctx: PiContext,
  fallback: ModelRef | undefined,
  ui: UiOps,
): ModelRef {
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
  ui.notifyUi(ctx, `OM: ${msg}`, 'error');
  return { ...(r ?? {}), id: 'om-unconfigured-model' };
}

export interface BootDeps {
  pi: PiApi;
  ctx: PiContext;
  debug: (m: string) => void;
  ui: UiOps;
  sink: EventSink;
}

/** Assemble the full Runtime for `ctx` (called once per session). */
export function buildRuntime(deps: BootDeps): Runtime {
  const { pi, ctx, debug, ui, sink } = deps;
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
  const consolidatorModel = resolveWorkerModel(config.om.models.consolidator, 'consolidator', ctx, undefined, ui);
  const runner = new PiSubprocessRunner({
    piBinary: config.piBinary,
    cwd: ctx.cwd,
    observerModel: resolveWorkerModel(config.om.models.observer, 'observer', ctx, undefined, ui),
    consolidatorModel,
    extractorModel: resolveWorkerModel(config.om.models.extractor, 'extractor', ctx, consolidatorModel, ui),
    reflectModel: resolveWorkerModel(config.om.models.reflect, 'reflect', ctx, consolidatorModel, ui),
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
  debug(`booted (enabled=${orch.isEnabled()}, sessionId=${sessionId})`);
  return { config, orch, memory, lastCtx: ctx };
}
