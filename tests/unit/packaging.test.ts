import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as Record<string, any>;

describe('pi package packaging (git install)', () => {
  it('declares a pi manifest pointing at the adapter entry (file exists)', () => {
    const exts: string[] = pkg.pi?.extensions;
    expect(Array.isArray(exts)).toBe(true);
    expect(exts).toContain('./src/adapters/pi/index.ts');
    expect(existsSync(path.join(root, 'src/adapters/pi/index.ts'))).toBe(true);
  });

  it('is discoverable as a pi package (keyword)', () => {
    expect(pkg.keywords).toContain('pi-package');
  });

  it('lists typebox as peerDependency "*" (pi bundles it; must not be a dependency)', () => {
    expect(pkg.peerDependencies?.typebox).toBe('*');
    expect(pkg.dependencies?.typebox).toBeUndefined();
  });

  it('has no other runtime dependencies (git install runs plain npm install, offline-safe)', () => {
    expect(Object.keys(pkg.dependencies ?? {})).toEqual([]);
  });
});
