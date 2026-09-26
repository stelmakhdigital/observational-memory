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

/**
 * Id of the first entry AFTER `boundary` within the CURRENT branch only
 * (C1: getEntries() spans all branches and would pick a successor from a
 * dead branch). getBranch() walks leaf→root and reverses, so the successor
 * is the next element. Returns `fallback` when the boundary is not on the
 * branch or is its last entry.
 */
export function firstBranchEntryIdAfter(
  sessionManager: PiSessionManager,
  boundary: string,
  fallback: string,
): string {
  if (boundary === '') return fallback;
  const branch: PiEntry[] = sessionManager.getBranch();
  const idx = branch.findIndex((e) => e.id === boundary);
  if (idx === -1) return fallback;
  return branch[idx + 1]?.id ?? fallback;
}

/**
 * Extract a readable text from a pi message (AgentMessage-like).
 * opts.attachments (v0.7): 'auto' (default) renders non-text parts as named
 * placeholders; 'off' omits them. Unknown shapes degrade to a compact JSON
 * placeholder so observations never crash the master.
 */
export function messageText(
  message: PiEntry['message'],
  opts: { attachments?: 'auto' | 'off' } = {},
): string {
  const attachments = opts.attachments ?? 'auto';
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
            const part = p as { type?: string; text?: string; name?: string; label?: string; filename?: string };
            if (part.type === 'text' && typeof part.text === 'string') return part.text;
            if (part.type === 'image') {
              if (attachments === 'off') return '';
              const nm = part.name ?? part.label ?? part.filename;
              return nm ? `[image: ${nm}]` : '[image]';
            }
            if (part.type === 'file') {
              if (attachments === 'off') return '';
              const nm = part.name ?? part.label ?? part.filename;
              return nm ? `[file: ${nm}]` : '[file]';
            }
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
  /** v0.7: attachment observation mode (default 'auto'). */
  attachments?: 'auto' | 'off';
}

export class PiHistorySource implements HistorySource {
  private readonly chunker: MessageChunker;
  private readonly attachments: 'auto' | 'off';

  constructor(
    private readonly sessionManager: () => PiSessionManager,
    private readonly ctx: () => PiContext,
    opts: PiHistoryOptions,
  ) {
    this.chunker = new MessageChunker({
      chunkTokens: opts.chunkTokens,
      overlapTokens: opts.chunkOverlapTokens ?? 0,
    });
    this.attachments = opts.attachments ?? 'auto';
  }

  /** Current branch as OmMessage[] (ascending, entry ids preserved). */
  messages(): OmMessage[] {
    const entries = this.sessionManager().getBranch();
    const out: OmMessage[] = [];
    for (const e of entries) {
      if (e.type !== 'message' || !e.message) continue;
      const text = messageText(e.message, { attachments: this.attachments });
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
    const entries = this.sessionManager().getBranch();
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e?.type === 'message') return new Date(e.timestamp);
    }
    return null;
  }
}
