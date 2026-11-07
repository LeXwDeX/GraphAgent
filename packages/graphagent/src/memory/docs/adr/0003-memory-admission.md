# ADR-0003: Legacy Memory enters through Project admission

- Status: Accepted
- Date: 2026-08-11

## Context

Memory configuration reads previously scanned every registered worktree and could import Topics or delete duplicate files. `prepare`, `context`, and `checkpoint` therefore hid cross-directory writes behind a read-shaped function. Each legacy Topic also reopened and rewrote the authoritative Topic set independently. When no explicit Project configuration existed, one consistent sandbox configuration was treated as an unresolvable conflict instead of becoming the Project configuration.

## Decision

`MemoryAdmission.ensure(projectSnapshot)` is the only legacy input seam. A snapshot contains the Project identity, primary directory, complete sorted directory set, and Project update revision. Admission holds a Project-scoped cross-process lock, reads all legacy candidates, applies all Topic imports in one Store update, resolves configuration, removes only committed imports or exact duplicates, and returns stable diagnostics.

Successful conflict-free results are cached by Project identity, sorted directories, and Project update revision. Unresolved results are not cached so manual repair can be observed. Worktree reset and removal invalidate the Project before rerunning admission.

Configuration resolution follows these rules:

- An explicit valid Project configuration is authoritative; equal sandbox files are duplicates and differing files are conflicts.
- Without an explicit Project configuration, one normalized value across all valid sandbox files is promoted to the Project.
- Multiple normalized values conflict. Invalid files remain in place and are diagnosed.

## Consequences

- Memory reads no longer rescan or mutate every worktree on each call.
- Topic migration publishes at most one authoritative revision per admitted Project snapshot.
- A consistent sandbox policy can become the Project policy without manual copying.
- Worktree lifecycle owns cache invalidation, not migration rules.
- Conflict and invalid-file repair remains fail-closed and observable.

## Alternatives Considered

- Cache `Memory.configuration()`: rejected because migration rules and filesystem mutation would remain hidden in a read-shaped module.
- Keep one reconcile call per legacy file: rejected because it multiplies authoritative reads and commits and makes cross-process ordering harder to reason about.
- Treat the global fallback as an explicit Project configuration: rejected because global policy is not Project-owned and must not prevent promotion of a consistent Project-specific legacy value.
