import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import omWorker, { createScopedFileTools } from '../../src/adapters/pi/worker.js';
import type { PiApi } from '../../src/adapters/pi/types.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'om-worker-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makePi() {
  const registered: unknown[] = [];
  return {
    registered,
    pi: {
      registerTool: (t: unknown) => registered.push(t),
      registerCommand: () => {},
      on: () => {},
      appendEntry: () => {},
      sendMessage: () => {},
    } as unknown as PiApi,
  };
}

const OLD_ENV = { ...process.env };
afterEach(() => {
  process.env = { ...OLD_ENV };
});

describe('omWorker (pi extension entry)', () => {
  it('is a function (valid pi extension default export)', () => {
    expect(typeof omWorker).toBe('function');
  });

  it('observer role registers NO tools', () => {
    process.env.OM_WORKER = 'observer';
    const { pi, registered } = makePi();
    omWorker(pi);
    expect(registered).toEqual([]);
  });

  it('unset role registers NO tools', () => {
    delete process.env.OM_WORKER;
    const { pi, registered } = makePi();
    omWorker(pi);
    expect(registered).toEqual([]);
  });

  it('consolidator registers exactly the 5 scoped tools', () => {
    process.env.OM_WORKER = 'consolidator';
    process.env.OM_WORKER_DIR = dir;
    const { pi, registered } = makePi();
    omWorker(pi);
    const names = (registered as { name: string }[]).map((t) => t.name).sort();
    expect(names).toEqual(['edit', 'grep', 'ls', 'read', 'write']);
  });

  it('consolidator tools are actually scoped to OM_WORKER_DIR', async () => {
    const tools = Object.fromEntries(createScopedFileTools(dir).map((t) => [t.name, t]));
    const outside = await tools.read!.execute('i', { path: '/etc/passwd' });
    expect(outside.isError).toBe(true);
    expect(outside.content[0]!.text).toContain('escapes');
    const inside = await tools.write!.execute('i', { path: 'ok.md', content: 'v' });
    expect(inside.isError).toBeFalsy();
  });
});
