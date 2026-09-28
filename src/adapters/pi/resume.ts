/**
 * Auto-resume support (S4: extracted from index.ts).
 */

/**
 * Auto-resume prompt (ported from pi-observational-memory, MIT): hidden
 * custom message that continues the agent after an auto-compaction left an
 * unfinished task. Terse on purpose — the freshly-rendered compaction block
 * already carries the recovered context.
 */
export const RESUME_PROMPT =
  '[automatic] Your context was just compacted to free space; no user message was sent. ' +
  'Continue exactly where you left off, as if the compaction had not happened.';

/**
 * Pi's retryable-error detection (ported from pi-observational-memory, MIT):
 * pi auto-retries these itself, so OM must not add a resume turn on top.
 */
export const RETRYABLE_ERROR_RE =
  /overloaded|provider.?returned.?error|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|connection.?lost|websocket.?closed|websocket.?error|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|ended without|http2 request did not get a response|timed? out|timeout|terminated|retry delay/i;

interface LastAssistantLike {
  stopReason?: string;
  errorMessage?: string;
}

/**
 * Did the just-ended run leave the task UNFINISHED (so pi will not continue
 * it on its own)?
 *
 * Our auto-compaction fires at agent_end — the run is already settled — so
 * the mid-run equivalent of the reference's turnWillContinue (pending tool
 * results at compaction time) is the run's terminal stopReason:
 *  - 'length': output truncated mid-task → unfinished;
 *  - 'error' with a NON-retryable message: pi will not auto-retry →
 *    unfinished. Retryable errors are retried by pi itself (a resume message
 *    would double-continue); 'aborted' (user cancel) and clean stops are left
 *    to stop, exactly as if no compaction had happened.
 */
export function runEndedUnfinished(messages: unknown): boolean {
  if (!Array.isArray(messages)) return false;
  let last: LastAssistantLike | null = null;
  for (const m of messages) {
    const msg = m as { role?: unknown } | null;
    if (msg && typeof msg === 'object' && msg.role === 'assistant') last = m as LastAssistantLike;
  }
  if (!last || typeof last.stopReason !== 'string') return false;
  if (last.stopReason === 'length') return true;
  if (last.stopReason === 'error') {
    // No errorMessage: pi's retry logic can't match a pattern → no auto-retry.
    return typeof last.errorMessage === 'string' ? !RETRYABLE_ERROR_RE.test(last.errorMessage) : true;
  }
  return false;
}
