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

  it('has typebox in dependencies (runtime value; pi update installs --omit=dev --legacy-peer-deps, so a pure peer would not be installed and prepare/tsc would fail)', () => {
    expect(pkg.dependencies?.typebox).toBeTruthy();
    expect(pkg.peerDependencies?.typebox).toBeUndefined();
  });

  it('only build-time tooling + typebox in dependencies (prepare/build needs tsc + node types + typebox under npm install --omit=dev --legacy-peer-deps)', () => {
    expect(Object.keys(pkg.dependencies ?? {}).sort()).toEqual(['@types/node', 'typebox', 'typescript']);
  });
});

describe('npm packaging (dist build, P2.12)', () => {
  const EXPORTS: Record<string, { types: string; default: string }> = {
    './core': { types: './dist/core/index.d.ts', default: './dist/core/index.js' },
    './core/testing': { types: './dist/core/testing.d.ts', default: './dist/core/testing.js' },
    './adapters/pi': { types: './dist/adapters/pi/index.d.ts', default: './dist/adapters/pi/index.js' },
    './adapters/mcp': { types: './dist/adapters/mcp/server.d.ts', default: './dist/adapters/mcp/server.js' },
  };

  it('exports point at the built dist (plain-Node ESM), with .d.ts types', () => {
    expect(pkg.exports).toMatchObject(EXPORTS);
    for (const [name, { types, default: d }] of Object.entries(EXPORTS)) {
      expect(pkg.exports[name]).toEqual({ types, default: d });
      expect(d.endsWith('.js')).toBe(true);
      expect(types.endsWith('.d.ts')).toBe(true);
    }
  });

  it('exports never point at .ts sources (plain Node cannot load them)', () => {
    for (const entry of Object.values(pkg.exports) as Array<{ types: string; default: string }>) {
      expect(entry.default).toMatch(/^\.\/dist\/.*\.js$/);
      expect(entry.types).toMatch(/^\.\/dist\/.*\.d\.ts$/);
    }
  });

  it('files ships both dist (npm consumer) and src (pi git install loads .ts natively)', () => {
    expect(pkg.files).toContain('dist');
    expect(pkg.files).toContain('src');
  });

  it('prepare builds dist on install (npm install <git-url> / pi install git:)', () => {
    expect(pkg.scripts.prepare).toBe('npm run build');
    expect(pkg.scripts.build).toContain('tsconfig.build.json');
  });

  it('dist layout matches exports (only asserted when a build is present)', () => {
    if (!existsSync(path.join(root, 'dist/core/index.js'))) return; // pre-build is fine
    for (const { types, default: d } of Object.values(EXPORTS)) {
      expect(existsSync(path.join(root, d))).toBe(true);
      expect(existsSync(path.join(root, types))).toBe(true);
    }
  });
});
