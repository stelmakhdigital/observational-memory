/**
 * P5: deterministic RU/EN bridge in recall — BM25 without stemming, so
 * «таймзона» ≠ "timezone" unless tokens are bridged. No LLM (NFR model-free).
 */
import { describe, expect, it } from 'vitest';
import { recallSearch, tokenize, type RecallDoc } from '../../src/core/recall.js';

const doc = (id: string, text: string): RecallDoc => ({
  kind: 'observation',
  id,
  title: `observation ${id}`,
  text,
  at: '2026-01-01T00:00:00Z',
  status: 'active',
});

describe('tokenize bridge expansion', () => {
  it('expands RU and EN tokens to cross-language synonyms (multiset union)', () => {
    const ru = tokenize('таймзона');
    expect(ru).toContain('таймзона');
    expect(ru).toContain('timezone');
    const en = tokenize('timezone');
    expect(en).toContain('timezone');
    expect(en).toContain('таймзона');
    // exact token is preserved (bridge only adds synonyms)
    expect(tokenize('release notes')).toEqual(expect.arrayContaining(['release', 'notes', 'релиз']));
    expect(tokenize('password пароль')).toEqual(expect.arrayContaining(['password', 'пароль']));
  });

  it('leaves non-bridged tokens unchanged', () => {
    expect(tokenize('websocket sync')).toEqual(['websocket', 'sync']);
  });
});

describe('recall RU/EN bridge (P5)', () => {
  it('RU query finds EN observation', () => {
    const docs = [doc('om-1', 'timezone set to UTC+5'), doc('om-2', 'fixed the parser')];
    const hits = recallSearch(docs, 'таймзона');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.id).toBe('om-1');
  });

  it('EN query finds RU observation', () => {
    const docs = [doc('om-1', 'таймзона установлена на UTC+5'), doc('om-2', 'fixed the parser')];
    const hits = recallSearch(docs, 'timezone');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.id).toBe('om-1');
  });

  it('«заметки о релизе» finds "release notes"', () => {
    const docs = [doc('om-1', 'release notes written for v1.2'), doc('om-2', 'deploy finished')];
    const hits = recallSearch(docs, 'заметки о релизе');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.id).toBe('om-1');
  });

  it('"release notes" finds «заметки о релизе»', () => {
    const docs = [doc('om-1', 'заметки о релизе обновлены'), doc('om-2', 'deploy finished')];
    const hits = recallSearch(docs, 'release notes');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.id).toBe('om-1');
  });

  it('exact-match queries are not degraded', () => {
    const docs = [doc('om-1', 'websocket sync protocol decided'), doc('om-2', 'unrelated')];
    const hits = recallSearch(docs, 'websocket');
    expect(hits.length).toBe(1);
    expect(hits[0]!.id).toBe('om-1');
    // deterministic: same query → same result
    expect(recallSearch(docs, 'websocket')).toEqual(hits);
  });
});
