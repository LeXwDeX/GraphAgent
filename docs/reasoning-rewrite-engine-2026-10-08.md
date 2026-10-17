# Reasoning rewrite: engine-level, per-step, rewrite-before-first-resend

Branch: `refactor/reasoning-rewrite-engine`. Baseline: `main` at `1b69adcdcf`.

> **2026-10-17 update — synchronous continuation is now the default.** For editable (unsigned/plaintext-mirror)
> reasoning, when a reasoning part ends before any content or tool call starts, the host stops that stream, organizes
> the part, adopts it, and sends a continuation request in the same user turn. The continuation reuses the same
> assistant message and asks the model to answer from the organized reasoning. Signed, encrypted, referenced and
> unknown carriers never enter this path. Set `reasoningDistillation.sync: false` to keep the older asynchronous
> next-request behavior described below; that path also remains the fallback when content or tools already started,
> no organizer is available, or organization fails. This document's barrier details apply to the `sync: false`
> fallback unless explicitly stated otherwise.

## Why

The 1.0.54+ reasoning distillation ("重塑思考") organizes a completed turn's reasoning once, after the turn ends, and
adopts the result in the background. Review found:

- **Cache cost without matching benefit.** A step's reasoning is first resent by the next step of the same turn. Turn-end
  rewriting therefore changes text that earlier requests already sent as input, invalidating the provider prompt cache
  from that point for the next turn, while within-turn resends (where interleaved-thinking providers actually consume
  reasoning) still carry the original.
- **Replacement is lost under normal use.** If the user continues before the background job commits, the next request
  carries the original and adoption is rejected (`reasoning turn was retried or continued`); each turn is tried once.
- **Two organizer implementations.** The opencode host calls AI SDK `generateText` with an `openaiCompatible`-only effort
  option; the core runner uses the `@opencode-ai/llm` engine. Multi-slot requests are one serial JSON call that is
  rejected wholesale on any invalid item.
- **SDK metadata sniffing in core.** Editability is decided by key names from provider SDK metadata, duplicated in three
  places, apart from the protocol code that defines those keys.
- **Dead native-wire projector.** The legacy propose/judge/claims/gates pipeline and the native-runtime hook have no
  production caller. The core runner also converts the whole history on the foreground path and lowers the full main
  request for the canonical path without using either result.
- **Empty replacement drops the field.** In the core runner an all-noise replacement removes the reasoning part, so the
  provider request loses `reasoning_content` for that assistant message.

## Scope

- Reasoning distillation in `packages/core` (organizer, adoption, scheduling, replay, editability), the opencode session
  host (`prompt.ts`, `processor.ts`, `llm.ts`, `reasoning-adoption.ts`), and an engine-owned reasoning carrier classifier
  in `packages/llm`.
- No reasoning-part or event format change: `distillation` provenance and `providerMetadata` keep their existing
  shapes. The config schema adds an optional `reasoningDistillation.enabled` field on each provider model; v1 provider
  model configuration preserves it when migrated. The legacy `compatibility` config entry is still accepted and
  ignored.
- The per-model switch adds an optional config HTTP field and matching SDK type. Public events and stored data are unchanged; no DB migration is needed.

## Configuration

The effective switch follows this order: the environment kill-switch disables rewriting; an explicit model-level
`reasoningDistillation.enabled` value wins next; then the global `reasoningDistillation.enabled` value applies; if
none is set, rewriting defaults to on for every model family. Eligibility is decided per reasoning part by its
carrier, not by the model name: plain and plaintext-mirror carriers are rewritten, while signed, encrypted,
referenced and unknown carriers remain untouched.

The per-model field contains only `enabled`. Organizer language remains global under
`reasoningDistillation.language`. Existing canonical-content checks still protect opaque, signed, encrypted, and
otherwise non-editable reasoning carriers regardless of the effective switch.

The example below uses v2 `providers`. In a v1 `opencode.json`, use the singular `provider` key with the same model-level field.

```jsonc
{
  "reasoningDistillation": { "enabled": true, "language": "en" },
  "providers": {
    "openai": {
      "models": {
        "gpt-5": { "reasoningDistillation": { "enabled": false } },
        "gpt-5-mini": { "reasoningDistillation": { "enabled": true } },
      },
    },
  },
}
```

## Approach

1. **Remove dead code.** Delete the native-wire projector (core runner `distillCycle`, claims/gates/plan/audit/cache/
   projection/review/slot/budget modules, opencode propose/judge/interleaved helpers, native-runtime hook) and their tests;
   drop the unused foreground conversion and `llm.prepare` from the core runner canonical path.
