import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadPiAdapterConfig } from '../../src/adapters/pi/config.js';

let dir: string;
let home: string;
let cwd: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'om-cfg-'));
  home = path.join(dir, 'home');
  cwd = path.join(dir, 'proj');
  mkdirSync(path.join(home, '.pi', 'agent'), { recursive: true });
  mkdirSync(path.join(cwd, '.pi'), { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const writeGlobal = (obj: unknown) =>
  writeFileSync(path.join(home, '.pi', 'agent', 'settings.json'), JSON.stringify(obj));
const writeProject = (obj: unknown) =>
  writeFileSync(path.join(cwd, '.pi', 'settings.json'), JSON.stringify(obj));

describe('loadPiAdapterConfig', () => {
  it('defaults without any settings', () => {
    const c = loadPiAdapterConfig(cwd, {}, home);
    expect(c.om.chunkTokens).toBe(5000);
    expect(c.om.gapMarkers.enabled).toBe(true);
    expect(c.piBinary).toBe('pi');
    expect(c.workerTimeoutMs).toBe(600_000);
    expect(c.memoryDir).toBe(path.join(cwd, '.memory'));
  });

  it('merges global then project (project wins)', () => {
    writeGlobal({ 'observational-memory': { chunkTokens: 111, passive: true, models: { observer: { id: 'g' } } } });
    writeProject({ 'observational-memory': { chunkTokens: 222, models: { observer: { thinking: 'medium' } } } });
    const c = loadPiAdapterConfig(cwd, {}, home);
    expect(c.om.chunkTokens).toBe(222);
    expect(c.om.passive).toBe(true); // global survives
    expect(c.om.models.observer.id).toBe('g'); // global survives
    expect(c.om.models.observer.thinking).toBe('medium'); // project wins
  });

  it('env overrides pi binary and timeout', () => {
    writeGlobal({ 'observational-memory': { piBinary: '/usr/bin/pi' } });
    const c = loadPiAdapterConfig(cwd, { OM_PI_BIN: '/opt/pi' } as NodeJS.ProcessEnv, home);
    expect(c.piBinary).toBe('/opt/pi');
    const c2 = loadPiAdapterConfig(cwd, { OM_WORKER_TIMEOUT_MS: '1234' } as NodeJS.ProcessEnv, home);
    expect(c2.workerTimeoutMs).toBe(1234);
    const c3 = loadPiAdapterConfig(cwd, {}, home);
    expect(c3.piBinary).toBe('/usr/bin/pi');
  });

  it('invalid config throws (FR-9.3)', () => {
    writeProject({ 'observational-memory': { chunkTokens: 0 } });
    expect(() => loadPiAdapterConfig(cwd, {}, home)).toThrow(/chunkTokens/);
  });

  it('ignores corrupt settings files', () => {
    writeGlobal('not json{{{');
    const c = loadPiAdapterConfig(cwd, {}, home);
    expect(c.om.chunkTokens).toBe(5000);
  });
});
