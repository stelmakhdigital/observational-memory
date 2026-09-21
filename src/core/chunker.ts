/**
 * MessageChunker: token-bounded slices of new history for observers (FR-1.1,
 * ARCHITECTURE §4.3). Pure and deterministic — the adapter supplies messages;
 * the core decides slicing.
 *
 * Rules:
 * - Slices are cut on message boundaries (a message is never split).
 * - A slice is produced only when NEW history (since the watermark) reaches
 *   chunkTokens; the slice is the smallest prefix whose total >= chunkTokens
 *   (a single oversized message becomes a whole slice).
 * - overlapContext: tail of the already-observed history (up to overlapTokens)
 *   handed to the observer for continuity.
 * - coversUpToId: id of the last message in the slice (the new watermark).
 */
import { estimateTokens } from './tokens.js';
import type { Watermark } from './types.js';

export interface OmMessage {
  id: string;
  text: string;
  /** Pre-computed token estimate; computed lazily when absent. */
  tokens?: number;
}

export interface ChunkerOptions {
  chunkTokens: number;
  overlapTokens?: number;
  estimate?: (text: string) => number;
}

export interface Chunk {
  text: string;
  overlapContext: string;
  coversUpToId: string;
  tokens: number;
}

export class MessageChunker {
  private readonly estimate: (t: string) => number;

  constructor(private readonly opts: ChunkerOptions) {
    this.estimate = opts.estimate ?? estimateTokens;
  }

  tokensOf(m: OmMessage): number {
    return m.tokens ?? this.estimate(m.text);
  }

  /**
   * @param messages full visible history in order (ascending ids).
   * @param since watermark; coversUpToId '' means "from the beginning".
   */
  next(messages: readonly OmMessage[], since: Watermark): Chunk | null {
    const { chunkTokens } = this.opts;
    const startIdx =
      since.coversUpToId === ''
        ? 0
        : (() => {
            let i = -1;
            for (let k = 0; k < messages.length; k++) {
              if (messages[k]!.id === since.coversUpToId) i = k;
            }
            // Watermark id not present (e.g. after a tree rollback): re-observe
            // from the beginning — safe (observations are idempotent by id).
            return i === -1 ? 0 : i + 1;
          })();
    const fresh = messages.slice(startIdx);
    if (fresh.length === 0) return null;

    let total = 0;
    for (const m of fresh) total += this.tokensOf(m);
    if (total < chunkTokens) return null; // not enough new history yet

    // Smallest prefix with total >= chunkTokens (never splits a message).
    let acc = 0;
    let end = 0;
    for (let i = 0; i < fresh.length; i++) {
      const m = fresh[i]!;
      acc += this.tokensOf(m);
      end = i + 1;
      if (acc >= chunkTokens) break;
    }
    const slice = fresh.slice(0, end);
    const coversUpToId = slice[slice.length - 1]!.id;

    // Overlap: tail of history BEFORE the slice, up to overlapTokens.
    const overlapTokens = this.opts.overlapTokens ?? 0;
    let overlapContext = '';
    if (overlapTokens > 0 && startIdx > 0) {
      let acc = 0;
      let begin = 0;
      for (let i = startIdx - 1; i >= 0; i--) {
        const t = this.tokensOf(messages[i]!);
        if (acc + t > overlapTokens && begin < startIdx - 1) break;
        acc += t;
        begin = i;
      }
      overlapContext = messages.slice(begin, startIdx).map((m) => m.text).join('\n');
    }

    const text = slice.map((m) => m.text).join('\n');
    return {
      text,
      overlapContext,
      coversUpToId,
      tokens: slice.reduce((s, m) => s + this.tokensOf(m), 0),
    };
  }
}
