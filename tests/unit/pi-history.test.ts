import { describe, expect, it } from 'vitest';
import {
  entryIdOf,
  firstBranchEntryIdAfter,
  messageText,
  PiHistorySource,
  positionalId,
} from '../../src/adapters/pi/history.js';
import { progressOf } from '../../src/core/ledger/progress.js';
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

  it('maps branch entries to messages with positional, orderable ids', () => {
    const msgs = src.messages();
    expect(msgs.map((m) => m.id)).toEqual([
      'p00000000:e1',
      'p00000001:e2',
      'p00000002:e3',
      'p00000003:e4',
    ]);
  });

  it('nextChunk respects the watermark', () => {
    // since e2: fresh = e3+e4 = 2*T2 = 8 ≥ budget (T1+T2 = 7) →
    // e3 alone (4) < 7, e3+e4 (8) ≥ 7 → boundary e4
    const c2 = src.nextChunk({ coversUpToId: 'p00000001:e2'});
    expect(c2?.coversUpToId).toBe('p00000003:e4');
    // since e3: fresh = T2 (4) < budget (7) → null
    expect(src.nextChunk({ coversUpToId: 'p00000002:e3'})).toBeNull();
    // from the start: e1+e2 = T1+T2 = 7 ≥ budget → boundary e2
    const c3 = src.nextChunk({ coversUpToId: ''});
    expect(c3?.coversUpToId).toBe('p00000001:e2');
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
    expect(src.tailStartIdFor(2 * T2)).toBe('p00000001:e2');
    // window covers everything → ''
    expect(src.tailStartIdFor(TOTAL)).toBe('');
    // window smaller than one message → boundary e3 (e4 kept whole)
    expect(src.tailStartIdFor(T1)).toBe('p00000002:e3');
  });

  it('tailVerbatim returns newest messages within budget', () => {
    // history text includes the role prefix (messageText)
    const line = messageText({ role: 'user', content: t2 } as never);
    expect(src.tailVerbatim('p00000001:e2', 2 * T2)).toBe(`${line}\n${line}`);
    expect(src.tailVerbatim('', 2 * T2)).toBe(`${line}\n${line}`);
  });

  it('unobservedTokens counts after the watermark', () => {
    expect(src.unobservedTokens('p00000001:e2')).toBe(2 * T2);
    expect(src.unobservedTokens('p00000003:e4')).toBe(0);
    // legacy bare-hex watermark (pre-positional-id ledger) resolves via suffix
    expect(src.unobservedTokens('e2')).toBe(2 * T2);
    expect(src.unobservedTokens('unknown')).toBe(TOTAL); // rollback-safe
  });

  it('lastMessageAt is the newest message timestamp', () => {
    expect(src.lastMessageAt()?.toISOString()).toBe('2025-09-21T10:00:00.000Z');
  });

  it('lastTwoMessageAts returns [lastAt, prevAt] from the branch tail (R2)', () => {
    expect(src.lastTwoMessageAts()).toEqual([
      new Date('2025-09-21T10:00:00Z'),
      new Date('2025-09-21T10:00:00Z'),
    ]);
  });

  it('lastTwoMessageAts: single message → prevAt is null', () => {
    const s1 = new PiHistorySource(
      () => makeCtx([m1]).sessionManager,
      () => makeCtx([m1], 500),
      { chunkTokens: 10 },
    );
    const [last, prev] = s1.lastTwoMessageAts();
    expect(last?.toISOString()).toBe('2025-09-21T10:00:00.000Z');
    expect(prev).toBeNull();
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
      expect(ids).toEqual(['p00000000:b1', 'p00000001:b2', 'p00000002:b3']);
      expect(srcB.messages().map((m) => m.text).join(' ')).not.toContain('DEAD BRANCH TEXT');
    });

    it('dead-branch messages do not enter chunks or the tail', () => {
      // budget T1+T2: first chunk = b1+b2 (boundary b2), nothing after that
      const first = srcB.nextChunk({ coversUpToId: ''});
      expect(first).not.toBeNull();
      expect(first!.coversUpToId).toBe('p00000001:b2');
      expect(first!.text).not.toContain('DEAD BRANCH TEXT');
      const second = srcB.nextChunk({ coversUpToId: 'p00000001:b2'});
      expect(second).toBeNull(); // nothing beyond the branch leaf
      expect(srcB.tailVerbatim('', 10 * T2)).not.toContain('DEAD BRANCH TEXT');
      expect(srcB.tailVerbatim('unknown', 10 * T2)).not.toContain('DEAD BRANCH TEXT');
      expect(srcB.unobservedTokens('unknown')).toBe(T1 + 2 * T2); // branch only
    });

    it('lastMessageAt ignores dead-branch messages', () => {
      expect(srcB.lastMessageAt()?.toISOString()).toBe('2025-09-21T11:00:00.000Z');
    });

    it('lastTwoMessageAts reads the branch tail, ignoring dead branches (R2)', () => {
      // branch: b1(10:00), b2(10:00), b3(11:00); dead b4(10:30) must be skipped
      const [last, prev] = srcB.lastTwoMessageAts();
      expect(last?.toISOString()).toBe('2025-09-21T11:00:00.000Z');
      expect(prev?.toISOString()).toBe('2025-09-21T10:00:00.000Z');
    });

    it('watermark from a dead branch rolls back to the start of the branch', () => {
      // b4 exists in the file but not in the branch → indexAfter → 0
      expect(srcB.unobservedTokens('b4')).toBe(T1 + 2 * T2);
      expect(srcB.tailStartIdFor(10 * T2)).toBe('');
      // n9 precondition: re-observe from scratch picks up the whole branch
      const chunk = srcB.nextChunk({ coversUpToId: 'b4'});
      expect(chunk).not.toBeNull();
      expect(chunk!.fromId).toBe('p00000000:b1');
      expect(chunk!.text).not.toContain('DEAD BRANCH TEXT');
    });
  });

  // A13: indexAfter searches from the TAIL first (watermarks usually point
  // near the newest covered chunk) with a full-pass fallback.
  describe('A13: indexAfter on a 2000-message branch', () => {
    const N = 2000;
    const many: PiEntry[] = Array.from({ length: N }, (_, i) => msg(`m${i}`, 'same same same same'));
    const src2 = new PiHistorySource(
      () => makeCtx(many).sessionManager,
      () => makeCtx(many, null),
      { chunkTokens: 10_000 },
    );
    const T = src2.messages()[0]!.tokens ?? 0;
    it('watermark near the tail (fast path) counts the rest', () => {
      expect(src2.unobservedTokens('p00001997:m1997')).toBe(2 * T);
      expect(src2.unobservedTokens('p00001998:m1998')).toBe(T);
      expect(src2.unobservedTokens('p00001999:m1999')).toBe(0);
      expect(src2.unobservedTokens('')).toBe(N * T);
    });
    it('watermark at the head (slow path) still resolves correctly', () => {
      expect(src2.unobservedTokens('p00000000:m0')).toBe((N - 1) * T);
      expect(src2.unobservedTokens('p00000049:m49')).toBe((N - 50) * T); // outside the tail-50 window
    });
    it('unknown watermark rolls back to the start (rollback-safe)', () => {
      expect(src2.unobservedTokens('dead-branch-id')).toBe(N * T);
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
      // positional boundary resolves to the same successor
      expect(firstBranchEntryIdAfter(s, 'p00000000:b1', 'fb')).toBe('b2');
      // b3 is the branch leaf; the file successor b4 (dead branch) must be ignored
      expect(firstBranchEntryIdAfter(s, 'b3', 'fb')).toBe('fb');
    });

    it('falls back for empty/unknown boundaries', () => {
      const s = sm([a, b, c], [a, b, c, d]);
      expect(firstBranchEntryIdAfter(s, '', 'fb')).toBe('fb');
      expect(firstBranchEntryIdAfter(s, 'b4', 'fb')).toBe('fb'); // dead branch id not on branch
      expect(firstBranchEntryIdAfter(s, 'p00000000:zzz', 'fb')).toBe('fb');
    });
  });
});

