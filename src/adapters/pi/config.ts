/**
 * Adapter configuration (FR-9): settings.json global (~/.pi/agent/settings.json)
 * + project (.pi/settings.json, overrides global), namespace `observational-memory`,
 * plus env overrides. Resolved via the core's resolveConfig (invariants checked).
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG, mergeDeep, resolveConfig, type OmConfig } from '../../core/config.js';
import type { PiModelRef } from './types.js';

export interface PiAdapterConfig {
  om: OmConfig;
  /** Binary used to launch worker subprocesses. */
  piBinary: string;
  /** Timeout per worker run (ms). */
  workerTimeoutMs: number;
  /** Memory root: <cwd>/.memory (fixed, NOT configurable — no settings key). */
  memoryDir: string;
  /**
   * Attachment observation mode (v0.7): how non-text message parts are
   * rendered into observed history. 'auto' (default) → named placeholders
   * like `[image: board.png]`; 'off' → attachments are omitted. Real image
   * forwarding is not supported by the text worker runner (documented).
   */
  attachments: 'auto' | 'off';
  /**
   * Non-fatal config problems (A6, FR-9.3): unknown namespace keys are
   * IGNORED but reported here, never dropped silently. Empty when clean.
   */
  problems: string[];
}

// A6 (FR-9.3 fail-loudly): whitelist of known namespace keys — all OmConfig
// keys (derived from DEFAULT_CONFIG so it cannot drift) + adapter-only keys.
const KNOWN_NAMESPACE_KEYS = new Set([
  ...Object.keys(DEFAULT_CONFIG),
  'piBinary',
  'workerTimeoutMs',
  'attachments',
]);
const KNOWN_MODEL_ROLES = new Set(['observer', 'consolidator', 'extractor', 'reflect']);

interface RawNamespace {
  [k: string]: unknown;
  models?: {
    observer?: Partial<PiModelRef>;
    consolidator?: Partial<PiModelRef>;
    extractor?: Partial<PiModelRef>;
    reflect?: Partial<PiModelRef>;
  };
  piBinary?: string;
  workerTimeoutMs?: number;
  attachments?: string;
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function namespaceOf(settings: unknown): RawNamespace | undefined {
  if (typeof settings !== 'object' || settings === null) return undefined;
  const ns = (settings as Record<string, unknown>)['observational-memory'];
  if (typeof ns !== 'object' || ns === null) return undefined;
  return ns as RawNamespace;
}

export function loadPiAdapterConfig(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): PiAdapterConfig {
  const globalNs = namespaceOf(readJson(path.join(home, '.pi', 'agent', 'settings.json')));
  const projectNs = namespaceOf(readJson(path.join(cwd, '.pi', 'settings.json')));
  const merged = mergeDeep<RawNamespace>(
    { models: { observer: {}, consolidator: {}, extractor: {}, reflect: {} } },
    mergeDeep<RawNamespace>(globalNs ?? {}, projectNs ?? {}),
  );

  // A6: unknown keys are stripped from the config but reported (FR-9.3) —
  // mergeDeep used to pass them through and drop them silently.
  const problems: string[] = [];
  const { piBinary, workerTimeoutMs, attachments } = merged;
  if (
    attachments !== undefined
    && (typeof attachments !== 'string' || (attachments !== 'auto' && attachments !== 'off'))
  ) {
    problems.push(`attachments must be "auto" or "off" (got ${JSON.stringify(attachments)})`);
  }
  const omPartial: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(merged)) {
    if (k === 'piBinary' || k === 'workerTimeoutMs' || k === 'attachments') continue;
    if (!KNOWN_NAMESPACE_KEYS.has(k)) {
      problems.push(`unknown key "${k}" (ignored)`);
      continue;
    }
    omPartial[k] = v;
  }
  if (omPartial.models && typeof omPartial.models === 'object' && !Array.isArray(omPartial.models)) {
    const models = omPartial.models as Record<string, unknown>;
    for (const k of Object.keys(models)) {
      if (!KNOWN_MODEL_ROLES.has(k)) {
        problems.push(`unknown key "models.${k}" (ignored)`);
        delete models[k];
      }
    }
  }
  const om = resolveConfig(omPartial as unknown as Partial<OmConfig>);

  return {
    om,
    piBinary: env.OM_PI_BIN || (typeof piBinary === 'string' && piBinary ? piBinary : 'pi'),
    workerTimeoutMs:
      env.OM_WORKER_TIMEOUT_MS && Number(env.OM_WORKER_TIMEOUT_MS) > 0
        ? Number(env.OM_WORKER_TIMEOUT_MS)
        : typeof workerTimeoutMs === 'number' && workerTimeoutMs > 0
          ? workerTimeoutMs
          : 10 * 60 * 1000,
    memoryDir: path.join(cwd, '.memory'),
    attachments: attachments === 'off' ? 'off' : 'auto',
    problems,
  };
}
