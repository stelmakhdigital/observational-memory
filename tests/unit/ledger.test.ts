import { describe, expect, it } from 'vitest';
import { foldPool, oldestAbove } from '../../src/core/ledger/pool.js';
import { compareObsIds, progressOf } from '../../src/core/ledger/progress.js';
import { nextObsSeqAt } from '../../src/core/ids.js';
import type { Observation, TypedLedgerEntry } from '../../src/core/types.js';

const obs = (id: string, coversUpToId: string, tokenCount = 10): Observation => ({
  id,
  coversUpToId,
  content: `note ${id}`,
  tokenCount,
  createdAt: '2025-09-21T00:00:00Z',
});
const oEntry = (o: Observation): TypedLedgerEntry<'om.observation'> => ({
  type: 'om.observation',
  data: o,
  at: '2025-09-21T00:00:00Z',
});
const oEntryRun = (
  o: Observation,
  runId: string,
  sourceRange?: { fromId: string; toId: string },
): TypedLedgerEntry<'om.observation'> => ({
  type: 'om.observation',
  data: sourceRange ? { ...o, sourceRange } : o,
  at: '2025-09-21T00:00:00Z',
  meta: { runId },
});
const tEntry = (
  ids: string[],
  runId?: string,
): TypedLedgerEntry<'om.tombstone'> => ({
  type: 'om.tombstone',
  data: { observationIds: ids, topics: ['topic-a'], journeyChanged: true },
  at: '2025-09-21T00:01:00Z',
  meta: runId ? { runId } : undefined,
});

describe('foldPool', () => {
  it('folds observations and applies tombstones (dedupe by id)', () => {
    const obsIn = [oEntry(obs('om-1', 'm1', 5)), oEntry(obs('om-2', 'm2', 7)), oEntry(obs('om-1', 'm1', 5))];
    const pool = foldPool(obsIn, [tEntry(['om-1'])]);
    expect(pool.observations.map((o) => o.id)).toEqual(['om-2']);
    expect(pool.tokens).toBe(7);
    expect(pool.tombstoned.get('om-1')?.at).toBe('2025-09-21T00:01:00Z');
  });

  it('attributes tombstones to the run', () => {
    const pool = foldPool([oEntry(obs('om-1', 'm1'))], [tEntry(['om-1'], 'run-abc')]);
    expect(pool.tombstoned.get('om-1')?.by).toBe('run-abc');
  });

  it('empty pool', () => {
    const pool = foldPool([], []);
    expect(pool.observations).toEqual([]);
    expect(pool.tokens).toBe(0);
  });

  describe('n9: /tree re-observe supersedes the previous run of the same slice', () => {
    const slice = { fromId: 'm1', toId: 'm2' };

    it('re-observe of the same slice (same fromId, new run, fresh ids) keeps only the new set', () => {
      const run1 = [
        oEntryRun(obs('om-1', 'm2'), 'run-1', slice),
        oEntryRun(obs('om-2', 'm2'), 'run-1', slice),
      ];
      const run2 = [oEntryRun(obs('om-3', 'm2'), 'run-2', slice)];
      const pool = foldPool([...run1, ...run2], []);
      expect(pool.observations.map((o) => o.id)).toEqual(['om-3']);
      expect(pool.tokens).toBe(10);
    });

    it('same-run siblings (one commit = several observations, same fromId) are not evicted', () => {
      const pool = foldPool(
        [
          oEntryRun(obs('om-1', 'm2'), 'run-1', slice),
          oEntryRun(obs('om-2', 'm2'), 'run-1', slice),
          oEntryRun(obs('om-3', 'm2'), 'run-1', slice),
        ],
        [],
      );
      expect(pool.observations.map((o) => o.id)).toEqual(['om-1', 'om-2', 'om-3']);
    });

    it('different slices (different fromId) are never evicted', () => {
      const pool = foldPool(
        [
          oEntryRun(obs('om-1', 'm2'), 'run-1', slice),
          oEntryRun(obs('om-2', 'm4'), 'run-2', { fromId: 'm3', toId: 'm4' }),
        ],
        [],
      );
      expect(pool.observations.map((o) => o.id)).toEqual(['om-1', 'om-2']);
    });

    it('supersession composes with tombstones and id-dedupe', () => {
      const pool = foldPool(
        [
          oEntryRun(obs('om-1', 'm2'), 'run-1', slice),
          oEntryRun(obs('om-3', 'm2'), 'run-2', slice),
          oEntry(obs('om-3', 'm2')), // id-dedupe still applies
        ],
        [tEntry(['om-3'])],
      );
      // om-1 superseded, om-3 tombstoned → empty
      expect(pool.observations).toEqual([]);
      expect(pool.tombstoned.has('om-3')).toBe(true);
    });

    it('legacy observations (no sourceRange/runId) keep id-only dedupe', () => {
      const pool = foldPool([oEntry(obs('om-1', 'm2')), oEntry(obs('om-2', 'm3'))], []);
      expect(pool.observations.map((o) => o.id)).toEqual(['om-1', 'om-2']);
    });
  });
});

describe('oldestAbove', () => {
  it('takes oldest observations up to maxTokens', () => {
    const pool = foldPool(
      [oEntry(obs('om-1', 'm1', 6)), oEntry(obs('om-2', 'm2', 6)), oEntry(obs('om-3', 'm3', 6))],
      [],
    );
    const r = oldestAbove(pool, 10);
    expect(r.ids).toEqual(['om-1', 'om-2']);
    expect(r.tokens).toBe(12);
  });
});

describe('progress', () => {
  it('compareObsIds orders by (seq, time); malformed sort after well-formed', () => {
    expect(compareObsIds('om-20250921000000-1', 'om-20250921000000-2')).toBeLessThan(0);
    // same seq, later second sorts later
    expect(compareObsIds('om-20250921000001-1', 'om-20250921000000-1')).toBeGreaterThan(0);
    expect(compareObsIds('zzz', 'om-20250921000000-1')).toBeGreaterThan(0); // malformed sorts last
  });

  it('watermark = max coversUpToId, out-of-order safe', () => {
    const a = obs('om-20250921000000-1', 'm1');
    const b = obs('om-20250921000000-3', 'm5'); // older slice, committed late
    const c = obs('om-20250921000000-2', 'm3');
    // late older chunk (b) must not regress the watermark below m5
    const p = progressOf([a, c], [b]);
    expect(p.coversUpToId).toBe('m5');
    expect(p.maxSeq).toBe(3);
  });

  it('watermark survives tombstones (consolidated history is still processed)', () => {
    const a = obs('om-20250921000000-1', 'm1');
    const p = progressOf([], [a]);
    expect(p.coversUpToId).toBe('m1'); // watermark is the MESSAGE id
    expect(p.maxSeq).toBe(1);
  });
});

describe('nextObsSeqAt', () => {
  it('scopes seq to the second', () => {
    const committed = ['om-20250921000000-1', 'om-20250921000000-3', 'om-20250921000001-7'];
    expect(nextObsSeqAt(committed, '20250921000000')).toBe(3);
    expect(nextObsSeqAt(committed, '20250921000001')).toBe(7);
    expect(nextObsSeqAt(committed, '20250921000002')).toBe(0); // new second
  });
});
