import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { renderExtractorPrompt } from '../../src/core/prompts/extractor.js';
import { parseExtractorOutput } from '../../src/core/worker-output.js';
import { resolveConfig, DEFAULT_CONFIG } from '../../src/core/config.js';
import { MemoryStore } from '../../src/core/memory-store.js';
import { sumCosts } from '../../src/core/cost.js';
import { OmError } from '../../src/core/types.js';
import type { Observation } from '../../src/core/types.js';

const obs = (id: string, content: string): Observation => ({
  id,
  coversUpToId: `m-${id}`,
  content,
  tokenCount: content.length,
  createdAt: new Date().toISOString(),
});

describe('renderExtractorPrompt', () => {
  it('includes specs, current values and observations, and the JSON block markers', () => {
    const p = renderExtractorPrompt(
      {
        runId: 'r1',
        role: 'extractor',
        extract: {
          specs: [{ id: 'profile', name: 'User profile', description: 'stable facts' }],
          current: { profile: { lang: 'ru' } },
          observations: [obs('a', 'user prefers tabs')],
          sessionDir: '/tmp/s',
        },
      },
      { sessionLabel: 'sess-42' },
    );
    expect(p).toContain('EXTRACTOR');
    expect(p).toContain('profile');
    expect(p).toContain('User profile');
    expect(p).toContain('"lang": "ru"');
    expect(p).toContain('[a] user prefers tabs'); // observation rendered as [<id>]
    expect(p).toContain('EXTRACTED_JSON');
    expect(p).toContain('END_EXTRACTED_JSON');
    expect(p).toContain('sess-42');
  });

  it('marks an absent current value as not stored', () => {
    const p = renderExtractorPrompt({
      runId: 'r1',
      role: 'extractor',
      extract: {
        specs: [{ id: 'x', name: 'X', description: 'd' }],
        current: {},
        observations: [],
        sessionDir: '/tmp/s',
      },
    });
    expect(p).toContain('(not stored yet)');
    expect(p).toContain('(empty');
  });
});

describe('parseExtractorOutput', () => {
  it('parses the EXTRACTED_JSON block', () => {
    const r = parseExtractorOutput('blah\nEXTRACTED_JSON\n{"profile": {"lang": "ru"}}\nEND_EXTRACTED_JSON\nbye');
    expect(r.ok).toBe(true);
    expect(r.values.profile).toEqual({ lang: 'ru' });
  });

  it('falls back to a bare JSON object without markers', () => {
    const r = parseExtractorOutput('Here you go: {"profile": {"x": 1}} — done.');
    expect(r.ok).toBe(true);
    expect(r.values.profile).toEqual({ x: 1 });
  });

  it('rejects arrays and garbage', () => {
    expect(parseExtractorOutput('["a","b"]').ok).toBe(false);
    expect(parseExtractorOutput('no json here').ok).toBe(false);
    expect(parseExtractorOutput('').ok).toBe(false);
  });
});

describe('extractors config', () => {
  it('has a default "profile" extractor', () => {
    expect(DEFAULT_CONFIG.extractors.map((e) => e.id)).toEqual(['profile']);
    expect(resolveConfig(null).extractors[0]!.id).toBe('profile');
  });

  it('validates ids (format + duplicates) and required fields', () => {
    expect(() =>
      resolveConfig({ extractors: [{ id: 'Bad ID', name: 'x', description: 'y' }] }),
    ).toThrow(OmError);
    expect(() =>
      resolveConfig({
        extractors: [
          { id: 'a', name: 'x', description: 'y' },
          { id: 'a', name: 'x2', description: 'y2' },
        ],
      }),
    ).toThrow(/duplicate/);
    expect(() => resolveConfig({ extractors: [{ id: 'a', name: '', description: 'y' }] })).toThrow(OmError);
    // empty list disables extraction and is valid
    expect(resolveConfig({ extractors: [] }).extractors).toEqual([]);
  });

  it('accepts models.extractor', () => {
    const c = resolveConfig({
      models: { observer: { id: 'o' }, consolidator: { id: 'c' }, extractor: { id: 'small-model' } },
    });
    expect(c.models.extractor?.id).toBe('small-model');
    expect(c.models.consolidator.id).toBe('c');
  });
});

describe('memory-store extracted values', () => {
  let dir: string;
  const S = 'sess-1';
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'om-ext-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  it('roundtrips save/load and lists ids', () => {
    const store = new MemoryStore(dir);
    expect(store.loadExtracted(S, 'profile')).toBeUndefined();
    expect(store.listExtracted(S)).toEqual([]);
    store.saveExtracted(S, 'profile', { lang: 'ru', tabs: true });
    expect(store.loadExtracted(S, 'profile')).toEqual({ lang: 'ru', tabs: true });
    expect(store.listExtracted(S)).toEqual(['profile']);
  });

  it('seedFrom copies topic files AND extracted/ (durable memory)', () => {
    const store = new MemoryStore(dir);
    // parent: a topic file + a stored extractor value
    const parentDir = path.join(dir, 'sess-parent');
    mkdirSync(parentDir, { recursive: true });
    writeFileSync(
      path.join(parentDir, 'topic.md'),
      '---\ntopic: t\ndescription: d\nsession: sess-parent\n---\nbody\n',
      'utf8',
    );
    store.saveExtracted('sess-parent', 'profile', { a: 1 });

    store.seedFrom('sess-parent', 'sess-child');

    expect(existsSync(path.join(dir, 'sess-child', 'topic.md'))).toBe(true);
    // extracted/ is seeded now (v2+) — forked sessions keep structured memory
    expect(store.loadExtracted('sess-child', 'profile')).toEqual({ a: 1 });
    expect(store.listExtracted('sess-child')).toEqual(['profile']);
  });
});

describe('cost accounting with extractor role', () => {
  it('aggregates extractor costs into byRole and totals', () => {
    const entries = [
      {
        type: 'om.cost' as const,
        data: { runId: 'r1', role: 'extractor' as const, usd: 0.05, at: '2025-01-01T00:00:00Z' },
        at: '2025-01-01T00:00:00Z',
      },
    ];
    const s = sumCosts(entries as never);
    expect(s.totalUsd).toBeCloseTo(0.05);
    expect(s.byRole.extractor).toEqual({ usd: 0.05, runs: 1 });
    expect(s.byRole.observer).toEqual({ usd: 0, runs: 0 });
  });
});
