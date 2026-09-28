/**
 * n1/n2 tests: on timeout the runner must SIGKILL the whole PROCESS GROUP
 * (detached:true spawn → child is the group leader), stop accumulating
 * stdout/stderr (data listeners removed), and the run() promise must resolve
 * even if 'close' never fires (a grandchild holding the pipes open).
 *
 * `node:child_process.spawn` is mocked with a fake child (EventEmitter) that
 * never terminates on its own.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PiSubprocessRunner } from '../../src/adapters/pi/runner.js';
import { appendCapped, MAX_STDOUT_CHARS } from '../../src/adapters/pi/runner.js';

const spawnMock = vi.fn();
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: (...args: unknown[]) => spawnMock(...args) };
});

let dir: string;
let killSpy: ReturnType<typeof vi.spyOn>;

function makeMockChild(): any {
  const ee = new EventEmitter() as any;
  ee.pid = 9999;
  ee.exitCode = null;
  ee.killed = false;
  ee.stdout = new EventEmitter();
  ee.stderr = new EventEmitter();
  // A8: the runner destroys the pipes on timeout — the mocks must support it.
  ee.stdout.destroy = vi.fn();
  ee.stderr.destroy = vi.fn();
  ee.kill = vi.fn(() => true);
  return ee;
}

const observerInput = {
  runId: 'r-kill',
  role: 'observer' as const,
  chunk: { text: 'x', overlapContext: '', coversUpToId: 'm' },
};

function makeRunner(timeoutMs: number): PiSubprocessRunner {
  return new PiSubprocessRunner({
    piBinary: '/fake/pi',
    cwd: dir,
    observerModel: { id: 'x' },
    consolidatorModel: { id: 'x' },
    timeoutMs,
  });
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'om-runner-kill-'));
  spawnMock.mockReset();
  killSpy = vi.spyOn(process as unknown as { kill: (...args: unknown[]) => unknown }, 'kill').mockImplementation(() => {});
});
afterEach(() => {
  killSpy.mockRestore();
  rmSync(dir, { recursive: true, force: true });
});

describe('worker kill semantics (n1/n2)', () => {
  it('spawns with detached:true on POSIX (new process group)', async () => {
    const child = makeMockChild();
    spawnMock.mockReturnValue(child);
    const r = makeRunner(50);
    const p = r.run('observer', observerInput);
    await p;
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [ , , opts] = spawnMock.mock.calls[0]!;
    expect(opts.detached).toBe(process.platform !== 'win32');
    expect(opts.stdio).toEqual(['ignore', 'pipe', 'pipe']);
  });

  it('on timeout: SIGKILLs the process group, removes data listeners, resolves without close', async () => {
    const child = makeMockChild();
    spawnMock.mockReturnValue(child);
    const r = makeRunner(60);
    const p = r.run('observer', observerInput);
    expect(child.stdout.listenerCount('data')).toBe(1);
    expect(child.stderr.listenerCount('data')).toBe(1);
    const res = await p; // must resolve via the timeout, close never fires
    expect(res.ok).toBe(false);
    expect(res.error).toContain('timed out');
    // Group kill: process.kill(-pid, SIGKILL)
    expect(killSpy).toHaveBeenCalledWith(-9999, 'SIGKILL');
    // n1: no data listeners left — a grandchild holding the pipes cannot
    // keep growing the captured buffers.
    expect(child.stdout.listenerCount('data')).toBe(0);
    expect(child.stderr.listenerCount('data')).toBe(0);
    // Data pushed after the timeout is simply dropped.
    child.stdout.emit('data', Buffer.from('junk that must not be captured'));
    expect(child.stdout.listenerCount('data')).toBe(0);
    // A8: close/error listeners detached and the pipes destroyed — the
    // captured stdout/stderr strings die with the close closure, and
    // drain() has nothing left to wait for (the 'close' may never come).
    expect(child.listenerCount('close')).toBe(0);
    expect(child.listenerCount('error')).toBe(0);
    expect(child.stdout.destroy).toHaveBeenCalled();
    expect(child.stderr.destroy).toHaveBeenCalled();
    // drain() must not hang on the (never coming) 'close' of the timed-out
    // child — it was already removed from the active set by finish().
    await expect(r.drain()).resolves.toBeUndefined();
  });

  it('A9: a 5MB chatty stream is capped and the report (at the END) still parses', async () => {
    const child = makeMockChild();
    spawnMock.mockReturnValue(child);
    const r = makeRunner(15_000);
    const p = r.run('observer', observerInput);
    // ~5MB of chatty JSONL garbage in 64KB chunks, then the report, then close.
    const chunk = 'junkline '.repeat(11_185); // 64KB
    for (let i = 0; i < 80; i++) child.stdout.emit('data', Buffer.from(chunk)); // 5MB
    child.stdout.emit(
      'data',
      Buffer.from(
        '\n' + JSON.stringify({
          type: 'message_end',
          message: { role: 'assistant', content: [{ type: 'text', text: 'OBSERVATIONS\n- [P1] survived\nEND_OBSERVATIONS' }] },
        }),
      ),
    );
    child.emit('close', 0);
    const res = await p;
    // The report lives in the TAIL of the stream → survives the cap.
    expect(res.ok).toBe(true);
    expect(res.observations).toEqual([{ text: 'survived', priority: 'important' }]);
  });

  it('on timeout: falls back to direct child kill when the group kill fails', async () => {
    const child = makeMockChild();
    spawnMock.mockReturnValue(child);
    if (process.platform !== 'win32') {
      // Simulate "no such process group" (e.g. pid already reaped).
      killSpy.mockImplementationOnce(() => {
        throw new Error('ESRCH');
      });
    }
    const r = makeRunner(60);
    const res = await r.run('observer', observerInput);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('timed out');
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('on normal close: reaps the process group (grandchildren holding pipes)', async () => {
    const child = makeMockChild();
    spawnMock.mockReturnValue(child);
    const r = makeRunner(60_000);
    const p = r.run('observer', observerInput);
    child.stdout.emit('data', Buffer.from('\n{"type":"message_end","message":{"role":"assistant","content":"OBSERVATIONS\\n- [P1] ok\\nEND_OBSERVATIONS"}}\n'));
    child.emit('close', 0);
    const res = await p;
    expect(res.ok).toBe(true);
    if (process.platform !== 'win32') {
      expect(killSpy).toHaveBeenCalledWith(-9999, 'SIGKILL');
    }
  });
});

describe('A9: appendCapped', () => {
  it('bounds the buffer at the cap and keeps the tail (5MB streamed)', () => {
    let s = '';
    const chunk = 'a'.repeat(64 * 1024);
    for (let i = 0; i < 80; i++) s = appendCapped(s, chunk, MAX_STDOUT_CHARS); // 5MB
    expect(s.length).toBe(MAX_STDOUT_CHARS);
    expect(s.endsWith(chunk)).toBe(true);
  });

  it('is a no-op below the cap', () => {
    expect(appendCapped('abc', 'de', MAX_STDOUT_CHARS)).toBe('abcde');
  });
});
