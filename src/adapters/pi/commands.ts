/**
 * /om* command handlers (S4: extracted from index.ts).
 */
import type { Runtime } from './boot.js';
import type { UiOps } from './ui.js';
import type { PiApi, PiCommandContext, PiContext } from './types.js';

/** Lazy runtime accessor: boot on first use, track the latest ctx. */
export type Track = (ctx: PiContext) => Runtime;

export interface CommandDeps {
  track: Track;
  ui: UiOps;
}

export function report(ctx: PiCommandContext, lines: string[], ui: UiOps): void {
  if (ctx.hasUI) for (const l of lines) ui.notifyUi(ctx, l, 'info');
  else console.log(lines.join('\n'));
}

export function registerCommands(pi: PiApi, deps: CommandDeps): void {
  const { track, ui } = deps;

  pi.registerCommand('om', {
    description: 'Toggle observational memory for this session (on/off)',
    handler: async (args, ctx) => {
      const r = track(ctx);
      const t = args.trim().toLowerCase();
      if (t === 'on') r.orch.setEnabled(true);
      else if (t === 'off') r.orch.setEnabled(false);
      else r.orch.setEnabled(!r.orch.isEnabled());
      report(ctx, [r.orch.isEnabled() ? 'Observational memory: ON' : 'Observational memory: OFF'], ui);
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
      ].filter(Boolean), ui);
    },
  });

  pi.registerCommand('om:compact', {
    description: 'Force an observational-memory compaction now',
    handler: async (_args, ctx) => {
      const r = track(ctx);
      if (!r.orch.isEnabled()) {
        report(ctx, ['OM is off — enable with /om on first.'], ui);
        return;
      }
      report(ctx, ['Compacting with observational memory…'], ui);
      await r.orch.forceCompact();
    },
  });

  pi.registerCommand('om:consolidate', {
    description: 'Force a consolidation now (ignore pool threshold)',
    handler: async (_args, ctx) => {
      const r = track(ctx);
      if (!r.orch.isEnabled()) {
        report(ctx, ['OM is off — enable with /om on first.'], ui);
        return;
      }
      r.orch.forceConsolidate();
      report(ctx, ['Consolidation started (background). Check /om:status.'], ui);
    },
  });

  pi.registerCommand('om:extract', {
    description: 'Force a structured-extractor refresh now (profile, current task, …)',
    handler: async (_args, ctx) => {
      const r = track(ctx);
      if (!r.orch.isEnabled()) {
        report(ctx, ['OM is off — enable with /om on first.'], ui);
        return;
      }
      r.orch.forceExtract();
      report(ctx, ['Extraction started (background). Check /om:status.'], ui);
    },
  });

  pi.registerCommand('om:recall', {
    description: 'Search this session’s observational memory: /om:recall <query> [limit N] [since DATE] [until DATE]',
    handler: async (args, ctx) => {
      const r = track(ctx);
      if (!r.orch.isEnabled()) {
        report(ctx, ['OM is off — enable with /om on first.'], ui);
        return;
      }
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      let limit: number | undefined;
      let since: string | undefined;
      let until: string | undefined;
      const rest: string[] = [];
      for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i]!;
        if (t.toLowerCase() === 'limit') {
          const raw = tokens[++i];
          limit = Number(raw);
          // A12: "limit" без значения (или нечисло) не должно давать NaN.
          if (raw === undefined || raw === '' || !Number.isFinite(limit)) {
            report(ctx, ['Usage: /om:recall <query> [limit N] [since DATE] [until DATE] (limit: positive integer)'], ui);
            return;
          }
        }
        else if (t.toLowerCase() === 'since') since = tokens[++i];
        else if (t.toLowerCase() === 'until') until = tokens[++i];
        else rest.push(t);
      }
      // R7: an invalid date now throws from recall (OmError) — surface it as
      // a usage message instead of crashing the command handler.
      if (
        (since !== undefined && since !== '' && Number.isNaN(Date.parse(since))) ||
        (until !== undefined && until !== '' && Number.isNaN(Date.parse(until)))
      ) {
        report(ctx, ['Usage: /om:recall <query> [limit N] [since DATE] [until DATE] (dates: ISO, e.g. 2025-09-21)'], ui);
        return;
      }
      const query = rest.join(' ');
      if (!query) {
        report(ctx, ['Usage: /om:recall <query> [limit N] [since DATE] [until DATE]'], ui);
        return;
      }
      report(ctx, [r.orch.recallText(query, { limit, since, until })], ui);
    },
  });

  pi.registerCommand('om:reflect', {
    description: 'Force a sleep-time memory reorganization pass now (topics/INDEX/JOURNEY)',
    handler: async (_args, ctx) => {
      const r = track(ctx);
      if (!r.orch.isEnabled()) {
        report(ctx, ['OM is off — enable with /om on first.'], ui);
        return;
      }
      r.orch.forceReflect();
      report(ctx, ['Reflect pass started (background). Check /om:status.'], ui);
    },
  });

  pi.registerCommand('om:seed-from', {
    description: 'Seed this session’s memory from another session: /om:seed-from <sessionId>',
    handler: async (args, ctx) => {
      const r = track(ctx);
      const parent = args.trim();
      if (!parent) {
        report(ctx, ['Usage: /om:seed-from <sessionId>'], ui);
        return;
      }
      const did = r.memory.seedFrom(parent, ctx.sessionManager.getSessionId(), { force: true });
      report(ctx, [did ? `Memory seeded from ${parent}.` : `No memory found for ${parent} (or nothing to copy).`], ui);
    },
  });
}
