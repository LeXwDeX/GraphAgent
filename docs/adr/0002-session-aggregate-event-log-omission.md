# ADR 0002: Session event aggregates stop appending the durable event log

- **Status:** Accepted
- **Date:** 2026-11-10
- **Issue:** #1016 (delivery: #1162)
- **Supersedes:** none

## Context

The EventV2 durable event store appended every durable event to the `event` table by
`aggregate_id` and `seq`. Session-scoped events use the sessionID as their aggregate
(`durable.aggregate === "sessionID"`), while DAG events use the dagID. Session output therefore
produced one `event` row per durable event even though the session read models were maintained
by projectors in the same transaction.

HS4a had already reduced the durable volume by moving running tool output to the non-durable
`message.part.preview` event (tail ≤4KB, `totalLength`, `seq`); state transitions and final
results stayed durable. HS4d is the decision recorded here: session aggregates stop appending
the durable log entirely.

Before the decision, the session aggregate's `event` rows and its durable stream were confirmed
to have no readers in production code; only tests and old replay tools use them. `EventV2Bridge`
still forwards `events.all()` to `GlobalBus`, so the real-time notification path is unchanged.

## Decisions

1. **Session aggregates stop appending to `event`.** For definitions with
   `durable.aggregate === "sessionID"`, `commitDurableEventInner` still allocates an
   `event_sequence.seq` inside the transaction, runs the projectors and commit hooks, and
   updates `event_sequence`, but no longer inserts a row into the `event` table and no longer
   computes the data hash.
2. **The #523 dedupe gate and the `event.id` uniqueness check are skipped for the session
   aggregate.** The dedupe gate compares the previous row's type and hash, so an aggregate that
   writes no rows has nothing to compare; the uniqueness check on `event.id` is skipped for the
   same aggregate.
3. **Explicit replay does not re-append for the session aggregate.** An explicit replay carrying
   a `seq` that is `<= latest` does not append; there is no stored row to compare it against.
4. **DAG aggregates are unchanged.** Events with the `"dagID"` aggregate continue to append to
   the `event` table and remain replayable.
5. **Nothing else in the durable path changes.** Real-time broadcast, projectors, commit hooks,
   and sequence allocation keep their current behavior.

## Consequences and risks

- Session state can no longer be reconstructed by replaying durable events; the read models
  written by the projectors are the only source.
- Reconnecting clients lose intermediate output. The final durable snapshot is still present.
- The session aggregate loses content-hash dedupe and the `event.id` idempotency gate. Sequence
  allocation, projectors, and commit hooks are unaffected.
- Existing historical `event` rows remain readable and require no migration.
- DAG aggregates continue to append to the `event` table and remain replayable.

## Alternatives considered

- **Keep appending session aggregates to the durable log** — rejected: no production reader
  consumes the rows or the durable stream, so the appended rows, data hashes, and dedupe work
  have no consumer.
- **Omit DAG appends as well** — rejected: DAG aggregates must remain replayable.
- **Remove or migrate existing session `event` rows** — rejected: historical rows remain
  readable and no migration is needed; the decision only stops future appends.

## Rollout and rollback

Rollout ships with the #1016 delivery and needs no database migration: existing historical
`event` rows stay in place and remain readable. Rollback is restoring the row insert and
data-hash computation in `commitDurableEventInner`; appends resume for future events, but rows
omitted while the omission was active are not present in the log and cannot be recovered from
it.

## Acceptance

- Session durable commits still allocate `event_sequence.seq`, run projectors and commit hooks,
  and update `event_sequence`.
- No `event` row and no data hash are produced for definitions with
  `durable.aggregate === "sessionID"`; the #523 dedupe gate and the `event.id` uniqueness check
  are skipped for that aggregate.
- An explicit replay whose `seq` is `<= latest` does not append.
- DAG aggregates still append to the `event` table and remain replayable.
- `EventV2Bridge` still forwards `events.all()` to `GlobalBus`; real-time notification is
  unchanged.
- Existing databases need no migration and historical rows remain readable.

## Non-goals

- **No change to real-time broadcast, projectors, commit hooks, or sequence allocation.** This
  ADR records only the omission of the durable log append.
- **No change to DAG aggregates.** `"dagID"` aggregates keep appending and replaying.
- **No removal or migration of existing `event` rows.** Historical rows stay readable.
- **No change to the HS4a preview path.** `message.part.preview` remains non-durable as decided
  earlier.
