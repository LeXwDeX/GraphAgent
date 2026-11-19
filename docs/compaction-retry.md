# Compaction Retry

Compaction times out after 120 seconds without an upstream stream event. It has
no total-generation deadline: reasoning and text events both reset the inactivity
deadline. A reasoning-start event alone does not disable the watchdog. A provider
that thinks silently without sending any events is indistinguishable from a
stalled connection and is subject to the same inactivity deadline.

On inactivity or a provider request timeout (including HTTP 408/504), the current
attempt is cancelled and cleaned up before immediately switching models. There
is no retry backoff for these compaction timeouts. When `compaction.mode` is
not set, the model order is:

1. The model configured for `agent.compaction`.
2. The model on the conversation's compaction request.
3. The provider's small model, honoring `small_model` when configured.

The small model comes last because a summary is only as precise as the model
that writes it. With `compaction.mode` set to `small`, `shared`, or `auto`, the
order is the earlier one: the provider's small model first, then the
`agent.compaction` model, then the conversation's model.

Unconfigured optional stages and duplicate provider/model pairs are skipped,
and a duplicate keeps its earliest role. An `agent.compaction` model that the
model catalog does not list counts as unconfigured: compaction logs a
`compaction agent model unavailable` warning and goes on with the other stages.
Context overflow also advances this ladder. Other failures retain the existing
retry policy. User cancellation does not retry. Once the ladder is exhausted,
compaction reports an error and releases the busy state rather than looping.

Each attempt converts the original summary input for its own model. Discarded
partial summaries are removed; only the final attempt can publish a completed
compaction, run PostCompact hooks, or enqueue an automatic continuation.

The first three stages above form the clean ladder: each sends a clean request
with no tools, no system text, and size-reduced history. `compaction.mode`
selects whether compaction uses only that ladder or also tries a shared request.

## Summary check

A finished summary must have the template's shape: the `## Goal`, `### In
Progress`, and `## Next Steps` headings, each on a line of its own, and at least
one goal item. Those are the sections the continuation text reads. A summary
without them, an empty one included, is removed and asked for once more on the
same model; the retry takes one more slot of the ladder without using up the
models behind it. If the retry is still incomplete but has text, compaction
keeps it and logs a `compaction summary incomplete` warning. If it has no text,
nothing is committed: its message and the compaction marker are removed,
compaction reports `Compaction produced an empty summary`, and the session
returns to idle so the next prompt is not blocked.

## Continuation after an automatic compaction

A committed automatic compaction ends by adding one user message, so the turn
goes on from the summary. A manual compaction adds none; the retained tail
simply follows the summary. After a provider overflow that hit a turn before it
finished any step, with an earlier turn left to summarize, the message is the
replay of that turn's prompt. It carries no continuation text and the
compaction writes no export. In every other automatic case the message holds
the continuation text, a synthetic text part marked
`metadata.compaction_continue: true` and wrapped in a `compaction`
system-reminder block.

### Structure

The requests, the task state and the file lists are facts the engine reads from
the stored messages, the todo list and the workflow store, not from the summary.
They come from the whole stored session. The text, in this order, with each part
present only when it has content:

```text
<overflow note>
<opening>
Original task prompt:
Latest user request:
Context:
  Open todos:
  Active workflows:
  Files changed in this session:
  Files read in this session:
  Summary goal:
  Summary in progress (may be stale):
  Summary next steps (may be stale):
<retrieval note>
<skill note>
```

- The overflow note appears only when the compaction answered a provider
  overflow. It names large media attachments when the latest request carries
  files, whether or not the text quotes that request.
- The opening says to continue the pending work only if the latest user request
  still calls for it, and that this request takes precedence over the summary
  and the task state below, so work it stopped or replaced is not resumed. It
  is used when there is an open todo, an active workflow, or an `In Progress` or
  `Next Steps` item in the summary. Otherwise it says to continue if there are
  next steps, or to ask for clarification.
