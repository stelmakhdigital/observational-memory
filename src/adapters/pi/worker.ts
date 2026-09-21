/**
 * OM worker extension — loaded into worker subprocesses via
 * `pi -p --no-builtin-tools -e <this file>` (see PiSubprocessRunner).
 *
 * Roles (env OM_WORKER):
 *  - observer:     registers NO tools (a pure text mapper; --no-builtin-tools
 *                  means the worker literally has no tools).
 *  - consolidator: registers ONLY scoped read/write/edit/ls/grep contained in
 *                  the session memory dir (env OM_WORKER_DIR). No bash, no
 *                  writes outside the dir (v1.1 scope hardening).
 *
 * This file must stay import-light (pi loads it with jiti inside the worker).
 */
import { createScopedFileTools, type ScopedTool } from './scoped-tools.js';
import type { PiApi } from './types.js';

export default function omWorker(pi: PiApi): void {
  const role = process.env.OM_WORKER;
  if (role !== 'consolidator') return; // observer (or unset): no tools
  const dir = process.env.OM_WORKER_DIR ?? process.cwd();
  for (const tool of createScopedFileTools(dir)) {
    pi.registerTool(tool as never);
  }
}

/** Exposed for tests / future roles. */
export { createScopedFileTools };
export type { ScopedTool };
