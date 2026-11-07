# ADR-0001: Serialized Goal transitions and shared Session automation admission

- Status: Accepted
- Date: 2026-08-11

## Context

Goal commands and GoalLoop previously loaded a row and later performed an unconditional upsert. A legal `pause` or `clear` racing a delayed judge result could therefore be overwritten or resurrected. Judge completion also persisted `done` and deleted it in a second operation, so a process failure between them left a terminal row that no loop would process.

GoalLoop admitted continuation with `SessionPrompt.prompt`, while DagLoop admitted parent wakes with `promptIfIdle`. Both could observe the same idle Session and independently start automation.

The judge also encoded blocked or unachievable work as successful completion, so presentation reported an achieved Goal without a deliverable.

## Decision

All durable Goal mutations go through one `transition` function. It uses an immediate database transaction to read the current row, decide from that row, and save or delete before releasing the write lock. Goal instances carry `goal_id` and `revision`; delayed judge work supplies both values and becomes a no-op if either changed.

A `done` verdict writes an immutable `goal_outcome` snapshot and deletes the current row in the same transaction. It returns that snapshot for the `goal.updated(done)` followed by `goal.cleared` presentation contract. No durable done cleanup phase remains, while completion remains queryable after a process failure.

Judge output is tri-state: `done`, `continue`, or `blocked`. `blocked` writes a paused Goal with the blocker as its reason.

`SessionAutomationLease` is the process-local authority for Goal/DAG ownership. Goal and DAG register their active identities; DAG has priority while any workflow is registered. A claim carries a generation, and the lease holds its per-Session fence through the durable transition or prompt admission. Registration changes cannot overtake that commit. Provider execution starts after the fence is released, so a slow model turn does not block ownership transfer. `SessionPrompt.promptIfIdle` remains the final atomic idle-state admission guard. Failure at either boundary admits no Goal prompt and leaves the durable Goal available for a later idle event.

## Consequences

- Pause and clear cannot be overwritten by a stale judge decision.
- A judge result from a cleared Goal cannot mutate a replacement Goal in the same Session.
- Completion cannot strand a durable done row.
- Completion leaves one durable terminal outcome even though the current Goal view is empty.
- Blocked work is visible and resumable without being reported as achieved.
- Goal and DAG automation cannot concurrently admit two turns into one process-local Session.
- Clustered Session execution will need a durable lease before Session drains stop being process-local.

## Alternatives Considered

- Compare timestamps before unconditional upsert: rejected because it leaves read/write split and depends on clock uniqueness.
- Add only an in-memory Goal mutex: rejected because separate processes can still update the same database.
- Keep boolean judge output and infer blocked from reason text: rejected because state semantics would depend on unstructured language.
- Rely on the prompt mutex alone: rejected because the judge can mutate Goal state before prompt admission and because prompt serialization does not elect a Goal/DAG owner.
- Add a second Goal-specific prompt mutex: rejected because it would not coordinate with DagLoop.
