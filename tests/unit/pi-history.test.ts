import { describe, expect, it } from 'vitest';
import { PiHistorySource, messageText } from '../../src/adapters/pi/history.js';
import { estimateTokens } from '../../src/core/tokens.js';
import type { PiContext, PiEntry } from '../../src/adapters/pi/types.js';

const msg = (id: string, text: string, role = 'user', ts = '2025-09-21T10:00:00Z'): PiEntry => ({
  type: 'message',
  id,
  parentId: null,
  timestamp: ts,
  message: { role, content: text },
});

function makeCtx(entries: PiEntry[], tokens: number | null = 500, idle = true): PiContext {
  return {
    ui: { setStatus: () => {}, notify: () => {}, setWidget: () => {} },
    hasUI: true,
    cwd: '/tmp',
    sessionManager: {
      getEntries: () => entries,
      getBranch: () => entries,
      getSessionId: () => 's',
      getHeader: () => ({ id: 's', cwd: '/tmp', timestamp: 't' }),
    },
    isIdle: () => idle,
    getContextUsage: () => (tokens === null ? undefined : { tokens, contextWindow: 1000, percent: 50 }),
    compact: () => {},
  } as unknown as PiContext;
}

describe('messageText', () => {
  it('extracts user text', () => {
    expect(messageText({ role: 'user', content: 'hi' } as never)).toBe('user: hi');
  });
  it('extracts content parts', () => {
    const t = messageText({
      role: 'assistant',
      content: [
        { type: 'text', text: 'did X' },
        { type: 'image' },
        { type: 'toolCall', name: 'bash' },
      ],
    } as never);
    expect(t).toContain('did X');
    expect(t).toContain('[image]');
    expect(t).toContain('[tool: bash]');
  });

  it('attachment gates (v0.7): named placeholders in auto mode, omitted in off mode', () => {
    const content = [
      { type: 'text', text: 'look at the mockup' },
      { type: 'image', name: 'board.png' },
      { type: 'file', name: 'spec.pdf' },
    ];
    const auto = messageText({ role: 'user', content } as never, { attachments: 'auto' });
    expect(auto).toContain('[image: board.png]');
    expect(auto).toContain('[file: spec.pdf]');
    const off = messageText({ role: 'user', content } as never, { attachments: 'off' });
    expect(off).toBe('user: look at the mockup');
    // anonymous attachments degrade to bare placeholders in auto mode
    const anon = messageText({ role: 'user', content: [{ type: 'image' }] } as never);
    expect(anon).toContain('[image]');
  });
  it('handles tool results', () => {
    expect(messageText({ role: 'toolResult', toolName: 'bash', content: 'ok' } as never)).toBe(
      '[tool result: bash] ok',
    );
  });
});

describe('PiHistorySource', () => {
  const t1 = 'a b';
  const t2 = 'a b c d';
  // token counts of the ACTUAL history text (role prefix included)
  const T1 = estimateTokens(messageText({ role: 'user', content: t1 } as never));
  const T2 = estimateTokens(messageText({ role: 'user', content: t2 } as never));
  const TOTAL = T1 + 3 * T2;

  const m1 = msg('e1', t1, 'user');
  const m2 = msg('e2', t2, 'user');
  const m3 = msg('e3', t2, 'user');
  const m4 = msg('e4', t2, 'user');
  const entries = [m1, m2, m3, m4];
  const src = new PiHistorySource(
    () => makeCtx(entries).sessionManager,
    () => makeCtx(entries, 500),
    { chunkTokens: T1 + T2 },
  );

  it('maps branch entries to messages preserving entry ids', () => {
    const msgs = src.messages();
    expect(msgs.map((m) => m.id)).toEqual(['e1', 'e2', 'e3', 'e4']);
  });

  it('nextChunk respects the watermark', () => {
    // since e2: fresh = e3+e4 = 2*T2 = 8 ≥ budget (T1+T2 = 7) →
    // e3 alone (4) < 7, e3+e4 (8) ≥ 7 → boundary e4
    const c2 = src.nextChunk({ coversUpToId: 'e2', observedTokens: T1 });
    expect(c2?.coversUpToId).toBe('e4');
    // since e3: fresh = T2 (4) < budget (7) → null
    expect(src.nextChunk({ coversUpToId: 'e3', observedTokens: T1 + T2 })).toBeNull();
    // from the start: e1+e2 = T1+T2 = 7 ≥ budget → boundary e2
    const c3 = src.nextChunk({ coversUpToId: '', observedTokens: 0 });
    expect(c3?.coversUpToId).toBe('e2');
  });

  it('currentTokens prefers ctx usage, falls back to estimate', () => {
    expect(src.currentTokens()).toBe(500);
    const noUsage = new PiHistorySource(
      () => makeCtx(entries, null).sessionManager,
      () => makeCtx(entries, null),
      { chunkTokens: T1 + T2 },
    );
    expect(noUsage.currentTokens()).toBe(TOTAL);
  });

  it('tailStartIdFor returns the boundary (last excluded)', () => {
    // window 2*T2: newest e4+e3 fit, e2 would exceed → boundary e2
    expect(src.tailStartIdFor(2 * T2)).toBe('e2');
    // window covers everything → ''
    expect(src.tailStartIdFor(TOTAL)).toBe('');
    // window smaller than one message → boundary e3 (e4 kept whole)
    expect(src.tailStartIdFor(T1)).toBe('e3');
  });

  it('tailVerbatim returns newest messages within budget', () => {
    // history text includes the role prefix (messageText)
    const line = messageText({ role: 'user', content: t2 } as never);
    expect(src.tailVerbatim('e2', 2 * T2)).toBe(`${line}\n${line}`);
    expect(src.tailVerbatim('', 2 * T2)).toBe(`${line}\n${line}`);
  });

  it('unobservedTokens counts after the watermark', () => {
    expect(src.unobservedTokens('e2')).toBe(2 * T2);
    expect(src.unobservedTokens('e4')).toBe(0);
    expect(src.unobservedTokens('unknown')).toBe(TOTAL); // rollback-safe
  });

  it('lastMessageAt is the newest message timestamp', () => {
    expect(src.lastMessageAt()?.toISOString()).toBe('2025-09-21T10:00:00.000Z');
  });
});
