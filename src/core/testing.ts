/**
 * DemoHistory: a minimal in-memory HistorySource for embedded hosts, eval
 * fixtures and examples (no pi, no fs). Message ids are `h<index>` —
 * zero-padded index keeps lexicographic order = chronological order.
 */
import { MessageChunker, type OmMessage } from './chunker.js';
import { estimateTokens } from './tokens.js';
import type { HistorySource, Watermark } from './types.js';

export interface DemoHistoryOptions {
  /** Observer chunk size in tokens (default 2000). */
  chunkTokens?: number;
  overlapTokens?: number;
}

export class DemoHistory implements HistorySource {
  messages: OmMessage[] = [];
  lastAt: Date = new Date();
  private readonly chunker: MessageChunker;

  constructor(opts: DemoHistoryOptions = {}) {
    this.chunker = new MessageChunker({
      chunkTokens: opts.chunkTokens ?? 2000,
      overlapTokens: opts.overlapTokens ?? 0,
    });
  }

  /** Append a message with an auto id; returns the id. */
  add(text: string): string {
    const id = `h${String(this.messages.length).padStart(6, '0')}`;
    this.messages.push({ id, text, tokens: estimateTokens(text) });
    this.lastAt = new Date();
    return id;
  }

  nextChunk(since: Watermark, opts?: { minTokens?: number }) {
    return this.chunker.next(this.messages, since, opts);
  }

  currentTokens(): number {
    return this.messages.reduce((s, m) => s + (m.tokens ?? 0), 0);
  }

  unobservedTokens(sinceId: string): number {
    const idx = this.messages.findIndex((m) => m.id === sinceId);
    const start = idx === -1 ? 0 : idx + 1;
    return this.messages.slice(start).reduce((s, m) => s + (m.tokens ?? 0), 0);
  }

  isIdle(): boolean {
    return true;
  }

  tailVerbatim(sinceId: string, maxTokens: number): string {
    const idx = this.messages.findIndex((m) => m.id === sinceId);
    const tail = this.messages.slice(idx === -1 ? 0 : idx + 1);
    let acc = 0;
    let begin = 0;
    for (let i = tail.length - 1; i >= 0; i--) {
      const t = tail[i]!.tokens ?? 0;
      if (acc > 0 && acc + t > maxTokens) break;
      acc += t;
      begin = i;
    }
    return tail.slice(begin).map((m) => m.text).join('\n');
  }

  tailStartIdFor(maxTokens: number): string {
    let acc = 0;
    let firstIncluded = this.messages.length;
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const t = this.messages[i]!.tokens ?? 0;
      if (acc > 0 && acc + t > maxTokens) break;
      acc += t;
      firstIncluded = i;
    }
    return firstIncluded === 0 ? '' : this.messages[firstIncluded - 1]!.id;
  }

  lastMessageAt(): Date | null {
    return this.messages.length > 0 ? this.lastAt : null;
  }
}
