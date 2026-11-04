# Project Memory Context

Project Memory preserves user-confirmed, durable human context for one Project. It is not a code index, task tracker, instruction source, or general model-writable store.

## User principles (confirmed 2026-08-12)

- **One shared Memory per Project.** Worktrees hold no Memory of their own; they all share the Project's single Memory.
- **Memory never forks.** Memory is core, topic-typed content; worktrees (small PRs) must not branch it into per-worktree copies.
- **An identity upgrade is imperceptible.** When a repo gains its first remote (root → first-remote identity), the user's Memory endures seamlessly — nothing the user notices is lost, moved, or forked.

## Authority structure (Occam path, adopted 2026-08-12)

The domain runs on the existing seams; the elaborate `ProjectMemoryAuthority` redesign (ADR-0004) was **Rejected**. The authoritative pieces are:

- **MemoryStore** (`store.ts`) — generation+manifest persistence for Topics. Strict reads (`readSnapshot`/`inspectTopics`) fail closed on a corrupt or missing generation; the runtime read (`readTopics`) is lenient and projects empty.
- **MemoryConfig** (`config.ts`) — the unversioned `.opencode/memory.jsonc` policy. Writes serialize on a per-file cross-process flock (`memory-config:<file>`).
- **MemoryAdmission** (`admission.ts`) — the single legacy-input seam: scans one Project snapshot, reconciles once, caches only conflict-free results.
- **MemoryIdentityMigration** (`identity-migration.ts`) — `migrateHome(oldID, newID)`: rename when the target is absent, merge-then-remove otherwise; fails closed on conflict or an unread source.
- **Worktree guard** (`worktree/index.ts`) — `list()` is a pure observation path; `remove`/`reset` reconcile legacy memory fail-closed against the full directory snapshot and always invalidate the admission cache first.
- **Project identity migration** (`project/project.ts` `migrateProjectId`) — memory first, then the DB transaction that repoints session/workspace/workflow/permission references before deleting the old row.

## Glossary

| Term | Meaning |
| --- | --- |
| Project Memory | The authoritative durable Topic set owned by one Project identity and shared by all of that Project's worktrees. |
| Memory Home | The Project-scoped persistence boundary for Project Memory, keyed by Project identity (`memory/projects/<hash(id)>`). |
| Topic | A bounded structured collection of confirmed preferences, decisions, or terms with controller-owned metadata. |
| Legacy Worktree Memory | Memory files stored inside a checkout by an older runtime. They are migration inputs, never a second authoritative store. |
| Memory Conflict | A case where legacy and Project Memory claim the same logical identity with different **content**, or where legacy configuration differs from the effective Project configuration. Controller metadata drift is not a conflict. |
| Project Configuration | The MEMORY policy owned by the Project's primary directory (`.opencode/memory.jsonc`). It is unversioned; writes are serialized per file, not atomic with Topics. |
| Memory Admission | The single legacy input seam that scans one Project snapshot, reconciles it once, and caches only conflict-free results. |
| Identity upgrade | The one-way transition when a repo gains a durable identity (root → first-remote, or a changed remote). Memory is migrated before the old Project row is deleted; nothing is forked. |
| Global identity | The shared fallback identity of commit-less repositories. Memory is fail-closed **inert** under it: one Project = one Memory, and a shared bucket would leak across repos and orphan at the first commit. |

## Invariants

- One Project identity has one authoritative Project Memory.
- Two worktrees of the same Project cannot form independent Memory namespaces; Memory never forks per worktree.
- Current user input and higher-priority instructions always override retrieved Memory.
- The controller owns persistence, metadata, migration, limits, and atomicity; models only propose bounded semantic actions.
- Migration writes a durable authoritative copy before treating a legacy copy as consumed.
- A Memory Conflict is explicit and fail-closed; no component silently chooses or overwrites conflicting durable context. Content equality ignores controller-owned metadata (`last_matched_at`, `match_count`, `revision`, `updated_at`).
- Removing or resetting a worktree cannot imply deleting Project Memory, and never deletes the user's worktree directory as a side effect of registration cleanup.
- Removing Project Memory requires a separate Project retention decision.
- Runtime reads never perform ad-hoc legacy migration; they consume a Project snapshot admitted by Memory Admission.
- Memory is inert under the global identity and for uninitialized projects; activation requires a real, initialized identity.
- Identity upgrade migrates Memory first, repoints every Project-owned reference (session, workspace, workflow, permission), and only then retires the old row. A successor permission that collides on `(project_id, action, resource)` wins; the duplicate is dropped, never wedged.
- A missing Memory Home is empty. A corrupt or dangling Home fails closed on strict reads and migration (the source is never deleted unread); the lenient runtime read projects it as empty rather than erroring.
- Worktree `list()` observes and never mutates: it does not prune git admin data or drop registrations for merely-prunable entries. Destructive cleanup belongs to `remove`/`reset`, which prove each case first.
- Worktree `remove`/`reset` reconcile legacy memory fail-closed against the **complete** directory snapshot (primary + every registered sandbox) and always invalidate the admission cache before rescanning; they never trust a cached clean result.
- Legacy files are re-read and compared immediately before deletion; content that changed after the scan is preserved and surfaced as a conflict.
- Every writer of a MEMORY config file serializes on the file's cross-process lock; byte-atomicity is not undermined by whole-document last-writer-wins.
- Maintenance model calls never run under the identity fence or the project lock: prepare and checkpoint render the pre-maintenance snapshot, then kick maintenance in the background, gated on identity liveness so a retired identity never starts a job (one job in flight per project, the commit-only write back under the fence).
- Matcher model calls never run under the identity fence either (issue #324 acceptance): search, prepare, and checkpoint run their matcher outside every fence, and only the markMatched commit acquires the fence (`applyUpdate`). Search keeps a SHORT project-lock critical section (stale/cache/limit check + in-flight registration); concurrent identical queries within one turn coalesce through a process-local per-(session,turn,key) in-flight Deferred — the second caller awaits the first caller's exit (reused, no extra query slot) and degrades to `failed`/`unavailable` when the first call fails or its identity retires, instead of blocking a lock across the model call.

## Boundaries

- Worktree lifecycle assembles the directory snapshot and invalidates the admission cache before reconciling; it does not own Topic persistence or Project retention.
- Session runtime may retrieve and attach bounded Memory context, but it does not own Topic persistence.
- Codebase discovery belongs to codebase-memory facilities and is rejected from Project Memory.
- Source-Home retention/GC after migration is a deferred product decision; the current behavior is migrate-then-remove.

## Decisions

- [ADR-0001: Project identity owns Memory](docs/adr/0001-project-owned-memory.md)
- [ADR-0002: Project Memory commits are versioned and process-safe](docs/adr/0002-project-memory-commit-protocol.md)
- [ADR-0003: Legacy Memory enters through Project admission](docs/adr/0003-memory-admission.md)
- ADR-0004: Project Memory authority owns identity and commits — **Rejected (2026-08-12)** in favor of the Occam minimal path described under **Authority structure** above.