describe('positional ids (pi 0.87.x entry ids are random hex, not orderable)', () => {
  const obs = (coversUpToId: string) =>
    ({ id: 'o1', coversUpToId, content: 'x', tokenCount: 1, createdAt: 't' }) as never;

  it('entryIdOf strips the positional prefix, passes legacy ids through', () => {
    expect(entryIdOf('p00000001:e2')).toBe('e2');
    expect(entryIdOf('e2')).toBe('e2');
  });

  it('watermark max follows branch order, not lexicographic hex order', () => {
    // pi entry ids in REVERSE lexicographic order: 'f0…' is OLDER than '01…'
    const entries: PiEntry[] = [
      msg('f0000001', 'old message one', 'user'),
      msg('01000002', 'newer message two', 'user'),
      msg('00000003', 'newest message three', 'user'),
    ];
    const src = new PiHistorySource(
      () => makeCtx(entries).sessionManager,
      () => makeCtx(entries, null),
      { chunkTokens: 100 },
    );
    const [a, b, c] = src.messages().map((m) => m.id) as [string, string, string];
    // positional order == branch order despite random hex entry ids
    expect(a < b && b < c).toBe(true);
    // out-of-order commits (R4): the later slice commits first, the older one
    // late — progress must keep the NEWEST coverage, not the lexicographic max
    expect(progressOf([obs(c)], [obs(a)]).coversUpToId).toBe(c);
    expect(progressOf([obs(a)], [obs(c)]).coversUpToId).toBe(c);
    // legacy bare-hex id always reads as OLDER than any positional id
    expect(progressOf([obs('f0000001')], [obs(b)]).coversUpToId).toBe(b);
  });
});
