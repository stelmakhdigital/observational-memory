/**
 * Minimal structural types for the pi-coding-agent extension surface used by
 * the adapter. Structural typing (no import of the pi package) keeps this
 * package dependency-free; the shapes mirror pi ≥ 0.86.1 (verified against
 * dist/core/extensions/types.d.ts and dist/core/session-manager.d.ts).
 */
import type { ModelRef } from '../../core/config.js';

export interface PiUsage {
  input: number;
  output: number;
  totalTokens: number;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

export interface PiEntry {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
  /** type === 'message' */
  message?: {
    role: string;
    content: unknown;
    toolName?: string;
    usage?: PiUsage;
    [k: string]: unknown;
  };
  /** type === 'custom' */
  customType?: string;
  data?: unknown;
}

export interface PiSessionManager {
  getEntries(): PiEntry[];
  getBranch(fromId?: string): PiEntry[];
  getSessionId(): string;
  getHeader(): { id: string; parentSession?: string; cwd: string; timestamp: string };
}

export interface PiUI {
  setStatus(key: string, text: string | undefined): void;
  notify(message: string, type?: 'info' | 'warning' | 'error'): void;
  setWidget(key: string, content: string[] | undefined, options?: { placement?: string }): void;
}

export interface PiContextUsage {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

export interface PiContext {
  ui: PiUI;
  hasUI: boolean;
  cwd: string;
  sessionManager: PiSessionManager;
  isIdle(): boolean;
  getContextUsage(): PiContextUsage | undefined;
  compact(options?: {
    customInstructions?: string;
    onComplete?: (result: unknown) => void;
    onError?: (error: Error) => void;
  }): void;
  model?: { provider: string; id: string } | undefined;
}

export interface PiCommandContext extends PiContext {
  waitForIdle(): Promise<void>;
}

export interface PiCompactPreparation {
  firstKeptEntryId: string;
  tokensBefore: number;
  [k: string]: unknown;
}

export interface PiApi {
  on(
    event: string,
    handler: (
      event: unknown,
      ctx: PiContext,
    ) => void | Promise<void> | { cancel?: boolean; compaction?: { summary: string; firstKeptEntryId: string; tokensBefore: number; [k: string]: unknown } } | Promise<unknown> | unknown,
  ): void;
  appendEntry<T = unknown>(customType: string, data?: T): void;
  sendMessage(
    message: { customType: string; content: string; display: boolean; details?: unknown },
    options?: { triggerTurn?: boolean; deliverAs?: 'steer' | 'followUp' | 'nextTurn' },
  ): void;
  registerCommand(name: string, options: {
    description?: string;
    handler: (args: string, ctx: PiCommandContext) => Promise<void>;
  }): void;
  exec?(command: string, args: string[], options?: { cwd?: string; timeout?: number }): Promise<{
    stdout: string;
    stderr: string;
    code: number;
  }>;
}

export interface PiModelRef extends ModelRef {
  /** Free-form pattern fallback; see ModelRef.id. */
}
