/**
 * Scoped file tools for consolidator worker subprocesses (v1.1 scope hardening).
 *
 * The consolidator worker runs with `--no-builtin-tools` + this extension: it
 * can ONLY read/write/edit/ls/grep inside its session memory dir. No bash, no
 * network, no writes outside the dir — path containment is enforced after
 * resolution (rejects `..` traversal and absolute paths outside the root).
 *
 * Pure logic (no pi imports) so it is unit-testable; the pi tool wiring lives
 * in worker.ts.
 */
import { promises as fs, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Type, type TSchema } from 'typebox';

export interface ScopedToolResult {
  content: { type: 'text'; text: string }[];
  details?: unknown;
  isError?: boolean;
}

/** Structural subset of pi's ToolDefinition (execute may ignore trailing params). */
export interface ScopedTool {
  name: string;
  label: string;
  description: string;
  parameters: TSchema;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: unknown,
    ctx?: unknown,
  ) => Promise<ScopedToolResult>;
}

const MAX_READ_BYTES = 100_000;
const MAX_GREP_MATCHES = 100;
const MAX_GREP_FILES = 2000;

const ok = (text: string, details?: unknown): ScopedToolResult => ({
  content: [{ type: 'text', text }],
  ...(details !== undefined ? { details } : {}),
});
const err = (message: string): ScopedToolResult => ({
  content: [{ type: 'text', text: `ERROR: ${message}` }],
  isError: true,
});

/**
 * Resolve `p` against `dir` and enforce containment.
 * Rejects traversal and outside absolute paths. Returns the resolved path.
 */
export function resolveContained(dir: string, p: string): string {
  const root = path.resolve(dir);
  const resolved = path.resolve(root, p ?? '');
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`path escapes the session dir: ${p}`);
  }
  return resolved;
}

function str(params: Record<string, unknown>, key: string): string {
  const v = params[key];
  if (typeof v !== 'string' || v.length === 0) throw new Error(`missing string param: ${key}`);
  return v;
}

export function createScopedFileTools(dir: string): ScopedTool[] {
  const root = path.resolve(dir);

  const readTool: ScopedTool = {
    name: 'read',
    label: 'Read file',
    description: `Read a text file inside the session memory dir. Params: path (relative to the dir).`,
    parameters: Type.Object({ path: Type.String() }),
    async execute(_id, params) {
      try {
        const p = resolveContained(root, str(params, 'path'));
        const text = await fs.readFile(p, 'utf8');
        if (Buffer.byteLength(text) > MAX_READ_BYTES) {
          return ok(
            text.slice(0, MAX_READ_BYTES) + `\n[truncated: file exceeds ${MAX_READ_BYTES} chars]`,
          );
        }
        return ok(text);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  };

  const writeTool: ScopedTool = {
    name: 'write',
    label: 'Write file',
    description: `Create or overwrite a file inside the session memory dir. Params: path, content.`,
    parameters: Type.Object({ path: Type.String(), content: Type.String() }),
    async execute(_id, params) {
      try {
        const p = resolveContained(root, str(params, 'path'));
        mkdirSync(path.dirname(p), { recursive: true });
        writeFileSync(p, str(params, 'content'), 'utf8');
        return ok(`wrote ${path.relative(root, p) || '.'}`);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  };

  const editTool: ScopedTool = {
    name: 'edit',
    label: 'Edit file',
    description: `Replace an exact, unique text fragment in a file. Params: path, oldText, newText.
Fails unless oldText occurs exactly once.`,
    parameters: Type.Object({ path: Type.String(), oldText: Type.String(), newText: Type.String() }),
    async execute(_id, params) {
      try {
        const p = resolveContained(root, str(params, 'path'));
        const content = await fs.readFile(p, 'utf8');
        const oldText = str(params, 'oldText');
        const count = content.split(oldText).length - 1;
        if (count === 0) return err('oldText not found');
        if (count > 1) return err(`oldText occurs ${count} times — must be unique`);
        writeFileSync(p, content.replace(oldText, str(params, 'newText')), 'utf8');
        return ok('edited');
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  };

  const lsTool: ScopedTool = {
    name: 'ls',
    label: 'List files',
    description: 'Recursively list files in the session memory dir. Params: path (optional, default ".").',
    parameters: Type.Object({ path: Type.Optional(Type.String()) }),
    async execute(_id, params) {
      try {
        const base = resolveContained(root, (typeof params.path === 'string' && params.path) || '.');
        const lines: string[] = [];
        const walk = (d: string, depth: number) => {
          if (depth > 4) return;
          for (const e of readdirSync(d)) {
            const full = path.join(d, e);
            const st = statSync(full);
            if (st.isDirectory()) {
              lines.push(`${e}/`);
              walk(full, depth + 1);
            } else {
              lines.push(`${path.relative(root, full)}  (${st.size}b)`);
            }
          }
        };
        walk(base, 0);
        return ok(lines.length ? lines.join('\n') : '(empty)');
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  };

  const grepTool: ScopedTool = {
    name: 'grep',
    label: 'Search files',
    description: 'Regex-search file contents (text files). Params: pattern, path (optional dir/file).',
    parameters: Type.Object({ pattern: Type.String(), path: Type.Optional(Type.String()) }),
    async execute(_id, params) {
      try {
        const base = resolveContained(root, (typeof params.path === 'string' && params.path) || '.');
        const re = new RegExp(str(params, 'pattern'), 'g');
        const matches: string[] = [];
        let files = 0;
        const walk = (d: string, depth: number) => {
          if (depth > 4 || files > MAX_GREP_FILES) return;
          for (const e of readdirSync(d)) {
            if (matches.length >= MAX_GREP_MATCHES) return;
            const full = path.join(d, e);
            const st = statSync(full);
            if (st.isDirectory()) walk(full, depth + 1);
            else if (/\.(md|ts|js|json|txt|log)$/i.test(e)) {
              files++;
              let content: string;
              try {
                content = readFileSync(full, 'utf8');
              } catch {
                continue;
              }
              if (Buffer.byteLength(content) > MAX_READ_BYTES) continue;
              const lines = content.split(/\r?\n/);
              for (let i = 0; i < lines.length && matches.length < MAX_GREP_MATCHES; i++) {
                re.lastIndex = 0;
                if (re.test(lines[i]!)) {
                  matches.push(`${path.relative(root, full)}:${i + 1}: ${lines[i]!.slice(0, 300)}`);
                }
              }
            }
          }
        };
        if (existsSync(base) && statSync(base).isFile()) {
          const content = readFileSync(base, 'utf8');
          const lines = content.split(/\r?\n/);
          for (let i = 0; i < lines.length && matches.length < MAX_GREP_MATCHES; i++) {
            re.lastIndex = 0;
            if (re.test(lines[i]!)) matches.push(`${path.relative(root, base)}:${i + 1}: ${lines[i]!.slice(0, 300)}`);
          }
        } else {
          walk(base, 0);
        }
        return ok(matches.length ? matches.join('\n') : '(no matches)');
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  };

  return [readTool, writeTool, editTool, lsTool, grepTool];
}
