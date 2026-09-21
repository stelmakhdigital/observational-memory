import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createScopedFileTools, resolveContained } from '../../src/adapters/pi/scoped-tools.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'om-scope-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const tools = () => Object.fromEntries(createScopedFileTools(dir).map((t) => [t.name, t]));
const call = async (name: string, params: Record<string, unknown>) => {
  const t = tools()[name]!;
  const r = await t.execute('id', params);
  return { text: r.content[0]!.text, isError: r.isError };
};

describe('resolveContained', () => {
  it('allows relative paths inside the root', () => {
    expect(resolveContained(dir, 'a/b.md')).toBe(path.join(dir, 'a', 'b.md'));
    expect(resolveContained(dir, '.')).toBe(dir);
  });
  it('rejects traversal and outside absolute paths', () => {
    expect(() => resolveContained(dir, '../../etc/passwd')).toThrow(/escapes/);
    expect(() => resolveContained(dir, '/etc/passwd')).toThrow(/escapes/);
    expect(() => resolveContained(dir, 'a/../../x')).toThrow(/escapes/);
  });
});

describe('scoped file tools', () => {
  it('exposes exactly read/write/edit/ls/grep', () => {
    expect(Object.keys(tools()).sort()).toEqual(['edit', 'grep', 'ls', 'read', 'write']);
  });

  it('write + read roundtrip', async () => {
    const w = await call('write', { path: 'topic.md', content: '---\ntopic: t\n---\nbody' });
    expect(w.isError).toBeFalsy();
    const r = await call('read', { path: 'topic.md' });
    expect(r.text).toContain('body');
  });

  it('write rejects escaping paths', async () => {
    const w = await call('write', { path: '../../evil.md', content: 'x' });
    expect(w.isError).toBe(true);
    expect(w.text).toContain('escapes');
    expect(() => readFileSync(path.join(dir, 'evil.md'), 'utf8')).toThrow();
  });

  it('edit requires a unique oldText', async () => {
    writeFileSync(path.join(dir, 'a.md'), 'x x x');
    const dup = await call('edit', { path: 'a.md', oldText: 'x', newText: 'y' });
    expect(dup.isError).toBe(true);
    expect(dup.text).toContain('occurs 3 times');
    writeFileSync(path.join(dir, 'a.md'), 'hello world');
    const okEdit = await call('edit', { path: 'a.md', oldText: 'world', newText: 'om' });
    expect(okEdit.isError).toBeFalsy();
    expect(readFileSync(path.join(dir, 'a.md'), 'utf8')).toBe('hello om');
  });

  it('edit rejects missing oldText', async () => {
    writeFileSync(path.join(dir, 'b.md'), 'abc');
    const r = await call('edit', { path: 'b.md', oldText: 'zzz', newText: 'q' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('not found');
  });

  it('ls lists files recursively', async () => {
    writeFileSync(path.join(dir, 'top.md'), 't');
    mkdirSync(path.join(dir, 'sub'), { recursive: true });
    writeFileSync(path.join(dir, 'sub', 'deep.md'), 'd');
    const r = await call('ls', {});
    expect(r.text).toContain('top.md');
    expect(r.text).toContain('sub/');
    expect(r.text).toContain('deep.md');
  });

  it('grep finds matches and reports file:line', async () => {
    writeFileSync(path.join(dir, 't1.md'), 'alpha\nbeta\n');
    writeFileSync(path.join(dir, 't2.md'), 'gamma beta\n');
    const r = await call('grep', { pattern: 'beta' });
    expect(r.text).toContain('t1.md:2');
    expect(r.text).toContain('t2.md:1');
    const none = await call('grep', { pattern: 'zzz' });
    expect(none.text).toBe('(no matches)');
  });
});