2. **One engine organizer.** `organizeReasoning` takes single-slot prompts only and runs slots concurrently; each slot
   succeeds or fails independently. A shared engine transport builds an `LLMRequest` (no tools, temperature 0, no
   retries, `none`/`low` effort translated per protocol) and calls `LLMClient.generate`. The opencode host uses it through
   its native request adapter for engine-supported packages and keeps AI SDK only as an explicit fallback transport.
   Budget: per-session token ceiling counted from reported usage, or estimated from prompt and output when the provider
   omits usage; no per-session call cap; consecutive transport failures still pause the session.
3. **Rewrite before first resend.** A job starts as soon as a reasoning part ends (`reasoning-end`), overlapping the rest of
   the step and its tool execution. At each send barrier, calculate the response-start window from only source text
   belonging to organizer jobs that have not started responding, measured with UTF-16 `String.length`:
   `min(15000, max(3000, ceil(chars / 4000) * 3000))` ms. `OPENCODE_REASONING_DISTILLATION_SETTLE_MS` overrides this
   when set to a non-negative safe integer, including zero; unset or invalid values use the adaptive window. When the
   window expires, seal and interrupt only jobs that have not started responding. A started organizer stream is not
   limited by this window, even when it is zero. Once the organizer begins returning SSE, consume its stream through
   completion, validate its result, and replace the same reasoning part; persist the adoption before the next main-model
   request. `OPENCODE_REASONING_DISTILLATION_AUX_TIMEOUT_MS` is a no-progress timeout: it does not cap a healthy stream
   that continues to make progress. A source is never replaced after it has been resent. A sealed job can never adopt;
   adoption is validated per part (session not reverted, part unchanged, not sealed) instead of rejecting the whole turn
   on continuation. Tool execution still overlaps organizer calls. All-noise replacements keep an empty reasoning part
   so the provider field stays present.
4. **Engine-owned carrier classification.** `@opencode-ai/llm` exports `ReasoningCarrier.classify(metadata)`, declaring for
   each provider namespace which keys are opaque (signatures, encrypted payloads, item references) and which are
   plaintext mirrors. Core editability uses it; the duplicated key sniffers are removed.

## Acceptance

- Workspace typecheck and lint (no ratchet increase).
- Focused tests: core organizer/adoption/scheduler/canonical/runner, llm carrier classifier, opencode llm/prompt/session
  reasoning tests, TUI adoption test; DAG-core gate.
- New regression coverage: per-slot partial success; settle adopts finished jobs before the next request and seals
  unfinished ones (a sealed job never adopts); adoption after continuation succeeds when the part is unchanged; core
  runner keeps `reasoning_content: ""` for an all-noise replacement; carrier classification per namespace.
- Live: an isolated run with a configured DeepSeek/QWEN/GLM small model shows the second step of a tool-using turn sending
  the replaced reasoning, recorded with allowlisted timings.
- Savings comparison uses a script-calibrated estimate so a Chinese rewrite of English reasoning is judged by real cost.

## Results (2026-10-08)

Implementation note: steps 1 and 2 landed together in core because the organizer, adoption and runner modules were
rewritten in place; writing an intermediate multi-slot version only to delete it would have been wasted churn.

| Check                          | Result                                                                  |
| ------------------------------ | ----------------------------------------------------------------------- |
| Workspace typecheck            | 31/31 tasks                                                             |
| Lint                           | 0 errors, 4,738 warnings; ratchet lowered 4,850 → 4,750 (CI margin ~10) |
| `packages/core` full suite     | 1,459 pass, 0 fail                                                      |
| `packages/llm` full suite      | 325 pass, 30 skip, 0 fail                                               |
| `packages/opencode` full suite | 5,241 pass, 33 skip, 1 todo, 0 fail                                     |
| `packages/tui` full suite      | 282 pass, 1 skip, 0 fail                                                |
| DAG-core gate                  | all critical behavior and coverage floors passed                        |

Suites were rerun on the touched packages after the lint, estimator and review fixes below (core full suite; opencode
prompt, llm, session, processor, compaction and quality files: 337 pass, 0 fail).

Net change: about 11.7k lines removed (dead native-wire projector, propose/judge/claims/gates modules and their tests),
about 2k added including new tests.

### Lint

Every warning on a line this change adds or edits is fixed, including redundant non-null and `as` assertions removed
by oxlint's safe autofix in touched files. Remaining warnings in touched files predate this change.

### Token estimation for savings

