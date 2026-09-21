/**
 * Fast token estimation without LLM calls (FR-2.2, NFR-5).
 * Heuristic calibrated near chars/4 for mixed prose/code; good enough for
 * thresholding (chunk cuts, pool/compact triggers) where +-10-20% is acceptable.
 * See ARCHITECTURE.md §4.3.
 */

const AVG_CHARS_PER_TOKEN = 4;

/**
 * Estimate token count of a text. Deterministic and cheap (no network, no regex
 * storms): base chars/4 with a light correction for long unbroken "code-like"
 * runs, which are tokenized denser than prose.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  let long = 0; // chars inside unbroken runs > 12
  let run = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const isBoundary =
      c < 256 && (c < 33 || c > 126) // whitespace/punctuation in ASCII range
        ? true
        : false;
    if (c >= 33 && c <= 126) run++;
    else {
      if (run > 12) long += run;
      run = 0;
      if (isBoundary) continue;
    }
  }
  if (run > 12) long += run;
  // Dense runs estimate at ~2.5 chars/token instead of 4.
  const effective = text.length - long + long * 0.625;
  return Math.max(1, Math.ceil(effective / AVG_CHARS_PER_TOKEN));
}

/** Estimate tokens of an array of strings (sum). */
export function estimateTokensOf(parts: readonly string[]): number {
  let sum = 0;
  for (const p of parts) sum += estimateTokens(p);
  return sum;
}
