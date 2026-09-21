/**
 * MemoryStore: durable per-session long-term memory files (FR-4, FR-5).
 *
 * Layout: <root>/<sessionId>/{INDEX.md, JOURNEY.md, <topic>.md}
 * - Topic files carry front-matter (topic, description, session) — the
 *   orchestrator renders INDEX.md from it (FR-4.5).
 * - JOURNEY.md: append-mostly descriptive prose history (FR-5).
 * - Fork-seed: a new session dir is seeded once from its parent (FR-4.4);
 *   transient IPC (`.runs/`, seed flag) is not seeded.
 * - None of this is rolled back by agent tree navigation.
 *
 * All operations are synchronous: the orchestrator invokes them from idle
 * paths only (NFR-5 — the master session is never blocked on LLM work; local
 * fs work on bounded small files is acceptable there).
 */
import {
  constants as fsConstants,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import type { MemoryRoot, TopicSummary } from './types.js';

const JOURNEY_FILE = 'JOURNEY.md';
const INDEX_FILE = 'INDEX.md';
const SEED_FLAG = '.om-seeded-from';

/** File-safe slug for dir/file names (keeps latin+cyrillic word chars). */
export function sanitizeName(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9а-яё\-_]+/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64);
  return s || 'unnamed';
}

export class MemoryStore implements MemoryRoot {
  constructor(private readonly root: string) {}

  sessionDir(sessionId: string): string {
    return path.join(this.root, sanitizeName(sessionId));
  }

  exists(sessionId: string): boolean {
    return existsSync(this.sessionDir(sessionId));
  }

  seedFrom(parentSessionId: string, sessionId: string): boolean {
    if (parentSessionId === sessionId) return false;
    const parentDir = this.sessionDir(parentSessionId);
    const childDir = this.sessionDir(sessionId);
    const flag = path.join(childDir, SEED_FLAG);
    mkdirSync(childDir, { recursive: true });
    if (existsSync(flag)) return false; // one-time seeding (FR-4.4)
    if (existsSync(parentDir)) {
      for (const e of readdirSync(parentDir)) {
        if (e === SEED_FLAG || e === '.runs') continue; // skip transient state
        const src = path.join(parentDir, e);
        const dst = path.join(childDir, e);
        if (e === 'extracted' && existsSync(src)) {
          // structured extractor values are part of durable memory (v2+)
          try {
            cpSync(src, dst, { recursive: true, force: false });
          } catch {
            /* seed is best-effort (NFR-1) */
          }
          continue;
        }
        try {
          copyFileSync(src, dst, fsConstants.COPYFILE_EXCL);
        } catch {
          if (!existsSync(dst)) copyFileSync(src, dst); // don't clobber existing child files
        }
      }
    }
    writeFileSync(flag, parentSessionId, 'utf8');
    return true;
  }

  listTopics(sessionId: string): TopicSummary[] {
    const dir = this.sessionDir(sessionId);
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return [];
    }
    const out: TopicSummary[] = [];
    for (const e of entries) {
      if (!e.endsWith('.md') || e === INDEX_FILE || e === JOURNEY_FILE) continue;
      let content: string;
      try {
        content = readFileSync(path.join(dir, e), 'utf8');
      } catch {
        continue;
      }
      const fm = parseFrontMatter(content);
      out.push({
        file: e,
        topic: fm['topic'] ?? e.replace(/\.md$/, ''),
        description: fm['description'] ?? '',
        session: fm['session'] ?? '',
      });
    }
    out.sort((a, b) => a.file.localeCompare(b.file));
    return out;
  }

  readJourney(sessionId: string): string {
    try {
      return readFileSync(path.join(this.sessionDir(sessionId), JOURNEY_FILE), 'utf8');
    } catch {
      return '';
    }
  }

  // ---- structured extractors (v2) -----------------------------------------

  private extractedDir(sessionId: string): string {
    return path.join(this.sessionDir(sessionId), 'extracted');
  }

  loadExtracted(sessionId: string, id: string): unknown {
    try {
      return JSON.parse(
        readFileSync(path.join(this.extractedDir(sessionId), `${sanitizeName(id)}.json`), 'utf8'),
      );
    } catch {
      return undefined;
    }
  }

  saveExtracted(sessionId: string, id: string, value: unknown): void {
    const dir = this.extractedDir(sessionId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `${sanitizeName(id)}.json`), JSON.stringify(value, null, 2) + '\n', 'utf8');
  }

  /** Stored extractor ids (file names without extension). */
  listExtracted(sessionId: string): string[] {
    try {
      return readdirSync(this.extractedDir(sessionId))
        .filter((e) => e.endsWith('.json'))
        .map((e) => e.replace(/\.json$/, ''))
        .sort();
    } catch {
      return [];
    }
  }

  renderIndex(sessionId: string): void {
    const dir = this.sessionDir(sessionId);
    mkdirSync(dir, { recursive: true });
    const topics = this.listTopics(sessionId);
    const lines = [
      '# Memory Index',
      '',
      '_Rendered by the orchestrator from topic front-matter. Do not edit._',
      '',
    ];
    if (topics.length === 0) lines.push('(no durable topics yet)');
    else
      for (const t of topics)
        lines.push(`- **${t.topic}** — ${t.description || '(no description)'} [${t.file}]`);
    writeFileSync(path.join(dir, INDEX_FILE), lines.join('\n') + '\n', 'utf8');
  }
}

/** Minimal front-matter parser (top-level `key: value` lines). Deterministic. */
export function parseFrontMatter(content: string): Record<string, string> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!m) return {};
  const out: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_\-]+):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]!] = kv[2]!.trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

/** Build topic file content with front-matter. Deterministic. */
export function renderTopicFile(
  topic: string,
  description: string,
  session: string,
  body: string,
): string {
  return `---\ntopic: ${topic}\ndescription: ${description}\nsession: ${session}\n---\n\n${body.trim()}\n`;
}

/** Render the memory-map section of a compaction block from topic summaries. */
export function renderMemoryMap(topics: readonly TopicSummary[]): string {
  if (topics.length === 0) return '';
  return topics
    .map((t) => `- ${t.topic}${t.description ? `: ${t.description}` : ''}`)
    .join('\n');
}
