/**
 * createOmSession: one-call wiring for EMBEDDED (agent-agnostic) integrations.
 *
 * For hosts that are not pi (your own Node agent, a CLI tool, a service):
 * supply a HistorySource + ModelRunner, and get a ready orchestrator with
 * MemoryStore (durable files) and FileLedgerStore (JSONL ledger).
 *
 * The pi adapter wires the same pieces itself (pi.appendEntry ledger,
 * subprocess runner); this helper is the generic path.
 */
import { resolveConfig, type OmConfig } from './config.js';
import { FileLedgerStore, defaultLedgerFile } from './ledger/file-store.js';
import { MemoryStore } from './memory-store.js';
import { OmOrchestrator } from './orchestrator.js';
import type { EventSink, HistorySource, ModelRunner } from './types.js';
import path from 'node:path';

export interface OmSessionOptions {
  /** Root directory for durable memory + the ledger file (<root>/<sessionId>/). */
  root: string;
  sessionId: string;
  /** Host history (branch/current conversation as the host defines it). */
  history: HistorySource;
  /** LLM seam (subprocess, in-process SDK, or a mock for tests). */
  runner: ModelRunner;
  /** Partial OM config; merged over defaults and validated. */
  config?: Partial<OmConfig>;
  /** Parent session id for one-time memory seeding (fork/clone). */
  forkParentSessionId?: string;
  /** Outward events; missing handlers are no-ops. */
  sink?: Partial<EventSink>;
  /** Override the ledger file path (default: <root>/<sessionId>/ledger.jsonl). */
  ledgerFile?: string;
  log?: (msg: string) => void;
}

export interface OmSession {
  orchestrator: OmOrchestrator;
  memory: MemoryStore;
  ledger: FileLedgerStore;
  config: OmConfig;
}

const noop = () => {};

/**
 * Build the full OM session. The returned orchestrator starts with the gate
 * RESTORED from the ledger (call setEnabled(true) to turn it on).
 */
export function createOmSession(opts: OmSessionOptions): OmSession {
  const config = resolveConfig(opts.config);
  // Shared project-level memory (v0.7): <root>/shared, read-only for sessions.
  const sharedDir = config.shared.enabled ? path.join(opts.root, 'shared') : null;
  const memory = new MemoryStore(opts.root, { sharedDir });
  const ledger = new FileLedgerStore({
    file: opts.ledgerFile ?? defaultLedgerFile(opts.root, opts.sessionId),
    onCorrupt: (line, err) => opts.log?.(`ledger line ${line}: ${err}`),
  });
  const sink: EventSink = {
    onStatus: noop,
    onCompactionBlock: noop,
    onRunStarted: noop,
    onRunFinished: noop,
    onError: noop,
    ...opts.sink,
  };
  const orchestrator = new OmOrchestrator({
    config,
    sessionId: opts.sessionId,
    forkParentSessionId: opts.forkParentSessionId,
    history: opts.history,
    ledger,
    runner: opts.runner,
    memory,
    sink,
    log: opts.log,
  });
  orchestrator.restoreEnabled();
  return { orchestrator, memory, ledger, config };
}
