# ADR-0002: Project Memory commits are versioned and process-safe

- Status: Accepted
- Date: 2026-08-11

## Context

Project Memory is shared by every worktree of one Project. Separate OpenCode processes can therefore read the same Topic revision and attempt conflicting updates. Per-process mutexes and per-file atomic writes do not prevent the last writer from silently replacing another process's confirmed content, nor do they make a multi-Topic update crash-atomic.

## Decision

Memory Store is the commit authority. Its public mutation surface is limited to:

- `commit(projectID, expectedRevision, applied)`, which rejects a stale revision;
- `updateTopics(projectID, update)`, which acquires the existing cross-process `EffectFlock`, reads the latest snapshot inside the lock, applies one synchronous update, and commits it.

Each successful mutation writes a complete Topic generation into a temporary directory, renames that directory into place, and atomically publishes a manifest containing the new revision and generation. Readers follow only the manifest. A crash before manifest publication leaves the previous generation authoritative; a crash after publication leaves the complete new generation authoritative.

Legacy `topics/` data is revision zero and is promoted on the first commit. Previous and orphaned generations remain non-authoritative. Their garbage collection requires the separate Project Memory retention policy.

Project identity migration serializes on a `memory-migrate:<sorted pair>` flock and a `memory-identity:<oldID>` flock, then runs a three-phase merge: snapshot the source under the source lock, merge into the target (the target update takes the target lock), and remove the source only after re-reading it and confirming its revision has not changed since the snapshot (`SourceChangedError` otherwise). In-flight writers still producing under the old identity hold `memory-identity:<oldID>` for their whole read-modify-write, so the migration waits for them and moves their writes along with the Home. The Project database retires the old identity only after Memory migration succeeds.

## Consequences

- Concurrent worktrees cannot silently lose same-Topic updates when they use the Store mutation API.
- Stale callers receive an explicit revision conflict.
- Restart observes either the complete old generation or the complete new generation, never a partial batch.
- Store writes use more disk space until retention policy defines safe generation cleanup.
- Callers cannot persist an already-computed stale Topic set through an unversioned write API.
