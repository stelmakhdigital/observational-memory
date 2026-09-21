import { describe, expect, it } from 'vitest';
import { PiLedgerStore, OM_CUSTOM_TYPE } from '../../src/adapters/pi/ledger.js';
import type { Observation } from '../../src/core/types.js';
import type { PiEntry } from '../../src/adapters/pi/types.js';

const obs: Observation = {
  id: 'om-20250921000000-1',
  coversUpToId: 'm1',
  content: 'note',
  tokenCount: 3,
  createdAt: '2025-09-21T00:00:00Z',
};

function makeStore(entries: PiEntry[]) {
  const appended: unknown[] = [];
  const store = new PiLedgerStore(
    (d) => appended.push(d),
    () => entries,
  );
  return { store, appended };
}

const omEntry = (data: unknown): PiEntry => ({
  type: 'custom',
  id: 'x',
  parentId: null,
  timestamp: '2025-09-21T00:00:00Z',
  customType: OM_CUSTOM_TYPE,
  data,
});

describe('PiLedgerStore', () => {
  it('appends via the provided append fn with the full envelope', () => {
    const { store, appended } = makeStore([]);
    store.append({ type: 'om.observation', data: obs, at: 't' });
    expect(appended).toEqual([{ type: 'om.observation', data: obs, at: 't', meta: undefined }]);
  });

  it('reads and filters by type, skipping foreign/corrupt entries', () => {
    const entries: PiEntry[] = [
      { type: 'message', id: 'm1', parentId: null, timestamp: 't', message: { role: 'user', content: 'hi' } },
      omEntry({ type: 'om.observation', data: obs, at: 't1' }),
      { type: 'custom', id: 'y', parentId: null, timestamp: 't', customType: 'other', data: { type: 'om.observation', data: obs } },
      omEntry({ type: 'om.observation', data: { id: 42 }, at: 't2' }), // corrupt payload
      omEntry({ type: 'om.cost', data: { runId: 'r1', role: 'observer', usd: 0.01, at: 't' }, at: 't3' }),
    ];
    const { store } = makeStore(entries);
    const all = store.read();
    expect(all.map((e) => e.type)).toEqual(['om.observation', 'om.cost']);
    const costs = store.read('om.cost');
    expect(costs.length).toBe(1);
    expect(costs[0]!.data.usd).toBe(0.01);
  });

  it('tombstone appends an om.tombstone entry', () => {
    const { store, appended } = makeStore([]);
    store.tombstone(['om-1'], { topics: ['a.md'], journeyChanged: true });
    const t = appended[0] as { type: string; data: { observationIds: string[]; topics: string[] } };
    expect(t.type).toBe('om.tombstone');
    expect(t.data.observationIds).toEqual(['om-1']);
    expect(t.data.topics).toEqual(['a.md']);
  });
});
