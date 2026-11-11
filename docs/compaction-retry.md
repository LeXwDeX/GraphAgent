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

The first three stages above form the clean ladder: each sends a clean request
with no tools, no system text, and size-reduced history. `compaction.mode`
selects whether compaction uses only that ladder or also tries a shared request.

## Compaction request modes

`compaction.mode` accepts `small` (default), `shared`, and `auto`. The legacy
and current configuration formats both accept it, and migration preserves the
value.

| Mode | Request shape | Attempt order |
| --- | --- | --- |
| `small` | Clean request. | The clean ladder, unchanged. |
| `shared` | Reuses the main request's cached system and tool prefix. | The shared request first, then the clean ladder. |
| `auto` | Prices both shapes. | Estimated cost ascending. |

```jsonc
{
  "compaction": {
    "mode": "shared"
  }
}
```

`small` is the default and needs no configuration.

### Shared prefix

A shared request reuses the system text, tool set, `tool_choice`, and permission
rules of the session's last canonical main request, and appends only the
summarization directive. The message segment is rebuilt from persisted history,
so the cache guarantee covers the system and tool prefix, not the whole prompt.
Turns that reshape the tool set or `tool_choice` — structured-output turns and
the closing step — do not record a prefix.

The shared request is used only when all of these guards hold:

- the session recorded a prefix from a prior canonical request;
- the prefix belongs to the same instance directory;
- it was recorded for the same agent;
- the recorded provider/model still resolves.

Otherwise compaction silently falls back to the clean ladder. Because the prefix
is in-memory only, a process restart also loses it. A committed compaction
invalidates it, and deleting the session or disposing its directory clears it.

### Tool refusal

A shared request sets `toolPolicy: "refuse"`. Tools stay in the request so the
prefix remains intact, but no tool can execute. If the model still calls a
tool, that attempt is discarded even when the stream finished normally: its
message is removed, no summary is persisted, and compaction moves to the next
candidate. When the shared request was the last candidate, compaction reports
an error and returns to idle instead of saving the summary.

### Automatic selection

`auto` compares clean and shared requests using the price usage accounting would
charge: the applicable context tier, the over-200K schedule, or the base price,
plus a fixed output-token estimate. For a non-overflow compaction the shared
shape is credited with a conservative cache discount for the recorded prefix
only. Cache writes are ignored because the main request already paid for the
prefix. A zero cache-read price counts as no discount.

Candidates are ordered by estimated cost ascending. Equal costs break ties by
shape in the order `small`, `shared`, `agent`, `conversation`, then by provider
and model ID, so selection is deterministic. Under common price structures
`auto` still chooses `small`. The value of `shared` is that it uses the main
model's own context window and capabilities and avoids a second model; it is
not a promise of lower cost.

## Provider retry dispatch

Every provider failure goes through one dispatch table before any backoff is
scheduled. The base layer covers every HTTP `APIError` with a 4xx or 5xx status
and every recognised network failure with the same exponential backoff: 2s
initial delay, doubling per attempt, 25% jitter, capped at 30s, with five
retries after the first attempt. A `rate_limit` answer with a usable
`retry-after` or `retry-after-ms` header waits for the value the provider asked
for instead; that value is capped only at the 32-bit timer limit.

| Branch | Failures | Behaviour |
| --- | --- | --- |
| `rate_limit` | HTTP 429 and 503, rate-limit usage errors | Retries with the base backoff, honoring `retry-after` and `retry-after-ms` when present. |
| `auth` | HTTP 401 and 403 | One bounded retry, giving the provider's in-request auth loader a chance to refresh credentials. A second auth failure stops. A missing-API-key `AuthError` enters the table as a terminal `auth` decision instead. |
| `compaction` | HTTP 413 and parsed context overflow | Never resent unchanged. The processor hands the turn to compaction. |
| `http` | Remaining HTTP 400–599 | The wire policy retries with the base backoff; `retry-after` headers are not honored outside `rate_limit`. Goal recovery treats a deterministic 4xx as final and pauses visibly, while a flagged `isRetryable` or a recognised transient message/body stays recoverable. |
| `network` | Fetch, DNS, socket, timeout and recognised provider-network errors | Retries with the base backoff. |
| `protocol` | Incomplete, empty and reasoning-only truncated responses | Retries with the base backoff while the processor's admission gates allow it. |
| `fallback` | Unrecognised failures | Reconnects 3s, 6s, 6s, then surfaces the error. |
| `terminal` | User abort, missing API key, output length, structured output, content filter, rejected signed reasoning state | Never retried. |

When a retryable failure stops, the session logs a `retry stopped` warning with
`reason` (`gated` or `exhausted`), `branch`, `status` when known, `attempt`,
`maxRetries`, `provider`, the error message, and the processor gate state
(`aborted`, `blocked`, `needsCompaction`, `anyToolCalled`,
`pendingToolExecutions`, `suppressedActivity`).

The opt-in experimental native runtime (`GRAPHAGENT_NATIVE_LLM`, off
by default) disables `RequestExecutor` retries when the session processor drives
the request, so this dispatch table owns retry timing and the total attempt
count. Direct native-runtime calls that bypass the processor keep the executor's
own bounded budget of two retries after the first attempt.
