# ADR-0001: Project identity owns Memory

- Status: Accepted
- Date: 2026-08-11

## Context

Durable Memory was stored beneath the active worktree. This made identical Projects acquire divergent Topic sets and allowed checkout reset/removal to destroy information whose intended lifetime exceeded that checkout.

Project identity is stable across registered worktrees. Worktree paths are locations with shorter, independent lifecycles.

## Decision

Project Memory is owned and located by Project identity. All worktrees of that Project share one authoritative Topic set outside checkout directories.

Project configuration is resolved from the Project's primary directory so it remains user-editable without creating sandbox-specific policy. Worktree-local Memory is compatibility input only. Valid non-conflicting data migrates to Project Memory; conflicting or invalid data remains in place and blocks destructive worktree removal.

Deleting a worktree never deletes Project Memory. Retention or garbage collection of Project Memory requires a separate Project-level policy.

## Consequences

- Worktrees share durable preferences, decisions, and terms immediately.
- Reset and remove no longer own the lifetime of authoritative Topic data.
- Migration and conflict diagnostics become part of the persistence boundary.
- Central data can outlive the last checkout until a separate retention policy exists.
- Cross-process write serialization is defined by [ADR-0002](0002-project-memory-commit-protocol.md).

## Alternatives Considered

- Use the primary worktree as the shared store: rejected because moving, resetting, or deleting that checkout still controls Project Memory lifetime.
- Keep per-worktree stores and merge during retrieval: rejected because it creates multiple authorities and makes conflicts part of every read.
- Resolve conflicts by revision number: rejected because revision alone cannot prove which durable user-confirmed content should win.
