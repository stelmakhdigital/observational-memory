import { describe, expect, it } from 'vitest';
import {
  renderCompactionBlock,
  renderPool,
  selectBeforeTail,
} from '../../src/core/ledger/render.js';
import { omPayloadOk, parseOmLine } from '../../src/core/ledger/payload.js';
import type { Observation } from '../../src/core/types.js';

const obs = (id: string, coversUpToId: string, content = `c-${id}`): Observation => ({
  id,
  coversUpToId,
  content,
  tokenCount: 10,
  createdAt: '2025-09-21T00:00:00Z',
});

describe('renderPool', () => {
  it('is deterministic (commit order, stable format)', () => {
    const o = [obs('om-1', 'm1'), obs('om-2', 'm2')];
    expect(renderPool(o)).toBe(renderPool([...o]));
    // v0.4: no priority field → routine → '· ' marker
    expect(renderPool(o)).toBe('[om-1] · c-om-1\n[om-2] · c-om-2');
  });

  it('renders priority and quarantine markers (v0.4/v0.6)', () => {
    const o = [
      { ...obs('om-1', 'm1', 'critical note'), priority: 'critical' as const },
      { ...obs('om-2', 'm1', 'important note'), priority: 'important' as const },
      { ...obs('om-3', 'm1', 'routine note'), priority: 'routine' as const },
      { ...obs('om-4', 'm1', 'weird note'), quarantined: true },
    ];
    expect(renderPool(o)).toBe(
      '[om-1] ! critical note\n[om-2] important note\n[om-3] · routine note\n[om-4] [UNVERIFIED] · weird note',
    );
  });

  it('normalizes whitespace inside content', () => {
    const o = [obs('om-1', 'm1', 'a\n\n  b')];
    expect(renderPool(o)).toBe('[om-1] · a b');
  });

  it('empty pool → empty string', () => {
    expect(renderPool([])).toBe('');
  });
});

describe('selectBeforeTail (FR-3.4 no double representation)', () => {
  it('keeps only chunk boundaries within the pre-tail region', () => {
    const o = [
      obs('om-1', 'm1'),
      obs('om-2', 'm2'),
      obs('om-3', 'm5'), // chunk covering m3..m5; tail starts at m4 → boundary m3
    ];
    const sel = selectBeforeTail(o, 'm3');
    expect(sel.map((x) => x.id)).toEqual(['om-1', 'om-2']);
  });

  it('empty boundary (tail covers everything) → no observations', () => {
    const o = [obs('om-1', 'm1')];
    expect(selectBeforeTail(o, '')).toEqual([]);
  });

  it('boundary after all chunks keeps everything', () => {
    const o = [obs('om-1', 'm1'), obs('om-2', 'm2')];
    expect(selectBeforeTail(o, 'm9').map((x) => x.id)).toEqual(['om-1', 'om-2']);
  });
});

describe('renderCompactionBlock', () => {
  const base = {
    observations: [obs('om-1', 'm1')],
    memoryMap: '- topic-a: what happened',
    journey: '## 2025-09-21 — started',
    verbatimTail: 'fresh history',
    gapMarkers: '',
    generatedAt: '2025-09-21T00:00:00Z',
  };

  it('assembles all sections deterministically', () => {
    const a = renderCompactionBlock(base);
    const b = renderCompactionBlock({ ...base });
    expect(a.text).toBe(b.text);
    expect(a.text).toContain('OBSERVATIONAL MEMORY');
    expect(a.text).toContain('--- observations (1) ---');
    expect(a.text).toContain('--- memory map (durable topics) ---');
    expect(a.text).toContain('--- journey ---');
    expect(a.text).toContain('RECENT HISTORY (verbatim)');
  });

  it('omits empty optional sections', () => {
    const a = renderCompactionBlock({ ...base, memoryMap: '', journey: '' });
    expect(a.text).not.toContain('memory map');
    expect(a.text).not.toContain('journey');
    expect(a.text).toContain('(none yet)'.length > 0 ? 'observations' : '');
  });

  it('renders gap markers at the head', () => {
    const a = renderCompactionBlock({ ...base, gapMarkers: 'resumed after 2 days' });
    expect(a.text.indexOf('temporal anchors')).toBeLessThan(a.text.indexOf('observations'));
  });
});

describe('payload validation (S3: single validator)', () => {
  it('accepts a valid observation payload', () => {
    const o = {
      id: 'om-1',
      coversUpToId: 'm1',
      content: 'hi',
      tokenCount: 3,
      createdAt: '2025-09-21T00:00:00Z',
    };
    expect(omPayloadOk('om.observation', o)).toBe(true);
    const line = JSON.stringify({ type: 'om.observation', data: o, at: 't' });
    expect(parseOmLine(line)?.data).toEqual(o);
  });

  it('rejects corrupt payloads (not throw)', () => {
    expect(omPayloadOk('om.observation', { id: 'x' })).toBe(false); // missing fields
    expect(omPayloadOk('om.observation', null)).toBe(false);
    expect(parseOmLine('not json')).toBeNull();
    expect(parseOmLine(JSON.stringify({ type: 'om.unknown', data: {}, at: 't' }))).toBeNull();
    expect(parseOmLine(JSON.stringify({ type: 'om.enabled', data: { enabled: true } }))).toBeNull(); // no `at`
  });

  it('round-trips a tombstone line', () => {
    const d = { observationIds: ['om-1'], topics: ['a'], journeyChanged: true };
    const line = JSON.stringify({ type: 'om.tombstone', data: d, at: 't', meta: { runId: 'r1' } });
    const e = parseOmLine(line);
    expect(e?.data).toEqual(d);
    expect(e?.meta).toEqual({ runId: 'r1' });
  });
});
