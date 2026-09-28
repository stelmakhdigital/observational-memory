/**
 * R7: invalid since/until dates must throw OmError — before the fix they
 * became NaN and silently disabled the filter (NaN comparisons are always
 * false, so ALL observations passed through).
 */
import { describe, expect, it } from 'vitest';
import { recallSearch, type RecallDoc } from '../../src/core/recall.js';
import { OmError } from '../../src/core/types.js';

const obsDoc: RecallDoc = {
  kind: 'observation',
  id: 'om-20250921120000-000001',
  title: 'observation om-20250921120000-000001',
  text: 'websocket sync protocol decided',
  at: '2025-09-21T12:00:00Z',
  status: 'active',
};

const topicDoc: RecallDoc = {
  kind: 'topic',
  id: 'sync.md',
  title: 'Sync',
  text: 'websocket sync protocol decided',
  at: '',
};

function catchErr(fn: () => unknown): OmError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(OmError);
    return e as OmError;
  }
  throw new Error('expected OmError was not thrown');
}

describe('recall temporal validation (R7)', () => {
  it('invalid since → OmError with code invalid-since', () => {
    const err = catchErr(() => recallSearch([obsDoc, topicDoc], 'websocket', { since: 'not-a-date' }));
    expect(err.code).toBe('invalid-since');
    expect(err.message).toContain('not-a-date');
  });

  it('invalid until → OmError with code invalid-until', () => {
    const err = catchErr(() => recallSearch([obsDoc, topicDoc], 'websocket', { until: 'also-bad' }));
    expect(err.code).toBe('invalid-until');
    expect(err.message).toContain('also-bad');
  });

  it('valid filters still work (regression)', () => {
    expect(recallSearch([obsDoc, topicDoc], 'websocket', { since: '2025-09-20' }).length).toBe(2);
    expect(recallSearch([obsDoc, topicDoc], 'websocket', { since: '2025-09-22' }).length).toBe(1); // topic only
    expect(recallSearch([obsDoc, topicDoc], 'websocket', { until: '2025-09-20' }).length).toBe(1); // topic only
  });
});
