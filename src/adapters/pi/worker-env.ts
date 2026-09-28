/**
 * S6: env-var names shared between the runner (sets them on worker
 * subprocesses) and worker.ts (reads them inside the subprocess).
 * Single source of truth for the literals.
 */
export const OM_WORKER_ENV = 'OM_WORKER';
export const OM_WORKER_DIR_ENV = 'OM_WORKER_DIR';
