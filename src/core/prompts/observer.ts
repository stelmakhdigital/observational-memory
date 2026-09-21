/**
 * Observer prompt (agent-agnostic, ARCHITECTURE §4.5).
 * The observer is a pure mapper: one token-bounded slice → atomic observations.
 * Output format is structured markdown so the core can parse it deterministically
 * (see worker-output.ts). No tool use is required from the observer.
 */
import type { WorkerInput } from '../types.js';

export function renderObserverPrompt(input: WorkerInput, opts: {
  sessionLabel?: string;
}): string {
  const chunk = input.chunk;
  if (!chunk) throw new Error('observer input requires chunk');
  return `You are an OBSERVER for a coding agent's session${opts.sessionLabel ? ` (${opts.sessionLabel})` : ''}.
Your job: distill the conversation slice below into ATOMIC observations.

## What an observation is
- One self-contained note about what happened: a decision made, a fact learned,
  work completed, a problem hit, user preference stated.
- Self-contained: readable without the rest of the conversation.
- Fact-based, no meta-commentary, no "the user asked to…", no plans for the future.
- Do NOT duplicate information from the overlap context (it is only for continuity).

## Rules
- Preserve important specifics: file paths, command names, exact values, error messages.
- If the slice contains nothing worth remembering, emit exactly: (no observations)
- At most 12 observations, most important first.

## Overlap context (already observed — use for continuity only)
${chunk.overlapContext || '(none)'}

## Slice to observe (history up to ${chunk.coversUpToId})
${chunk.text}

## Output format (strict)
Respond with ONLY the following block, no other text:

OBSERVATIONS
- <observation text>
- <observation text>
END_OBSERVATIONS
`;
}
