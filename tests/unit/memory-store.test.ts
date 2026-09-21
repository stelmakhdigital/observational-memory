import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  MemoryStore,
  parseFrontMatter,
  renderMemoryMap,
  renderTopicFile,
  sanitizeName,
} from '../../src/core/memory-store.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'om-mem-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('sanitizeName', () => {
  it('slugs unsafe characters and caps length', () => {
    expect(sanitizeName('My Session!')).toBe('my-session');
    expect(sanitizeName('x'.repeat(200)).length).toBe(64);
    expect(sanitizeName('!!!')).toBe('unnamed');
  });
});

describe('MemoryStore', () => {
  it('creates session dirs lazily and reports existence', () => {
    const ms = new MemoryStore(dir);
    expect(ms.exists('s1')).toBe(false);
    ms.renderIndex('s1');
    expect(ms.exists('s1')).toBe(true);
  });

  it('lists topics from front-matter, sorted, excluding INDEX/JOURNEY', () => {
    const ms = new MemoryStore(dir);
    const d = ms.sessionDir('s1');
    mkdirSync(d, { recursive: true });
    writeFileSync(path.join(d, 'b-topic.md'), renderTopicFile('B', 'second', 's1', 'body b'));
    writeFileSync(path.join(d, 'a-topic.md'), renderTopicFile('A', 'first', 's1', 'body a'));
    writeFileSync(path.join(d, 'INDEX.md'), 'should be ignored');
    writeFileSync(path.join(d, 'JOURNEY.md'), 'should be ignored');
    const topics = ms.listTopics('s1');
    expect(topics.map((t) => t.topic)).toEqual(['A', 'B']);
    expect(topics[0]!.file).toBe('a-topic.md');
    expect(topics[0]!.description).toBe('first');
    expect(topics[0]!.session).toBe('s1');
  });

  it('returns empty list when the dir is missing', () => {
    const ms = new MemoryStore(dir);
    expect(ms.listTopics('nope')).toEqual([]);
    expect(ms.readJourney('nope')).toBe('');
  });

  it('seeds a child session from its parent once (skips .runs and flag)', () => {
    const ms = new MemoryStore(dir);
    const parent = ms.sessionDir('parent');
    mkdirSync(path.join(parent, '.runs'), { recursive: true });
    writeFileSync(path.join(parent, 'topic.md'), renderTopicFile('T', 'd', 'parent', 'x'));
    writeFileSync(path.join(parent, 'JOURNEY.md'), 'journey body');

    ms.seedFrom('parent', 'child');
    const childDir = ms.sessionDir('child');
    expect(ms.readJourney('child')).toBe('journey body');
    expect(ms.listTopics('child').map((t) => t.topic)).toEqual(['T']);
    expect(mkdirSync(path.join(childDir, '.runs'))).toBeUndefined; // .runs NOT seeded

    // re-seed is a no-op: child files are preserved
    writeFileSync(path.join(childDir, 'topic.md'), 'child-local change');
    writeFileSync(path.join(parent, 'topic.md'), 'parent changed after fork');
    ms.seedFrom('parent', 'child');
    expect(readFileSync(path.join(childDir, 'topic.md'), 'utf8')).toBe('child-local change');
  });

  it('seedFrom self is a no-op', () => {
    const ms = new MemoryStore(dir);
    expect(() => ms.seedFrom('s1', 's1')).not.toThrow();
  });

  it('renders INDEX.md from topic front-matter (FR-4.5)', () => {
    const ms = new MemoryStore(dir);
    const d = ms.sessionDir('s2');
    mkdirSync(d, { recursive: true });
    writeFileSync(path.join(d, 't1.md'), renderTopicFile('Alpha', 'alpha desc', 's2', 'x'));
    ms.renderIndex('s2');
    const index = readFileSync(path.join(d, 'INDEX.md'), 'utf8');
    expect(index).toContain('**Alpha** — alpha desc [t1.md]');
  });
});

describe('renderMemoryMap', () => {
  it('renders one line per topic', () => {
    const map = renderMemoryMap([
      { file: 'a.md', topic: 'A', description: 'da', session: 's' },
      { file: 'b.md', topic: 'B', description: '', session: 's' },
    ]);
    expect(map).toBe('- A: da\n- B');
  });
  it('empty topics → empty string', () => {
    expect(renderMemoryMap([])).toBe('');
  });
});

describe('parseFrontMatter', () => {
  it('parses key/value pairs and ignores non-fm content', () => {
    expect(parseFrontMatter('---\na: 1\nb: "two"\n---\nbody')).toEqual({ a: '1', b: 'two' });
    expect(parseFrontMatter('no front matter')).toEqual({});
  });
});
