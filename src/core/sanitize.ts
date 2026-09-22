/**
 * Anti-poisoning sanitizer (v0.6): observations are long-lived context, so a
 * prompt-injection that survived one turn would otherwise persist as "memory"
 * and be re-injected on every compaction. The sanitizer flags observation
 * content that LOOKS LIKE an instruction rather than a fact; the orchestrator
 * quarantines such observations (rendered with a [UNVERIFIED] marker, and the
 * observer prompt already instructs neutral notation of injection attempts).
 *
 * Deterministic regex heuristics — cheap, no LLM, no false positives expected
 * to block the pipeline (worst case: a fact gets an [UNVERIFIED] marker).
 */

const PATTERNS: RegExp[] = [
  // direct instruction overrides
  /ignore\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions|prompts|rules|context)/i,
  /disregard\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions|prompts|rules)/i,
  /forget\s+(everything|all|your)\s+(previous|prior|above)/i,
  /override\s+(your\s+)?(system|safety|security)\s+(prompt|instructions|rules)/i,
  /you\s+must\s+(from\s+now\s+on|always|henceforth|going\s+forward)\s+(ignore|disregard|obey)/i,
  // fake role/system boundaries
  /\b(system|developer)\s*[:\-]?\s*(prompt|message|instruction)\b/i,
  /\bNEW\s+INSTRUCTIONS?\b/i,
  /\bIMPORTANT\s+INSTRUCTION\b/i,
  /\[system\]|\[developer\]/i,
  // self-directed agent manipulation in recorded content
  /you\s+are\s+now\s+(in\s+)?(DAN|developer|admin|god)\s*mode/i,
  /\b(?:in|entering)\s+(DAN|developer|admin|god)\s*mode\b/i,
  /jailbreak|developer\s+mode\s+enabled/i,
  // embedded instruction fences
  /```(?:system|developer)/i,
  // exfiltration-style directives
  /(send|post|transmit|upload)\s+(all\s+)?(the\s+)?(previous|above|conversation|history|secrets|keys|tokens)\s+to\s+/i,
];

export interface SanitizeResult {
  text: string;
  /** True when the content matched an injection pattern. */
  quarantined: boolean;
  /** The matched pattern source (diagnostics). */
  matched?: string;
}

/**
 * Check observation content for injection-like patterns.
 * NOTE: this inspects the OBSERVATION (distilled note), not the raw history —
 * the observer is instructed to note injection attempts neutrally, so a clean
 * "injection-like instruction appeared" note must NOT trip the patterns.
 */
export function sanitizeObservation(text: string): SanitizeResult {
  for (const p of PATTERNS) {
    if (p.test(text)) {
      return { text, quarantined: true, matched: p.source };
    }
  }
  return { text, quarantined: false };
}
