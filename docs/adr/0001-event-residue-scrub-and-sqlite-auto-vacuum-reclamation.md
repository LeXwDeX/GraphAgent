# ADR 0001: Event residue scrub and SQLite auto-vacuum reclamation

- **Status:** Accepted
- **Date:** 2026-09-04
- **Issue:** #524 (delivery: PR #537 → `dev`)
- **Supersedes:** none

## Context

The durable event store had no reclamation semantics. `Event.remove(aggregateID)` ran only on
explicit session removal and covered the session aggregate alone, and SQLite ran without
`auto_vacuum`, so deleted rows never returned pages to the filesystem. Two failure shapes
motivated the decision:

- A crash between the session-row delete and any cleanup stranded durable event aggregates
  whose `SessionTable` and `WorkflowTable` read models were both gone. Replaying such an
  aggregate is impossible: the `WorkflowCreated` projector INSERT dies on the
  `workflow.session_id` foreign key once the session row is gone (pinned by
  `packages/graphagent/test/dag/dag-replay-idempotency.test.ts`), so residue can neither be
  replayed nor re-materialized — it can only be deleted.
- `database.ts` initialized WAL and pragmas after driver open, so an application-level
  `PRAGMA auto_vacuum` could not take effect: after WAL initialization the pragma silently
  yields NONE even on an empty database.

The decision checkpoint was approved on 2026-09-04 with the scope locked below.

## Decisions

1. **Explicit session + dag scrub.** `Session.remove` captures every related dag aggregate ID
   before the `Deleted` publish (the projector's session-row delete FK-cascades the workflow
   rows inside the publish transaction, so a post-publish lookup would see nothing) and removes
   each dag event aggregate after the session aggregate — terminal workflows included. The
   per-dag scrub is soft-degrading (a failure is logged and the aggregate is left for the
   startup sweep) but preserves interruption (`Cause.hasInterrupts` re-raise, the
   `EventResidueSweep` sibling discipline).
2. **Guarded default-on startup sweep.** `EventResidueSweep` runs one pass per process start,
   forked into the layer scope so it can neither block nor fail startup. Eligibility is the
   zero-live-read-model rule: an aggregate in `event_sequence` with neither a `session` nor a
   `workflow` row. Removal is a single atomic guarded `DELETE` that re-evaluates both
   NOT EXISTS guards inside the statement (no select-then-delete TOCTOU window), so an
   aggregate recreated concurrently survives. Wired into `AppLayer` and the HttpApiApp node
   graph, so every serving process sweeps; the pass is idempotent.
3. **New databases: FULL before WAL.** Both SQLite drivers (`sqlite.bun.ts`, `sqlite.node.ts`)
   set `auto_vacuum=FULL` at the driver layer, before `journal_mode=WAL`, and only on a
   genuinely empty (0-page) file. An immediate SQLITE_BUSY from a second opener racing the
   first is tolerated: the pragma is a persistent header property and runs before any
   WAL/migration write, so the first-write winner sets FULL for the database.
4. **Existing databases: explicit conversion only.** Legacy `auto_vacuum=NONE` databases are
   never converted at startup — startup is detect-only (a warning pointing at the command). The
   only conversion path is `opencode db vacuum --db <path>`: the target must be named
   explicitly and must already exist as a regular file (vacuum never creates a database), runs
   FULL → VACUUM → `wal_checkpoint(TRUNCATE)` outside any startup path, and fails nonzero
   unless the `PRAGMA auto_vacuum` readback is exactly FULL. Exclusive access is a hard
   requirement (a concurrent writer fails VACUUM with SQLITE_BUSY).
5. **Archived-session retention: off and deferred.** No retention policy for archived sessions
   ships in this decision (Phase 3).
6. **Active truncation: rejected.** Truncating active/retained session event history and event
   snapshot folding are rejected; incremental replay (`seq > after`, ascending) and sync
   cursors must keep observing unbroken per-aggregate histories.
7. **`incremental_vacuum` is forbidden.** A disposable bun:sqlite prototype reproduced an
   exit-139 crash under the incremental mode; no code path may enable it.

## Consequences and risks

- Deleting events on legacy NONE databases still does not shrink the file until an operator
  runs the explicit conversion; disk usage grows until then.
- `auto_vacuum=FULL` pays its known SQLite overhead (pointer-map pages, per-update mapping) on
  every new database in exchange for automatic page reclamation.
- The sweep runs once per process start: residue created and abandoned within a single process
  lifetime waits for the next start. This is accepted because the shapes it targets are
  crash/in-flight zombies.
- The conversion command requires exclusive access; the error guidance says to close running
  opencode processes and retry.
- Replay and sync contracts are preserved by construction: only whole aggregates with no live
  read model are ever removed, and such aggregates are unreplayable anyway (FK death), so no
  consumer can observe the removal as a gap in a replayable history.

## Alternatives considered

- **Rely on replay instead of scrubbing** — rejected: a wiped dag aggregate whose session row
  is gone dies on the workflow foreign key during re-materialization, so replay cannot replace
  deletion.
- **Silent startup conversion of legacy databases** — rejected: converting requires a blocking
  full VACUUM; startup stays non-blocking and detect-only.
- **`PRAGMA incremental_vacuum`** — rejected (decision 7).
- **A recurring background reaper** — rejected in favor of one idempotent guarded pass per
  process start; residue is crash-shaped, not steady-state throughput.
- **Truncate or fold active event histories** — rejected (decision 6).

## Rollout and rollback

Rollout lands as ordinary PRs through `dev` per the release train; no operator action is
required — new databases get FULL automatically, legacy databases keep working unchanged (with
a detect-only warning), and the sweep is default-on. Rollback is removing the sweep from the
app graphs and reverting the driver pragma: the sweep is additive and idempotent, and legacy
databases were never written by any of this. A database created with FULL keeps its header
mode; reverting one is itself an explicit operator VACUUM and is not automated.

## Acceptance

- Active/retained session replay is unchanged; only zero-live-read-model aggregates are
  removed (guarded delete re-checked inside the statement).
- Cleanup failures never block the application path; interruption is preserved, not logged as
  failure.
- Disposable-file tests demonstrate page reclamation and the new/existing database behavior;
  no startup-time full VACUUM exists.
- `bun run test:dag-core`, focused event/session tests, package typecheck, and migration
  freshness checks pass in CI.

## Non-goals

- **No global bounded-retention claim.** Live and retained sessions keep their full event
  history indefinitely; this decision bounds nothing by age, size, or count.
- **No tombstones, unarchive, or sync changes.** Offline deletion tombstones, unarchive
  semantics, and sync cursor/protocol changes stay out of scope.
- **No authorization for #531 or live-database work.** This decision does not authorize running
  VACUUM or any cleanup against a live local database; the destructive operator procedure
  remains the human-only issue #531.