- A request is the user's own text plus one `[Attached <mime>: <name>]` line
  per file. It stays whole while it fits its share of a token budget: the
  tokens the retained tail may take (`compaction.preserve_recent_tokens`, or a
  quarter of the model's usable input budget, kept between 2,000 and 8,000).
  The requests that are quoted share it. A longer request keeps its beginning
  and its end with the number of omitted characters between them; the
  attachment lines are never cut.
- `Original task prompt` is the first request of a child session, unless it is
  also the latest one. A root session has none.
- `Open todos` lists the items that are neither completed nor cancelled.
  `Active workflows` lists the workflows that are pending, running, paused or
  stepping.
- The file lists hold absolute paths, oldest first. Changed files come from
  patch parts and completed `edit`, `write` and `apply_patch` calls; read files
  come from completed `read` calls and leave out files the session changed.
  Each list keeps the latest 100 paths and counts the older ones.
- The summary stays in the conversation as its own message. The text repeats
  only its first `Goal` item and its `In Progress` and `Next Steps` items, as
  narrative, and labels the last two possibly stale.
- The skill note names the skills the replaced messages loaded, which are no
  longer in context, and says to load them again with the skill tool.

### The latest request and the todo note

The latest user request is quoted unless the retained tail holds it. It is
quoted when `compaction.tail_turns` is 0, the latest turn does not fit the tail
budget, the tail starts inside that turn after the request, or an earlier
compaction of the same turn already took the request out of the conversation
the model sees. A request in the tail is in context exactly as the user
wrote it, so the text neither quotes it a second time nor spends budget on it:
a child session's task prompt then has the whole budget. The opening still
speaks of the latest user request; it means the one in the conversation.

The todo state reminder (`[todo reminder]`) joins the user message that opens a
turn when the history holds no current note, and the compaction takes the
earlier note away with the messages it replaces. The continuation message
already lists the open todos, so the reminder is not written into it while open
todos exist. The next user message gets the reminder as usual, once for a list
that stays the same. When no todo is open, a note still in force is withdrawn as
before. A manual compaction and an overflow replay are not affected.

### Compaction export

Each automatic compaction that sends the continuation text first saves the
messages its summary replaces as one text file. The summary only narrates
them; the file is where the model reads what was said and done word for word,
with `grep` and `read`.

- Path: `TRUNCATION_DIR/compacted_<sessionID>_<compactionID>.txt`.
  `TRUNCATION_DIR` is the `tool-output` directory under the application data
  directory, where saved tool outputs live. `compactionID` is the compaction
  marker's message ID, so every compaction has its own file and a later one
  never overwrites an earlier one. The file mode is 0600, because the messages
  hold whatever the session read and ran.
- Content: one header line, `# Messages compacted from session <sessionID>
  (compaction <compactionID>). Reasoning parts are not included.`, then each
  message as a blank line, a `=== <role> <message ID> <time>` line (the time in
  ISO 8601) and its parts: text as stored; a tool call as `[tool <name>
  <status>] <JSON input>` followed by its complete output or error; patch
  parts as `[patch] <file>, <file>`; file parts as an `[Attached <mime>:
  <name>]` placeholder, never the file itself. Reasoning and bookkeeping parts
  are left out.
- Scope: only the messages the summary replaced. The retained tail is still in
  context and is not in the file. Neither are the compaction marker and the
  summaries of earlier compactions; what an earlier automatic compaction
  replaced is in its own file.
- Lifetime: a file lives as long as its session. The age-based cleanup of the
  directory removes saved tool outputs only, so nothing cleans these by age;
  `Session.remove` deletes every export of the session. The directory is on
  every agent's external-directory allow list unless a configuration denies that
  path.
- Failure: a file that cannot be written costs only the retrieval note. The
  compaction logs a `compaction export failed` warning and goes on; the
  continuation text then names no file. A compaction that replaced no message
  writes none.

The retrieval note closes the continuation text, ahead of the skill note. It
names this compaction's file, says that each message in it starts with a
`=== role id time` line, shows how to search it with `grep` and read a range
with `read`, and ends with the pattern for every export of the session,
`TRUNCATION_DIR/compacted_<sessionID>_*.txt`, which reaches the files of
earlier compactions too.

## Compaction request modes

`compaction.mode` accepts `small`, `shared`, and `auto`. The legacy and current
configuration formats both accept it, and migration preserves the value. Leaving
it unset sends a clean request, never a shared one.

| Mode | Request shape | Attempt order |
| --- | --- | --- |
| unset | Clean request. | The clean ladder, small model last. |
| `small` | Clean request. | The clean ladder, small model first. |
| `shared` | Reuses the main request's cached system and tool prefix. | The shared request first, then the clean ladder with the small model first. |
| `auto` | Prices both shapes. | Estimated cost ascending. |

```jsonc
{
  "compaction": {
    "mode": "shared"
  }
}
```

Without `compaction.mode`, compaction sends a clean request and needs no
configuration. Set `small` to try the provider's small model first.

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
