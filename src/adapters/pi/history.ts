/**
 * PiHistorySource: maps pi session entries onto the core HistorySource seam.
 *
 * Message ids are the session entry ids (uuidv7 — millisecond-prefixed, so
 * lexicographic order equals chronological order, satisfying the watermark
 * comparability contract in ledger/progress.ts).
 *
 * Entry → text extraction is defensive (roles/content shapes vary across pi
 * versions); unknown shapes degrade to a compact JSON placeholder so
 * observations never crash the master.
 */
import { MessageChunker, type OmMessage } from '../../core/chunker.js';
import { estimateTokens } from '../../core/tokens.js';
import type { HistorySource, Watermark } from '../../core/types.js';
import type { PiContext, PiEntry, PiSessionManager } from './types.js';

/** Extract a readable text from a pi message (AgentMessage-like). */
export function messageText(message: PiEntry['message']): string {
  if (!message || typeof message !== 'object') return '';
  const { role, content, toolName } = message as {
    role: string;
    content: unknown;
    toolName?: string;
  };
  const textOf = (c: unknown): string => {
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) {
      return c
        .map((p) => {
          if (typeof p === 'string') return p;
          if (p && typeof p === 'object') {
            const part = p as { type?: string; text?: string; name?: string };
            if (part.type === 'text' && typeof part.text === 'string') return part.text;
            if (part.type === 'image') return '[image]';
            if (part.type === 'toolCall' && part.name) return `[tool: ${part.name}]`;
          }
          return '';
        })
        .filter(Boolean)
        .join(' ');
    }
    return '';
  };
  if (role === 'toolResult') {
    return `[tool result: ${toolName ?? 'tool'}] ${textOf(content)}`.trim();
  }
  return `${role}: ${textOf(content)}`.trim();
}

export interface PiHistoryOptions {
  chunkTokens: number;
  chunkOverlapTokens?: number;
}

export class PiHistorySource implements HistorySource {
  private readonly chunker: MessageChunker;

  constructor(
    private readonly sessionManager: () => PiSessionManager,
    private readonly ctx: () => PiContext,
    opts: PiHistoryOptions,
  ) {
    this.chunker = new MessageChunker({
      chunkTokens: opts.chunkTokens,
      overlapTokens: opts.chunkOverlapTokens ?? 0,
    });
  }

  /** Current branch as OmMessage[] (ascending, entry ids preserved). */
  messages(): OmMessage[] {
    const entries = this.sessionManager().getEntries();
    const out: OmMessage[] = [];
    for (const e of entries) {
      if (e.type !== 'message' || !e.message) continue;
      const text = messageText(e.message);
      if (!text) continue;
      out.push({ id: e.id, text, tokens: estimateTokens(text) });
    }
    return out;
  }

  private indexAfter(sinceId: string): number {
    if (sinceId === '') return 0;
    const msgs = this.messages();
    let idx = -1;
    for (let i = 0; i < msgs.length; i++) {
      if (msgs[i]!.id === sinceId) idx = i;
    }
    return idx === -1 ? 0 : idx + 1;
  }

  nextChunk(since: Watermark, opts?: { minTokens?: number }) {
    return this.chunker.next(this.messages(), since, opts);
  }

  currentTokens(): number {
    const usage = this.ctx().getContextUsage();
    if (usage?.tokens !== null && usage?.tokens !== undefined) return usage.tokens;
    // Fallback: estimate from branch messages.
    return this.messages().reduce((s, m) => s + (m.tokens ?? 0), 0);
  }

  unobservedTokens(sinceId: string): number {
    const msgs = this.messages();
    const start = this.indexAfter(sinceId);
    return msgs.slice(start).reduce((s, m) => s + (m.tokens ?? 0), 0);
  }

  isIdle(): boolean {
    return this.ctx().isIdle();
  }

  tailVerbatim(sinceId: string, maxTokens: number): string {
    const msgs = this.messages();
    const start = this.indexAfter(sinceId);
    const tail = msgs.slice(start);
    // Keep newest messages up to maxTokens (never split a message).
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

  /** Boundary (last excluded message id); '' when the whole history fits. */
  tailStartIdFor(maxTokens: number): string {
    const msgs = this.messages();
    let acc = 0;
    let firstIncluded = msgs.length;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const t = msgs[i]!.tokens ?? 0;
      if (acc > 0 && acc + t > maxTokens) break;
      acc += t;
      firstIncluded = i;
    }
    if (firstIncluded === 0) return '';
    return msgs[firstIncluded - 1]!.id;
  }

  lastMessageAt(): Date | null {
    const entries = this.sessionManager().getEntries();
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e?.type === 'message') return new Date(e.timestamp);
    }
    return null;
  }
}
