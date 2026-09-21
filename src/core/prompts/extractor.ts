/**
 * Extractor worker prompt (v2, Mastra-style): refresh a set of named
 * structured values from the active observation pool. The worker replies with
 * a strict JSON block; parsing is lenient (worker-output.ts).
 */
import type { ExtractorSpec, Observation, WorkerInput } from '../types.js';

export interface ExtractorPromptOptions {
  sessionLabel?: string;
}

export function renderExtractorPrompt(input: WorkerInput, opts: ExtractorPromptOptions = {}): string {
  if (!input.extract) throw new Error('renderExtractorPrompt: input.extract is required');
  const ex = input.extract;
  const label = opts.sessionLabel || 'session';
  const specs = ex.specs
    .map((s) => {
      const prev = ex.current[s.id];
      const prevText =
        prev === undefined
          ? '(not stored yet)'
          : JSON.stringify(prev, null, 2);
      return `- id: ${s.id}\n  name: ${s.name}\n  description: ${s.description}\n  current value: ${prevText}`;
    })
    .join('\n');

  const observations = ex.observations
    .map((o) => `[${o.id}] ${o.content}`)
    .join('\n');

  return [
    `You are the EXTRACTOR for Observational Memory (session: ${label}).`,
    '',
    'You maintain named structured values that are distilled from the session’s active',
    'observation pool. For each value below: merge the new evidence into the current value,',
    'update fields that changed, drop stale facts, and keep it compact and factual.',
    'Never invent facts that are not supported by the observations.',
    '',
    'VALUES TO MAINTAIN:',
    specs,
    '',
    'ACTIVE OBSERVATION POOL (newest first):',
    observations || '(empty — keep current values unchanged)',
    '',
    'Respond with ONLY the following block (a single JSON object, keys = value ids):',
    'EXTRACTED_JSON',
    '{ "<id>": <value>, ... }',
    'END_EXTRACTED_JSON',
  ].join('\n');
}
