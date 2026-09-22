import { describe, expect, it } from 'vitest';
import {
  parseConsolidationReport,
  parseObserverOutput,
} from '../../src/core/worker-output.js';
import { renderObserverPrompt } from '../../src/core/prompts/observer.js';
import { renderConsolidatorPrompt as rc2 } from '../../src/core/prompts/consolidator.js';

describe('parseObserverOutput', () => {
  it('parses the strict block', () => {
    const out = `Sure, here you go:
OBSERVATIONS
- Decided to use vitest
- Fixed bug in foo.ts (line 42)
END_OBSERVATIONS
Done!`;
    const r = parseObserverOutput(out);
    expect(r.ok).toBe(true);
    expect(r.observations).toEqual([
      { text: 'Decided to use vitest', priority: 'routine' },
      { text: 'Fixed bug in foo.ts (line 42)', priority: 'routine' },
    ]);
  });

  it('handles "(no observations)"', () => {
    const r = parseObserverOutput('OBSERVATIONS\n(no observations)\nEND_OBSERVATIONS');
    expect(r.ok).toBe(true);
    expect(r.observations).toEqual([]);
  });

  it('falls back to bullets without the strict block', () => {
    const r = parseObserverOutput('Here are notes:\n- a note\n* another\n');
    expect(r.ok).toBe(true);
    expect(r.observations).toEqual([
      { text: 'a note', priority: 'routine' },
      { text: 'another', priority: 'routine' },
    ]);
  });

  it('parses priority tags P0/P1/P2 (v0.4)', () => {
    const r = parseObserverOutput('OBSERVATIONS\n- [P0] critical decision\n- [P1] completed work\n- [P2] routine detail\nEND_OBSERVATIONS');
    expect(r.ok).toBe(true);
    expect(r.observations).toEqual([
      { text: 'critical decision', priority: 'critical' },
      { text: 'completed work', priority: 'important' },
      { text: 'routine detail', priority: 'routine' },
    ]);
  });

  it('keeps a short bare paragraph as a single observation', () => {
    const r = parseObserverOutput('User prefers dark mode in the editor.');
    expect(r.ok).toBe(true);
    expect(r.observations).toEqual([{ text: 'User prefers dark mode in the editor.', priority: 'routine' }]);
  });

  it('returns ok=false for empty/garbage output', () => {
    const r = parseObserverOutput('');
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
    expect(parseObserverOutput('(no observations)').ok).toBe(true);
  });

  it('caps the number of observations', () => {
    const many = Array.from({ length: 40 }, (_, i) => `- obs ${i}`).join('\n');
    const r = parseObserverOutput(many);
    expect(r.observations.length).toBe(24);
  });
});

describe('parseConsolidationReport', () => {
  it('parses a full report', () => {
    const out = `I wrote the files.
CONSOLIDATION_REPORT
topics: auth.md, tools.md
journey_changed: true
consumed: om-1, om-2, om-3
dropped: om-4
END_CONSOLIDATION_REPORT
bye`;
    const r = parseConsolidationReport(out);
    expect(r.ok).toBe(true);
    expect(r.topics).toEqual(['auth.md', 'tools.md']);
    expect(r.journeyChanged).toBe(true);
    expect(r.consumedIds).toEqual(['om-1', 'om-2', 'om-3']);
    expect(r.droppedIds).toEqual(['om-4']);
  });

  it('treats "none" as empty and journey defaults to false', () => {
    const out = `CONSOLIDATION_REPORT
topics: none
consumed: om-1
END_CONSOLIDATION_REPORT`;
    const r = parseConsolidationReport(out);
    expect(r.ok).toBe(true);
    expect(r.topics).toEqual([]);
    expect(r.journeyChanged).toBe(false);
    expect(r.consumedIds).toEqual(['om-1']);
  });

  it('returns ok=false when the block is missing', () => {
    const r = parseConsolidationReport('I could not finish.');
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
    expect(r.consumedIds).toEqual([]);
  });
});

describe('prompts', () => {
  it('observer prompt embeds chunk, overlap, and strict format', () => {
    const p = renderObserverPrompt(
      {
        runId: 'r1',
        role: 'observer',
        chunk: { text: 'history here', overlapContext: 'prev', coversUpToId: 'm42' },
      },
      { sessionLabel: 'proj-x' },
    );
    expect(p).toContain('history here');
    expect(p).toContain('prev');
    expect(p).toContain('up to m42');
    expect(p).toContain('OBSERVATIONS');
    expect(p).toContain('END_OBSERVATIONS');
    expect(p).toContain('(proj-x)');
  });

  it('observer prompt throws without chunk', () => {
    expect(() => renderObserverPrompt({ runId: 'r1', role: 'observer' }, {})).toThrow();
  });

  it('consolidator prompt embeds pool and report format', () => {
    const p = rc2(
      {
        runId: 'r2',
        role: 'consolidator',
        pool: {
          observations: [
            { id: 'om-1', coversUpToId: 'm1', content: 'note one', tokenCount: 5, createdAt: 'x' },
          ],
          sessionDir: '/tmp/s1',
          journey: 'old journey',
        },
      },
      { session: 's1', journeyTargetTokens: 1000 },
    );
    expect(p).toContain('[om-1]');
    expect(p).toContain('note one');
    expect(p).toContain('/tmp/s1');
    expect(p).toContain('CONSOLIDATION_REPORT');
    expect(p).toContain('journey_changed');
  });

  it('consolidator prompt throws without pool', () => {
    expect(() => rc2({ runId: 'r2', role: 'consolidator' }, { session: 's', journeyTargetTokens: 1 })).toThrow();
  });
});
