# Compaction Retry

Compaction times out after 120 seconds without an upstream stream event. It has
no total-generation deadline: reasoning and text events both reset the inactivity
deadline. A reasoning-start event alone does not disable the watchdog. A provider
that thinks silently without sending any events is indistinguishable from a
stalled connection and is subject to the same inactivity deadline.

On inactivity or a provider request timeout (including HTTP 408/504), the current
attempt is cancelled and cleaned up before immediately switching models. There
is no retry backoff for these compaction timeouts. The model order is:

1. The provider's small model, honoring `small_model` when configured.
2. The model configured for `agent.compaction`.
3. The model on the conversation's compaction request.

Unconfigured optional stages and duplicate provider/model pairs are skipped.
Context overflow also advances this ladder. Other failures retain the existing
retry policy. User cancellation does not retry. Once the ladder is exhausted,
compaction reports an error and releases the busy state rather than looping.

Each attempt converts the original summary input for its own model. Discarded
partial summaries are removed; only the final attempt can publish a completed
compaction, run PostCompact hooks, or enqueue an automatic continuation.

## Provider retry dispatch

Every provider failure goes through one dispatch table before any backoff is
scheduled. The base layer covers every HTTP `APIError` with a 4xx or 5xx status
and every recognised network failure with the same exponential backoff: 2s
initial delay, doubling per attempt, 25% jitter, capped at 30s, with five
retries after the first attempt.

| Branch | Failures | Behaviour |
| --- | --- | --- |
| `rate_limit` | HTTP 429 and 503, rate-limit usage errors | Retries with the base backoff, honoring `retry-after` and `retry-after-ms` when present. |
| `auth` | HTTP 401 and 403 | One bounded retry, giving the provider's in-request auth loader a chance to refresh credentials. A second auth failure stops. |
| `compaction` | HTTP 413 and parsed context overflow | Never resent unchanged. The processor hands the turn to compaction. |
| `http` | Remaining HTTP 400–599 | Retries with the base backoff. `retry-after` headers are not honored outside `rate_limit`. |
| `network` | Fetch, DNS, socket, timeout and recognised provider-network errors | Retries with the base backoff. |
| `protocol` | Incomplete, empty and reasoning-only truncated responses | Retries with the base backoff while the processor's admission gates allow it. |
| `fallback` | Unrecognised failures | Reconnects 3s, 6s, 6s, then surfaces the error. |
| `terminal` | User abort, missing API key, output length, structured output, content filter, rejected signed reasoning state | Never retried. |

When a retryable failure stops, the session logs a `retry stopped` warning with
`reason` (`gated` or `exhausted`), `branch`, `status` when known, `attempt`,
`maxRetries`, `provider`, the error message, and the processor gate state
(`aborted`, `blocked`, `needsCompaction`, `anyToolCalled`,
`pendingToolExecutions`, `suppressedActivity`).
