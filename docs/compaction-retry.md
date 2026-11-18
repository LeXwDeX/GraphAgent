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
scheduled. An `APIError` first meets the provider error table: provider error
codes and wordings, read top to bottom, where the first row that hits decides.
What the provider reported therefore outranks the status code, and a failure
the table does not name falls through to the branches below. A transient signal
(a flagged `isRetryable`, or a message or body that reads as retryable, such as
a timeout, an overload or a gateway circuit breaker) skips the table's
deterministic-request rows, because gateways report a failing upstream as a 400.

The base layer covers every HTTP `APIError` with a 4xx or 5xx status that the
provider error table does not end, and every recognised network failure with
the same exponential backoff: 2s initial delay, doubling per attempt, 25%
jitter, capped at 30s, with five retries after the first attempt. A `rate_limit`
answer with a usable `retry-after` or `retry-after-ms` header waits for the
value the provider asked for instead; that value is capped only at the 32-bit
timer limit.

| Branch | Failures | Behaviour |
| --- | --- | --- |
| `rate_limit` | HTTP 429 and 503, rate-limit usage errors, DashScope's per-minute allocation (reported under quota names), a native `QuotaExceeded` whose message, body or headers say the limit lifts by itself | Retries with the base backoff, honoring `retry-after` and `retry-after-ms` when present. A 429 that reports a spent quota or balance goes to `terminal` instead. |
| `auth` | HTTP 401 and 403, unless the provider error table names the answer (a 403 that reports a spent quota is not a credential failure) | One bounded retry, giving the provider's in-request auth loader a chance to refresh credentials. A second auth failure stops. A missing-API-key `AuthError` enters the dispatch table as a terminal `auth` decision instead. |
| `compaction` | HTTP 413 and parsed context overflow, including the Moonshot, DashScope and Zhipu wordings | Never resent unchanged. The processor hands the turn to compaction. |
| `http` | Remaining HTTP 400–599: 5xx, a 4xx the provider error table does not name, and a 400 or 422 with a transient signal | The wire policy retries with the base backoff; `retry-after` headers are not honored outside `rate_limit`. Goal recovery treats a deterministic 4xx as final and pauses visibly, while a flagged `isRetryable` or a recognised transient message/body stays recoverable. |
| `network` | Fetch, DNS, socket, timeout and recognised provider-network errors | Retries with the base backoff. |
| `protocol` | Incomplete, empty and reasoning-only truncated responses | Retries with the base backoff while the processor's admission gates allow it. |
| `fallback` | Unrecognised failures | Reconnects 3s, 6s, 6s, then surfaces the error. |
| `terminal` | User abort, missing API key, output length, structured output, content filter, rejected signed reasoning state; from the provider error table, a spent quota or balance (HTTP 402, `insufficient_quota` and similar codes on any status or inside the stream, or a native `QuotaExceeded` with no sign of a temporary limit), a content refusal reported as an API error, and a deterministic request error (a 400 or 422 coded `invalid_request_error` or similar, or `invalid_prompt`) | Never retried. A content refusal ends the turn as `content_filter`. Goal recovery treats a spent quota, a content refusal and a deterministic request error as permanent and gives up at once instead of probing again after a delay. |

When a spent quota, rejected credentials or a content refusal reported as an API
error ends the turn, the error message the session records gains one last line
saying what to do: top up or switch model, log in to the provider again, or
rephrase the last message. Every other failure keeps the provider's message as
it is.

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

The native runtime's `ContentPolicy` failure reads as a content refusal in the
provider error table. The executor reports it only for 4xx answers other than
401 and 429, and matches `safety` as a whole word, so a `safety_settings`
parameter error or a 5xx that mentions safety is not read as a content refusal.

The native `QuotaExceeded` tag is weaker evidence. The executor puts it on every
429 whose body says "quota exceeded", a spent balance and a full per-minute
window alike, and the tag is kept in the error metadata. The table therefore
reads it as a spent quota only after every provider code that names a spent
balance has had its turn, and only when nothing in the message, the body or the
response headers says the limit lifts by itself: a per-second, per-minute,
per-hour or per-day window, a retry hint (`retry in`, `retry after`, a
`retryDelay` detail or a `retry-after` header), a wait of a given number of
seconds, or rate-limit or throttling wording. With such a sign it is a
`rate_limit` and backs off; the HTTP status the native message names is not
one. The same words on an HTTP-shaped 429 with no provider code carry no tag and
are a plain `rate_limit`.
