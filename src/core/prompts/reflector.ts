/**
 * Reflector prompt (v0.6, sleep-time / Letta-style): a RARE background worker
 * that reorganizes durable memory files while the session is idle. It does NOT
 * read or produce observations — it only reshapes topic files, INDEX.md and
 * JOURNEY.md. Scoped file tools (session dir) are provided by the adapter.
 */
import type { WorkerInput } from '../types.js';

export interface ReflectorPromptOptions {
  session: string;
  journeyTargetTokens: number;
}

export function renderReflectPrompt(input: WorkerInput, opts: ReflectorPromptOptions): string {
  const r = input.reflect;
  if (!r) throw new Error('reflect input requires .reflect');
  const shared = r.sharedTopics?.trim()
    ? `\n## Shared (project-level) topics (READ-ONLY reference, do not modify)\n${r.sharedTopics.trim()}\n`
    : '';
  return `You are the REFLECTOR for session "${opts.session}" — a rare, background memory
reorganization pass. The session is idle; your job is to make durable memory
${r.sessionDir} easier to use later. You do NOT consume or create observations.

## You may do (using read/write/edit/ls/grep scoped to the session dir)
- Merge near-duplicate topic files (same subject) into one; delete the merged-away
  file after moving its unique content.
- Rename unclear topic file names / front-matter topics to short clear names, and
  sharpen their one-line descriptions.
- Move stale facts inside a topic file into a "## History" section at the bottom
  (keep them — do not delete unique facts).
- Compress JOURNEY.md toward ~${opts.journeyTargetTokens} tokens: shorten the OLDEST
  segments (keep recent ones detailed). Descriptive prose only.

## You must NOT do
- Invent facts or content that is not already in the files.
- Delete any fact (move it to a "## History" section instead).
- Touch extracted/ values, INDEX.md (re-rendered automatically), or files outside
  the session dir.${shared}
## Durable topic files present
${r.topics.length > 0 ? r.topics.map((t) => `- ${t}`).join('\n') : '(none yet — nothing to do)'}

## JOURNEY.md (current)
${r.journey || '(empty)'}

## Output format (strict)
After your edits, respond with ONLY:

REFLECTION_REPORT
topics: <comma-separated topic file names you created/renamed/merged/updated>
journey_changed: <true|false>
END_REFLECTION_REPORT
`;
}
