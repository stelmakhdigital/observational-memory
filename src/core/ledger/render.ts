/**
 * Render: deterministic, model-free rendering of the compaction block
 * (FR-2.2, FR-3, NFR-2). Same inputs → same outputs; no LLM involved.
 *
 * FR-3.4 (no double representation): the verbatim tail covers fresh history
 * starting at tailStartId; any observation chunk whose watermark reaches into
 * that tail is excluded, snapping the cutoff to a chunk boundary.
 * See ARCHITECTURE.md §4.2.
 */
import type { CompactionBlock, Observation } from '../types.js';

/**
 * Render active observations as a verbatim, deterministic block.
 * Order = whatever the caller passed (orchestrator sorts by priority, v0.4).
 * Priority/quarantine markers are explicit so the agent sees trust levels:
 *   [id] ! text      — critical (P0)
 *   [id] text        — important (P1) / unknown
 *   [id] · text      — routine (P2)
 *   [id] [UNVERIFIED] text — quarantined by the anti-poisoning sanitizer (v0.6).
 * Format is stable for prompt caching (NFR).
 */
export function renderPool(observations: readonly Observation[]): string {
  if (observations.length === 0) return '';
  const lines = observations.map((o) => {
    const flat = o.content.replace(/\s*\n[ \t]*(?:\n[ \t]*)*/g, ' ').trim();
    const pr = o.priority ?? 'routine';
    const marker = pr === 'critical' ? '! ' : pr === 'routine' ? '· ' : '';
    const q = o.quarantined ? '[UNVERIFIED] ' : '';
    return `[${o.id}] ${q}${marker}${flat}`;
  });
  return lines.join('\n');
}

/**
 * Select observations that do NOT overlap the verbatim tail (FR-3.4).
 * @param tailBoundaryId id of the LAST message NOT included in the tail;
 *   '' means the tail covers the whole history → no observations are rendered.
 * A chunk (group sharing coversUpToId) is kept only when its watermark is
 * within the pre-tail region, snapping the cutoff to a chunk boundary.
 */
export function selectBeforeTail(
  observations: readonly Observation[],
  tailBoundaryId: string,
): Observation[] {
  if (tailBoundaryId === '') return [];
  const out: Observation[] = [];
  for (const o of observations) {
    if (o.coversUpToId === '') continue; // malformed: never render
    if (o.coversUpToId <= tailBoundaryId) out.push(o);
  }
  return out;
}

export interface BlockInputs {
  observations: readonly Observation[];
  memoryMap: string;
  journey: string;
  verbatimTail: string;
  gapMarkers: string;
  /** Built-in current-task value rendered at the head (v0.4); '' when absent. */
  currentTask?: string;
  generatedAt: string;
}

const H = '='.repeat(48);

export function renderCompactionBlock(i: BlockInputs): CompactionBlock {
  const currentTask = (i.currentTask ?? '').trim();
  const parts: string[] = [];
  parts.push(`${H}\nOBSERVATIONAL MEMORY\n${H}`);
  if (currentTask) {
    parts.push(`--- current task ---\n${currentTask}`);
  }
  if (i.gapMarkers.trim()) {
    parts.push(`--- temporal anchors ---\n${i.gapMarkers.trim()}`);
  }
  parts.push(
    `--- observations (${i.observations.length}) ---\n${renderPool(i.observations) || '(none yet)'}`,
  );
  if (i.memoryMap.trim()) {
    parts.push(`--- memory map (durable topics) ---\n${i.memoryMap.trim()}`);
  }
  if (i.journey.trim()) {
    parts.push(`--- journey ---\n${i.journey.trim()}`);
  }
  parts.push(`${H}\nRECENT HISTORY (verbatim)\n${H}\n${i.verbatimTail}`);
  return {
    observations: renderPool(i.observations),
    memoryMap: i.memoryMap,
    journey: i.journey,
    currentTask,
    verbatimTail: i.verbatimTail,
    gapMarkers: i.gapMarkers,
    text: parts.join('\n\n'),
    generatedAt: i.generatedAt,
  };
}
