import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs';
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

describe('n4: symlink containment', () => {
  let outside: string;
  beforeEach(() => {
    outside = mkdtempSync(path.join(tmpdir(), 'om-outside-'));
  });
  afterEach(() => rmSync(outside, { recursive: true, force: true }));

  it('resolveContained rejects a path that escapes via a symlink inside the dir', () => {
    symlinkSync(outside, path.join(dir, 'link'));
    expect(() => resolveContained(dir, 'link/secret.md')).toThrow(/escapes/);
    // ordinary nested paths still work and keep their lexical form
    expect(resolveContained(dir, 'a/b.md')).toBe(path.join(dir, 'a', 'b.md'));
  });

  it('read/write/ls/grep reject a symlinked target outside the dir', async () => {
    writeFileSync(path.join(outside, 'secret.md'), 'top secret');
    symlinkSync(outside, path.join(dir, 'link'));
    const rd = await call('read', { path: 'link/secret.md' });
    expect(rd.isError).toBe(true);
    expect(rd.text).toContain('escapes');
    const wr = await call('write', { path: 'link/evil.md', content: 'x' });
    expect(wr.isError).toBe(true);
    expect(wr.text).toContain('escapes');
    // nothing was written outside the dir
    try {
      readFileSync(path.join(outside, 'evil.md'), 'utf8');
      throw new Error('write leaked outside');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    const ls = await call('ls', { path: 'link' });
    expect(ls.isError).toBe(true);
    const gr = await call('grep', { pattern: 'secret', path: 'link' });
    expect(gr.isError).toBe(true);
  });

  it('ls/grep walks do not follow a symlinked dir outside', async () => {
    writeFileSync(path.join(outside, 'leak.md'), 'leak');
    symlinkSync(outside, path.join(dir, 'link'));
    writeFileSync(path.join(dir, 'ok.md'), 'ok');
    const ls = await call('ls', {});
    expect(ls.text).toContain('ok.md');
    expect(ls.text).not.toContain('leak.md');
    const gr = await call('grep', { pattern: 'leak' });
    expect(gr.isError).toBeFalsy();
    expect(gr.text).toBe('(no matches)');
  });

  it('write to a non-existing nested path inside the dir still works', async () => {
    const w = await call('write', { path: 'new/deep/topic.md', content: 'x' });
    expect(w.isError).toBeFalsy();
    expect(readFileSync(path.join(dir, 'new', 'deep', 'topic.md'), 'utf8')).toBe('x');
  });

  it('write through a symlinked PARENT that is outside is rejected', async () => {
    // link itself is inside lexically; its REAL location is outside
    symlinkSync(outside, path.join(dir, 'link'));
    const w = await call('write', { path: 'link/nested/file.md', content: 'x' });
    expect(w.isError).toBe(true);
    expect(w.text).toContain('escapes');
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
