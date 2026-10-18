# Dynamic context folding migration

## What changed

Dynamic context folding removes only strictly duplicate, older `read`, `grep`, and `glob` output from the prepared
model request. It does not change session storage. The former clean-exit prune job, which wrote
`state.time.compacted` into completed tool parts, no longer has a runtime entry point and is no longer scheduled.

Existing `state.time.compacted` values remain readable. They still serialize as the historical cleared-output
placeholder and are never restored, used as duplicate witnesses, or rewritten by dynamic folding.

## Configuration

| Input                         | Result                                                                  |
| ----------------------------- | ----------------------------------------------------------------------- |
| `compaction.dynamic` omitted  | Dynamic folding is enabled by default.                                  |
| `compaction.dynamic: false`   | Dynamic folding is disabled; manual full compaction remains available.  |
| `compaction.prune` only       | Deprecated compatibility alias for `dynamic`; no persistent prune runs. |
| both fields                   | `dynamic` wins.                                                         |
| `compaction.auto: false`      | Automatic full compaction is disabled; dynamic folding is unchanged.    |
| `OPENCODE_DISABLE_PRUNE=true` | Emergency kill switch for dynamic folding; it has highest priority.     |

`OPENCODE_DISABLE_AUTOCOMPACT` remains independent and controls only automatic full compaction. No settings page was
added because this repository has no existing context-folding settings surface.

Automatic full compaction starts when the context reaches the current model's usable input limit; there is no separate
configured ceiling. The former `compaction.max_context_tokens` setting was removed, and a value left in an existing
configuration is ignored. `compaction.auto: false` still disables this trigger.
The check runs between model requests, so a single response may exceed the limit before compaction begins. On the
same model, it combines usage reported by the previous response with newly appended user text and newly completed,
unique textual tool results. Exact repeated tool results remain available to dynamic folding before full compaction. On
a model switch, it estimates the active text history against the new model's limit. Media payloads are excluded from
this estimate; provider overflow handling remains available for them. This full-compaction trigger is separate from
duplicate-output folding.

## External DCP compatibility

OpenCode defers its built-in folding only when the server-plugin loader identifies the exact package
`@lexwdex-org/opencode-dcp` and that load leaves an active context-folding hook registered:

- npm declarations are matched by their parsed package name;
- file declarations require exact `package.json` name metadata;
- the registered capability must be a callable `experimental.chat.messages.transform` or
  `experimental.session.compacting` hook;
- a successful empty plugin return, including DCP's `enabled: false` and `dtc.enabled: false` paths, keeps the built-in
  implementation enabled and emits no migration warning;
- configuration alone, install/import/compatibility/apply failures without a retained relevant hook, substring
  matches, legacy single files without metadata, and pure mode do not count as active;
- if a legacy module registers a relevant hook before a later export fails, that retained hook is still active, so the
  built-in implementation retreats rather than running a second transformation over the same request.

The first model request that observes an active known DCP in each OpenCode instance emits one migration warning.
Further sessions in that instance do not repeat it; a restarted instance may warn once again. The warning contains
only the known package identity, source kind, and disable-or-remove/restart action.

Core runner has no server-plugin loading capability. It reports external DCP state as `unknown` and never infers a
loaded plugin. Other or unknown message-rewriting plugins are not automatically detected; operators must disable one
of the overlapping implementations explicitly.

## Diagnostics

Every OpenCode AI SDK, OpenCode Native, and Core runner request reports an allow-listed aggregate record: policy
version, runtime, request purpose, resolved enable source/state, external-DCP state, application state, duplicate and
folded counts, exclusions, budget estimates, and skip reason. Unavailable numeric or boolean values are the literal
`unknown`, never synthetic zero. Messages, tool arguments, paths, fingerprints, plugin specs, and secrets are not log
inputs.

## Rollback

The non-destructive rollback is `compaction.dynamic: false` or `OPENCODE_DISABLE_PRUNE=true`; restart the instance so
the effective configuration is unambiguous. Full compaction remains usable.

Before reverting to a binary that still contains the old persistent prune job, also set both `dynamic: false` and
`prune: false`. Otherwise the older binary can resume writing `state.time.compacted`. Existing historical marks do not
require a database migration and should not be deleted automatically.

This migration covers S07 compatibility and diagnostics only. Real-provider long-session, cancellation, overflow,
recovery, performance, CI, and release validation remain S08-S10 work.