Live runs first showed a Chinese organization of English reasoning rejected as `no-savings`. Measured on the configured
relay, the same reasoning was 114 DeepSeek tokens in English (3.05 chars/token) and 106 in its Chinese rewrite
(1.87 chars/token); GLM: 126 vs 124. The conservative reserve estimator (CJK = 1 token/char, other = 4 chars/token)
reported 87 vs 103 and flipped the sign. The savings check now uses `Token.estimateComparable` (CJK 0.55 token/char,
other 3 chars/token, calibrated on those tokenizers); reserves and limits keep the conservative estimator. The default
Chinese organizer language is kept.

### Self-review fixes

- Finished jobs that adopted nothing are dropped immediately, so sessions that never send again retain no work.
- The opencode host keeps only adopted part identities until the next barrier and re-reads the parts there.

### Review fixes

- The opencode host keeps its scheduler and budget in `InstanceState`: disposing a directory closes the instance scope
  and cancels pending organizer calls (a mutation test with the application scope fails). The job owns an
  `AbortController` that is aborted on interruption, so cancellation reaches the provider request on every path.
- Adoption also checks a durable fence in both runtimes: it is refused once the session has an assistant message newer
  than the part's message, so a send attempt persisted by another process cannot be followed by a late rewrite. The
  in-process barrier remains the primary mechanism; the fence covers what it cannot see.
- The opencode loop treats its persisted assistant message as the claim and re-reads the previous assistant
  message's settled reasoning after it, before building the request. Only that message can still adopt before the
  claim, so a rewrite another process commits between this loop's history read and its claim is carried by the
  request, and one after the claim is refused. The fence is a direct query for later assistant rows instead of a paged
  message scan inside the adoption transaction. A test commits a foreign rewrite in the claim's own transaction with a
  SQLite trigger; without the re-read the request carries the original.
- The core runner persists its attempt with the first stream event, after building the request, so a concurrent sender
  in another process can still send the original once. That costs one prompt-cache miss, not history consistency;
  closing it would mean starting the step before reading history, which changes the runner's overflow and compaction
  paths.
- Deleting a session cancels its pending jobs in both runtimes and releases its budget entry; a mutation test without
  the cancellation times out.
- The organizer's output cap (24,576) is lowered to the small model's declared output limit on the engine and the
  AI-SDK fallback, so providers that enforce their cap do not reject every organizer call.

### Smoke (built host binary, isolated)

`bun run build --single --skip-install` with the pinned Node 24.21.0 produced
`dist/opencode-darwin-arm64/bin/opencode` (`0.0.0-refactor/reasoning-rewrite-engine-202610081437`); the build's own
`--version` smoke passed. The cross-platform native-package install step was skipped: it fails locally on a frozen
lockfile, and this change does not touch dependencies. Installing over `/usr/local/bin/opencode` requires `sudo`, which
was not available, so **no installed-binary test is claimed**.

Each run used temporary config/data/state/cache/home, a synthetic project, one long-lived `serve` with two
`run --attach` turns, the configured `local-proxy-compatible` provider through existing credential references, main
model `deepseek`, and a local relay recording only role sequences and reasoning prefixes.

- **Feature on, organizer `deepseek` (`none`), default 3 s window**: step-1 reasoning (790 chars) organized in 503 ms
  while the tool ran, adopted in 5 ms, and the **step-2 request carried the rewrite**. The final step's English reasoning
  (215 chars) became 87 Chinese chars in 546 ms and the **next turn's request carried it**. 0 server errors.
- **Feature off**: no organizer calls; both requests resent the original reasoning; 0 server errors.

Earlier exploratory runs with `glm-flash` (no `none` variant, `low` effort) took 0.9–4.2 s per organizer call and, in
one run, made a step wait for the organizer inside the window. With a `none`-capable organizer the calls finish well
inside tool execution time.

### DEBUG regression and barrier visibility

A DEBUG-level live matrix on the installed binary (DeepSeek `none` and glm-flash `low` organizers at the default window,
a zero window, feature off) showed the intended behavior in every case: finished rewrites adopted before the next
request; a glm-flash call that missed the window and a call still running at a zero window were sealed and the original
stayed in every later request; no organizer calls when off; no server errors. Sealing was only inferable from missing
outcome lines, so each barrier now logs `reasoning rewrite sealed` (info) when it seals work and
`reasoning rewrite barrier` (debug) otherwise, with job, adopted and sealed counts and the wait time.

### Observations

- In the smoke run the organizer judged the step-1 reasoning entirely noise. It restated the request, listed three
  error kinds and deliberated about formatting; the list reappeared in the visible answer. This is model judgment, not a
  mechanical failure, but it shows that the organizer can drop short plans.
- A short-lived `opencode run` process ends before the final step's job; the barrier semantics need a long-lived process
  (TUI, server), as intended.
