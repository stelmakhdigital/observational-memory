/**
 * UI helpers (S4: extracted from index.ts).
 *
 * Decorative footer status; guarded because some pi modes/versions provide a
 * ui object without setStatus (seen in TUI: boot-ctx ui predates the TUI ui
 * object). A missing method must never break the pipeline.
 * UI calls are guarded: in some pi modes/versions the ctx.ui object lacks
 * methods even when hasUI is true (observed live in TUI: notify/setStatus
 * missing). A decorative UI call must never break the pipeline; on the
 * first anomaly we dump the actual ui shape to stderr for diagnosis.
 */
import type { PiContext } from './types.js';

export interface UiOps {
  notifyUi(ctx: PiContext, message: string, type: 'info' | 'warning' | 'error'): void;
  setUiStatus(ctx: PiContext, text: string | undefined): void;
}

export function createUi(): UiOps {
  let uiDiagLogged = false;
  const diagUi = (ctx: PiContext, missing: string) => {
    if (uiDiagLogged) return;
    uiDiagLogged = true;
    const ui = ctx.ui as unknown as Record<string, unknown> | undefined;
    console.error(
      `[om] ui anomaly: missing ${missing}; mode=${ctx.mode ?? 'unknown'} ` +
      `uiKeys=[${ui ? Object.keys(ui).join(',') : String(ui)}] hasUI=${ctx.hasUI}`,
    );
  };
  const notifyUi: UiOps['notifyUi'] = (ctx, message, type) => {
    const fn = (ctx.ui as { notify?: unknown } | undefined)?.notify;
    if (typeof fn === 'function') (fn as (m: string, t?: string) => void).call(ctx.ui, message, type);
    else diagUi(ctx, 'notify');
  };
  const setUiStatus: UiOps['setUiStatus'] = (ctx, text) => {
    const fn = (ctx.ui as { setStatus?: unknown } | undefined)?.setStatus;
    if (typeof fn === 'function') {
      (fn as (key: string, text: string | undefined) => void).call(ctx.ui, 'om', text);
    } else diagUi(ctx, 'setStatus');
  };
  return { notifyUi, setUiStatus };
}
