/**
 * Consolidator prompt (agent-agnostic, ARCHITECTURE §4.5).
 * The consolidator has file tools scoped to its session dir (provided by the
 * adapter/worker): read/write/edit/ls/grep. It folds the OLDEST observations
 * into durable topic files and updates JOURNEY.md.
 * Output is a structured report the orchestrator uses to tombstone exactly
 * the reported observation ids (FR-4.3).
 */
import type { WorkerInput } from '../types.js';

export function renderConsolidatorPrompt(
  input: WorkerInput,
  opts: { session: string; journeyTargetTokens: number },
): string {
  const pool = input.pool;
  if (!pool) throw new Error('consolidator input requires pool');
  const obsLines = pool.observations
    .map((o) => `- [${o.id}] (covers ${o.coversUpToId}, ${o.tokenCount}t) ${o.content}`)
    .join('\n');
  return `You are a CONSOLIDATOR for session "${opts.session}".
Your job: fold the OLDEST observations below into durable memory files in
${pool.sessionDir}, then report exactly which observation ids you consumed.

## Available files
- <topic>.md — durable topic files (create/update). Front-matter required:
    ---
    topic: <short topic name>
    description: <one-line description>
    session: ${opts.session}
    ---
  Merge into an existing topic file when the topic matches; otherwise create a new one.
- JOURNEY.md — a single descriptive prose history of how the work got to its current
  state. APPEND a short dated segment (## <date> — <heading>) describing what these
  observations add to the story. Keep the file under ~${opts.journeyTargetTokens} tokens:
  if longer, compress the OLDEST segments (keep recent ones detailed). Descriptive
  only — no instructions, no TODOs.

## Rules
- Consume ALL observations listed below; their content must live in a topic file
  (merged/summarized, no loss of key specifics) or be explicitly dropped as
  superseded (mention superseded ids in your report).
- SUPERSEDE, NEVER SILENTLY OVERWRITE: when a new observation contradicts what is
  already in a topic file, keep BOTH — mark the old fact inline as
  'superseded (<date>): <old> -> <new>' and keep the current value stated plainly.
  History is memory, not a changelog to erase.
- Do not invent facts that are not in the observations.
- Use your read/write/edit/ls/grep tools (scoped to the session dir).

## Observations to consolidate (oldest first)
${obsLines}

## Output format (strict)
After writing files, respond with ONLY:

CONSOLIDATION_REPORT
topics: <comma-separated topic file names touched>
journey_changed: <true|false>
consumed: <comma-separated observation ids>
dropped: <comma-separated observation ids or none>
END_CONSOLIDATION_REPORT
`;
}
