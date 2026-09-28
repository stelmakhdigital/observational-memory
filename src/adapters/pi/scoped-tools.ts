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
import { promises as fs, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
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

/**
 * A15: read a file capped at MAX_READ_BYTES BYTES (not chars — the old code
 * confused Buffer.byteLength with string slice). utf8-decoding the subarray
 * is safe when the cap lands mid-character: Node replaces the dangling byte
 * with U+FFFD instead of throwing.
 */
export function readCapped(p: string): { text: string; truncated: boolean } {
  const buf = readFileSync(p);
  if (buf.length <= MAX_READ_BYTES) return { text: buf.toString('utf8'), truncated: false };
  return { text: buf.subarray(0, MAX_READ_BYTES).toString('utf8'), truncated: true };
}
const MAX_GREP_MATCHES = 100;

/**
 * S5: shared bounded directory walk (was duplicated in ls and grep).
 * Depth cap + real-root containment live here; the caps on the number of
 * files/bytes scanned are caller-specific (grep only) and are expressed via
 * stopRecurse (checked before descending into a subdirectory) and stopInLoop
 * (checked before each entry of a directory). onFile receives the file size
 * for free (ls needs it; grep ignores it).
 */
export interface WalkOpts {
  maxDepth: number;
  withinRealRoot: (p: string) => boolean;
  onFile: (full: string, name: string, size: number) => void;
  onDir?: (full: string, name: string) => void;
  /** Checked before each entry inside a directory (grep: matches cap). */
  stopInLoop?: () => boolean;
  /** Checked before descending into a subdirectory (grep: files/bytes caps). */
  stopRecurse?: () => boolean;
}

export function walkDir(base: string, opts: WalkOpts): void {
  const walk = (d: string, depth: number) => {
    if (depth > opts.maxDepth) return;
    for (const e of readdirSync(d)) {
      if (opts.stopInLoop?.()) return;
      const full = path.join(d, e);
      const st = statSync(full);
      if (st.isDirectory()) {
        if (!opts.withinRealRoot(full)) continue; // n4: symlinked dir outside
        opts.onDir?.(full, e);
        if (opts.stopRecurse?.()) return;
        walk(full, depth + 1);
      } else {
        if (!opts.withinRealRoot(full)) continue; // n4: symlinked file outside
        opts.onFile(full, e, st.size);
      }
    }
  };
  walk(base, 0);
}

/**
 * S5: the grep line-matching loop, shared between the walked files and the
 * direct-file branch. `push` returns false to stop (matches cap reached).
 */
export function grepFile(
  rel: string,
  content: string,
  re: RegExp,
  push: (match: string) => boolean,
): void {
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    re.lastIndex = 0;
    if (re.test(lines[i]!)) {
      if (!push(`${rel}:${i + 1}: ${lines[i]!.slice(0, 300)}`)) return;
    }
  }
}
// n5: hard caps bounding the grep work (catastrophic-backtracking defense is
// INCOMPLETE without a worker-thread timeout — see audit n5, P2 residual risk).
const MAX_GREP_FILES = 500;
const MAX_GREP_BYTES = 2_000_000;

const ok = (text: string, details?: unknown): ScopedToolResult => ({
  content: [{ type: 'text', text }],
  ...(details !== undefined ? { details } : {}),
});
const err = (message: string): ScopedToolResult => ({
  content: [{ type: 'text', text: `ERROR: ${message}` }],
  isError: true,
});

/**
 * Resolve `p` against `dir` and enforce containment — lexically AND after
 * symlink resolution (n4: a symlink INSIDE the dir must not escape it; fs
 * APIs like readFileSync/statSync follow links).
 *
 * Both the root and the target are resolved on their deepest EXISTING prefix
 * (non-existing write targets: the existing parent + the rest lexically), and
 * the real paths are re-checked for containment. Returns the lexically
 * resolved path (verified safe after the real check).
 */
export function resolveContained(dir: string, p: string): string {
  const root = path.resolve(dir);
  const resolved = path.resolve(root, p ?? '');
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`path escapes the session dir: ${p}`);
  }
  const rootP = realPrefix(root);
  const targetP = realPrefix(resolved);
  if (rootP.real === '' || targetP.real === '') return resolved; // fs root unresolvable — lexical check already passed
  const rootReal = path.join(rootP.real, ...rootP.tail);
  const targetReal = path.join(targetP.real, ...targetP.tail);
  if (targetReal !== rootReal && !targetReal.startsWith(rootReal + path.sep)) {
    throw new Error(`path escapes the session dir (symlink): ${p}`);
  }
  return resolved;
}

