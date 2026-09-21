/**
 * Gap markers (FR-8): detect pauses in the conversation and produce a short,
 * deterministic (model-free) temporal anchor visible to the observer.
 * See ARCHITECTURE.md §4.6.
 */
import { newRunId } from './ids.js';

export interface GapMarkerOptions {
  enabled: boolean;
  thresholdMs: number;
}

export interface DetectedGap {
  at: Date;
  lastAt: Date;
  ms: number;
  /** Human-readable duration, e.g. "2 дня 3 часа 5 минут". */
  humanDuration: string;
}

/**
 * Detect a gap between the last activity and `now`.
 * Returns null when disabled, below threshold, or no prior activity.
 */
export function detectGap(
  lastAt: Date | null,
  now: Date,
  opts: GapMarkerOptions,
): DetectedGap | null {
  if (!opts.enabled || lastAt === null) return null;
  const ms = now.getTime() - lastAt.getTime();
  if (ms < opts.thresholdMs) return null;
  return { at: now, lastAt, ms, humanDuration: humanDuration(ms) };
}

const UNITS: [number, string, string, string][] = [
  [1000, 'секунда', 'секунды', 'секунд'],
  [60_000, 'минута', 'минуты', 'минут'],
  [3_600_000, 'час', 'часа', 'часов'],
  [86_400_000, 'день', 'дня', 'дней'],
  [604_800_000, 'неделя', 'недели', 'недель'],
  [2_629_800_000, 'месяц', 'месяца', 'месяцев'],
];

/** Pluralize a Russian noun (1/2/5 forms). Deterministic. */
function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}

/** Human duration from the two largest non-zero units (e.g. "2 дня 3 часа"). */
export function humanDuration(ms: number): string {
  let rest = Math.floor(ms / 1000);
  const parts: string[] = [];
  for (let i = UNITS.length - 1; i >= 0 && parts.length < 2; i--) {
    const [unitMs, one, few, many] = UNITS[i]!;
    if (rest >= Math.round(unitMs / 1000)) {
      const n = Math.floor(rest / (unitMs / 1000));
      parts.push(`${n} ${plural(n, one, few, many)}`);
      rest -= n * (unitMs / 1000);
    }
  }
  return parts.length > 0 ? parts.join(' ') : 'меньше секунды';
}

/** Render gap markers into the head section of a compaction block. */
export function renderGapMarkers(gaps: readonly DetectedGap[]): string {
  if (gaps.length === 0) return '';
  return gaps
    .map((g) => `- ${g.at.toISOString()}: resumed after ${g.humanDuration} of inactivity`)
    .join('\n');
}

/** Factory for gap-marker ledger entry ids (stable per detection moment). */
export function gapMarkerId(now: Date, seq: number): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `gap-${now.toISOString().replace(/[-:]/g, '').slice(0, 14)}-${seq + 1}`;
}

/** Re-export for callers that only need run ids. */
export { newRunId };
