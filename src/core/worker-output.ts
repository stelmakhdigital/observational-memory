/**
 * Worker output parsing (ARCHITECTURE §4.5). Deterministic, tested without LLM.
 * LLM output is unreliable at the edges, so parsers are LENIENT:
 *  - prefer the strict block; fall back to bullet lines outside it;
 *  - missing fields degrade to safe defaults; structural garbage → ok=false.
 * The orchestrator decides retry/failure policy (NFR-1).
 */

export interface ParsedObserverOutput {
  ok: boolean;
  /** Observation texts, in emitted order. */
  observations: string[];
  error?: string;
}

const OBS_BLOCK = /OBSERVATIONS\s*\n([\s\S]*?)\n?\s*END_OBSERVATIONS/;

export function parseObserverOutput(raw: string): ParsedObserverOutput {
  const text = raw.trim();
  const m = OBS_BLOCK.exec(text);
  const body = m ? m[1]! : text;

  if (/^\(no observations\)$/m.test(body)) {
    return { ok: true, observations: [] };
  }

  const bullets: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    const b = /^\s*[-*]\s+(.*)$/.exec(line);
    if (b && b[1]!.trim() && !/^END_OBSERVATIONS/.test(b[1]!)) bullets.push(b[1]!.trim());
  }
  if (bullets.length === 0) {
    // A bare paragraph without bullets: keep it if it's short enough to be a note.
    const para = body.replace(/OBSERVATIONS|END_OBSERVATIONS/g, '').trim();
    if (para && para.length <= 2000 && !/^(no observations|none)$/i.test(para)) {
      return { ok: true, observations: [para] };
    }
    return { ok: false, observations: [], error: 'no observations found in observer output' };
  }
  return { ok: true, observations: bullets.slice(0, 24) };
}

export interface ParsedConsolidationReport {
  ok: boolean;
  topics: string[];
  journeyChanged: boolean;
  /** Observation ids the consolidator consumed. */
  consumedIds: string[];
  /** Observation ids explicitly dropped as superseded. */
  droppedIds: string[];
  error?: string;
}

const REPORT_BLOCK = /CONSOLIDATION_REPORT\s*\n([\s\S]*?)\n?\s*END_CONSOLIDATION_REPORT/;

const csv = (s: string | undefined): string[] =>
  (s ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter((x) => x.length > 0 && x.toLowerCase() !== 'none');

export function parseConsolidationReport(raw: string): ParsedConsolidationReport {
  const text = raw.trim();
  const m = REPORT_BLOCK.exec(text);
  if (!m) {
    return {
      ok: false,
      topics: [],
      journeyChanged: false,
      consumedIds: [],
      droppedIds: [],
      error: 'consolidation report block not found',
    };
  }
  const body = m[1]!;
  const field = (name: string): string | undefined => {
    const fm = new RegExp(`^${name}:\\s*(.*)$`, 'mi').exec(body);
    return fm?.[1];
  };
  const journey = field('journey_changed')?.trim().toLowerCase();
  return {
    ok: true,
    topics: csv(field('topics')),
    journeyChanged: journey === 'true',
    consumedIds: csv(field('consumed')),
    droppedIds: csv(field('dropped')),
  };
}

export interface ParsedExtraction {
  ok: boolean;
  /** Values keyed by extractor spec id. */
  values: Record<string, unknown>;
  error?: string;
}

const JSON_BLOCK = /EXTRACTED_JSON\s*\n([\s\S]*?)\n?\s*END_EXTRACTED_JSON/;

/**
 * Lenient parser for extractor output: prefer the EXTRACTED_JSON block, fall
 * back to the first balanced {...} object in the reply.
 */
export function parseExtractorOutput(raw: string): ParsedExtraction {
  const text = raw.trim();
  const m = JSON_BLOCK.exec(text);
  const candidates: string[] = [];
  if (m) candidates.push(m[1]!);
  const braceStart = text.indexOf('{');
  const braceEnd = text.lastIndexOf('}');
  if (braceStart !== -1 && braceEnd > braceStart) {
    candidates.push(text.slice(braceStart, braceEnd + 1));
  }
  for (const c of candidates) {
    try {
      const v: unknown = JSON.parse(c.trim());
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        return { ok: true, values: v as Record<string, unknown> };
      }
    } catch {
      /* try next candidate */
    }
  }
  return { ok: false, values: {}, error: 'no JSON object found in extractor output' };
}