/** Realpath of the deepest EXISTING prefix of `p` + the remaining tail. */
function realPrefix(p: string): { real: string; tail: string[] } {
  let probe = p;
  const tail: string[] = [];
  for (;;) {
    try {
      return { real: realpathSync(probe), tail };
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw e; // EACCES etc. — let it fail normally
      const parent = path.dirname(probe);
      if (parent === probe) return { real: '', tail: [] }; // nothing up to / exists
      tail.unshift(path.basename(probe));
      probe = parent;
    }
  }
}

function str(params: Record<string, unknown>, key: string): string {
  const v = params[key];
  if (typeof v !== 'string' || v.length === 0) throw new Error(`missing string param: ${key}`);
  return v;
}

export function createScopedFileTools(dir: string): ScopedTool[] {
  const root = path.resolve(dir);
  // n4: the REAL root — the walks (ls/grep) must not follow symlinks out of it.
  let realRoot = root;
  try {
    realRoot = realpathSync(root);
  } catch {
    /* root doesn't exist yet — lexical root stands */
  }
  const withinRealRoot = (p: string): boolean => {
    try {
      const r = realpathSync(p);
      return r === realRoot || r.startsWith(realRoot + path.sep);
    } catch {
      return true; // broken link — statSync already reported it
    }
  };

  const readTool: ScopedTool = {
    name: 'read',
    label: 'Read file',
    description: `Read a text file inside the session memory dir. Params: path (relative to the dir).`,
    parameters: Type.Object({ path: Type.String() }),
    async execute(_id, params) {
      try {
        const p = resolveContained(root, str(params, 'path'));
        // A15: byte-capped read (multibyte-safe at the cap boundary).
        const { text, truncated } = readCapped(p);
        return ok(
          truncated ? `${text}\n[truncated: file exceeds ${MAX_READ_BYTES} bytes]` : text,
        );
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
        walkDir(base, {
          maxDepth: 4,
          withinRealRoot,
          onDir: (_full, e) => lines.push(`${e}/`),
          onFile: (full, _e, size) => lines.push(`${path.relative(root, full)}  (${size}b)`),
        });
        return ok(lines.length ? lines.join('\n') : '(empty)');
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  };

  const grepTool: ScopedTool = {
    name: 'grep',
    label: 'Search files',
    description: 'Regex-search file contents (text files). Params: pattern, path (optional dir/file). '
      + 'Use SIMPLE patterns (no backreferences, no nested quantifiers like (a+)+). '
      + `Limits: ${MAX_GREP_FILES} files, ${(MAX_GREP_BYTES / 1_000_000).toFixed(0)}MB, ${MAX_GREP_MATCHES} matches.`,
    parameters: Type.Object({ pattern: Type.String(), path: Type.Optional(Type.String()) }),
    async execute(_id, params) {
      try {
        const base = resolveContained(root, (typeof params.path === 'string' && params.path) || '.');
        const re = new RegExp(str(params, 'pattern'), 'g');
        const matches: string[] = [];
        let files = 0;
        let bytes = 0; // n5: total bytes scanned across files
        const pushMatch = (m: string): boolean => {
          if (matches.length >= MAX_GREP_MATCHES) return false;
          matches.push(m);
          return true;
        };
        if (existsSync(base) && statSync(base).isFile()) {
          // A15: byte-capped read (was uncapped readFileSync).
          const { text } = readCapped(base);
          grepFile(path.relative(root, base), text, re, pushMatch);
        } else {
          walkDir(base, {
            maxDepth: 4,
            withinRealRoot,
            stopInLoop: () => matches.length >= MAX_GREP_MATCHES,
            stopRecurse: () => files > MAX_GREP_FILES || bytes > MAX_GREP_BYTES,
            onFile: (full, name) => {
              if (!/\.(md|ts|js|json|txt|log)$/i.test(name)) return;
              files++;
              let content: string;
              try {
                content = readFileSync(full, 'utf8');
              } catch {
                return;
              }
              if (Buffer.byteLength(content) > MAX_READ_BYTES) return;
              bytes += Buffer.byteLength(content); // n5
              grepFile(path.relative(root, full), content, re, pushMatch);
            },
          });
        }
        return ok(matches.length ? matches.join('\n') : '(no matches)');
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  };

  return [readTool, writeTool, editTool, lsTool, grepTool];
}
