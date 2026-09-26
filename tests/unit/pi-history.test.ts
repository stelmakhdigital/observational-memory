import { describe, expect, it } from 'vitest';
import {
  firstBranchEntryIdAfter,
  messageText,
  PiHistorySource,
} from '../../src/adapters/pi/history.js';
import { estimateTokens } from '../../src/core/tokens.js';
import type { PiContext, PiEntry, PiSessionManager } from '../../src/adapters/pi/types.js';

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

  describe('branching (C1: getBranch, not getEntries)', () => {
    // Tree: a — b — c (live) and b — d (dead branch, switched away via /tree).
    const a = msg('b1', t1, 'user');
    const b = msg('b2', t2, 'user');
    const c = msg('b3', t2, 'user', '2025-09-21T11:00:00Z');
    const d = msg('b4', 'DEAD BRANCH TEXT', 'user', '2025-09-21T10:30:00Z');
    // full file (append order, both branches) vs current branch only
    const all = [a, b, d, c];
    const branch = [a, b, c];
    const sm: PiSessionManager = {
      getEntries: () => all,
      getBranch: () => branch,
      getSessionId: () => 's',
      getHeader: () => ({ id: 's', cwd: '/tmp', timestamp: 't' }),
    };
    const ctx = makeCtx(branch) as PiContext;
    const srcB = new PiHistorySource(
      () => sm,
      () => ({ ...ctx, sessionManager: sm, getContextUsage: () => undefined }),
      { chunkTokens: T1 + T2 },
    );

    it('messages() returns only the current branch (ascending)', () => {
      const ids = srcB.messages().map((m) => m.id);
      expect(ids).toEqual(['b1', 'b2', 'b3']);
      expect(srcB.messages().map((m) => m.text).join(' ')).not.toContain('DEAD BRANCH TEXT');
    });

    it('dead-branch messages do not enter chunks or the tail', () => {
      // budget T1+T2: first chunk = b1+b2 (boundary b2), nothing after that
      const first = srcB.nextChunk({ coversUpToId: '', observedTokens: 0 });
      expect(first).not.toBeNull();
      expect(first!.coversUpToId).toBe('b2');
      expect(first!.text).not.toContain('DEAD BRANCH TEXT');
      const second = srcB.nextChunk({ coversUpToId: 'b2', observedTokens: T1 });
      expect(second).toBeNull(); // nothing beyond the branch leaf
      expect(srcB.tailVerbatim('', 10 * T2)).not.toContain('DEAD BRANCH TEXT');
      expect(srcB.tailVerbatim('unknown', 10 * T2)).not.toContain('DEAD BRANCH TEXT');
      expect(srcB.unobservedTokens('unknown')).toBe(T1 + 2 * T2); // branch only
    });

    it('lastMessageAt ignores dead-branch messages', () => {
      expect(srcB.lastMessageAt()?.toISOString()).toBe('2025-09-21T11:00:00.000Z');
    });

    it('watermark from a dead branch rolls back to the start of the branch', () => {
      // b4 exists in the file but not in the branch → indexAfter → 0
      expect(srcB.unobservedTokens('b4')).toBe(T1 + 2 * T2);
      expect(srcB.tailStartIdFor(10 * T2)).toBe('');
      // n9 precondition: re-observe from scratch picks up the whole branch
      const chunk = srcB.nextChunk({ coversUpToId: 'b4', observedTokens: 0 });
      expect(chunk).not.toBeNull();
      expect(chunk!.fromId).toBe('b1');
      expect(chunk!.text).not.toContain('DEAD BRANCH TEXT');
    });
  });

  describe('firstBranchEntryIdAfter (C1: firstKeptEntryId within the branch)', () => {
    const sm = (branch: PiEntry[], all?: PiEntry[]): PiSessionManager => ({
      getEntries: () => all ?? branch,
      getBranch: () => branch,
      getSessionId: () => 's',
      getHeader: () => ({ id: 's', cwd: '/tmp', timestamp: 't' }),
    });
    const a = msg('b1', t1);
    const b = msg('b2', t2);
    const c = msg('b3', t2);
    const d = msg('b4', t2); // dead branch entry appended after c in the file

    it('returns the next entry of the CURRENT branch, not the file', () => {
      const s = sm([a, b, c], [a, b, c, d]);
      expect(firstBranchEntryIdAfter(s, 'b1', 'fb')).toBe('b2');
      // b3 is the branch leaf; the file successor b4 (dead branch) must be ignored
      expect(firstBranchEntryIdAfter(s, 'b3', 'fb')).toBe('fb');
    });

    it('falls back for empty/unknown boundaries', () => {
      const s = sm([a, b, c], [a, b, c, d]);
      expect(firstBranchEntryIdAfter(s, '', 'fb')).toBe('fb');
      expect(firstBranchEntryIdAfter(s, 'b4', 'fb')).toBe('fb'); // dead branch id not on branch
    });
  });
});
