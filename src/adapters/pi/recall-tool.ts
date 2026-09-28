/**
 * om_recall tool (S4: extracted from index.ts).
 */
import { Type } from 'typebox';
import type { Track } from './commands.js';
import type { PiApi, PiContext } from './types.js';

// v0.5: the agent itself can query memory mid-conversation (deterministic,
// no LLM). Registered at boot; the gate is checked at call time.
export function registerRecallTool(pi: PiApi, track: Track): void {
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
      let text: string;
      try {
        text = r.orch.recallText(params.query, {
          limit: params.limit,
          since: params.since,
          until: params.until,
        });
      } catch (e) {
        // R7: invalid since/until throws OmError — surface as tool text.
        return { content: [{ type: 'text', text: `om_recall error: ${e instanceof Error ? e.message : String(e)}` }], details: {} };
      }
      return { content: [{ type: 'text', text }], details: {} };
    },
  });
}
