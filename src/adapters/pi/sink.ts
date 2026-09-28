/**
 * Orchestrator EventSink wiring (S4: extracted from index.ts).
 */
import type { EventSink, OmStatus, RunInfo, WorkerResult } from '../../core/index.js';
import { RESUME_PROMPT } from './resume.js';
import type { Runtime } from './boot.js';
import type { UiOps } from './ui.js';
import type { PiApi } from './types.js';

export interface SinkDeps {
  pi: PiApi;
  getRt: () => Runtime | null;
  debug: (m: string) => void;
  ui: UiOps;
}

export function makeSink(deps: SinkDeps): EventSink {
  const { pi, getRt, debug, ui } = deps;
  return {
    onStatus(s: OmStatus) {
      const ctx = getRt()?.lastCtx;
      if (!ctx) return;
      if (!s.enabled) {
        ui.setUiStatus(ctx, undefined);
        return;
      }
      ui.setUiStatus(ctx, `OM ${s.activeObservations} obs · $${s.costUsd.toFixed(3)}`);
    },
    onCompactionBlock(_b, info) {
      // The actual block is rendered inside session_before_compact (fresh
      // history); here we just trigger pi's compaction flow.
      const ctx = getRt()?.lastCtx;
      if (ctx && ctx.isIdle()) {
        const resume = !!info?.shouldResume;
        ctx.compact({
          onComplete: () => {
            if (!resume) return;
            // Re-check the gate: it may have flipped while compaction ran.
            const r = getRt();
            if (!r || !r.orch.isEnabled() || r.config.om.passive) return;
            try {
              // Hidden message that triggers a new turn (resumeAfterMidRunCompaction,
              // ported from pi-observational-memory, MIT).
              pi.sendMessage(
                { customType: 'om-resume', content: RESUME_PROMPT, display: false },
                { triggerTurn: true },
              );
              debug('resume message sent after auto-compaction');
            } catch (error) {
              const msg = error instanceof Error ? error.message : String(error);
              ui.notifyUi(ctx, `OM: resume after compaction failed — ${msg}`, 'error');
              debug(`resume failed: ${msg}`);
            }
          },
        });
      }
    },
    onRunStarted(r: RunInfo) {
      debug(`run ${r.runId} (${r.role}) started`);
    },
    onRunFinished(r: RunInfo, w: WorkerResult) {
      debug(`run ${r.runId} finished ok=${w.ok}${w.costUsd ? ` cost=$${w.costUsd}` : ''}`);
    },
    onError(e) {
      const ctx = getRt()?.lastCtx;
      if (ctx) ui.notifyUi(ctx, `OM: ${e.message}`, 'error');
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
}
