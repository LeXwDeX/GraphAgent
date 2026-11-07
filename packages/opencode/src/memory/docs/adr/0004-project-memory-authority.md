# ADR-0004: Project Memory authority owns identity and commits

- Status: **Rejected** (2026-08-12) — superseded by the Occam minimal path (redo plan §10). After survey + adversarial review the user applied Occam's Razor: this elaborate redesign (authority facade, 6-phase retirement journal, alias tombstone, opaque Revision, destruction guard, 8 phases) is over-engineered for the actual needs — one shared memory per project and no fork are already in the baseline; an imperceptible identity upgrade and no data loss are achievable with small in-place fixes. Kept as a record of the considered-and-rejected direction.
- Date: 2026-08-12
- Supersedes: **nothing** — this ADR was Rejected before adoption, so it supersedes no live clause. The Policy-source clause of [ADR-0001](./0001-project-owned-memory.md) and the lock/commit framing of [ADR-0002](./0002-project-memory-commit-protocol.md) remain live and authoritative. Reconstructs the lost authority redesign (uncommitted WIP, /tmp-cleaned) from design memory, now written down so the considered-and-rejected direction stays auditable.

## Context

Project identity resolution, cross-process locking, Memory Home selection, Project configuration, legacy admission, and Project ID retirement were composed by several public services (Store, Config, Admission, the controller, Migration). Three complete reviews found the same failure class in different call orders: a caller could resolve before locking, invalidate the wrong identity, move a Home before an alias preflight, or carry inherited "lock held" state beyond the real flock lifetime. Pushing more canonical IDs / paths / callbacks / lock state between those services would keep the persistence protocol in application callers.

User product principles confirmed 2026-08-12 (governs this ADR):
1. **One shared Memory per Project.** Worktrees have no Memory of their own; they all share the Project's single Memory.
2. **Memory never forks.** Memory is core, topic-typed content; worktrees are small PRs and must not branch Memory into per-worktree copies.
3. **An identity upgrade is imperceptible.** When a repo gains its first remote (root-commit identity → first-remote identity), the user's Memory endures seamlessly — nothing the user notices is lost, moved, or forked.

These reaffirm the baseline direction (ADR-0001/0002: Memory is the Project-owned, identity-keyed, worktree-external shared store) and raise the bar: the upgrade must be correct and seamless, not just "eventually consistent."

## Decision

One `ProjectMemoryAuthority` owns the application seam. Callers express three domain operations: read Memory, change Memory via an opaque revision, and retire a Project identity. Runtime admission is part of `readMemory` (no compose-your-own `admit → read`). Callers never receive canonical IDs, Home paths, lock capabilities, cache invalidation, or migration callbacks.

```ts
interface ProjectMemoryAuthority {
  readMemory(projectID): Effect<Snapshot, Failure | AdmissionConflict>
  changeMemory(revision, changes: NonEmpty<Change>): Effect<Snapshot, Failure | AdmissionConflict | RevisionConflict>
  retireIdentity(request: IdentityRetirement): Effect<RetirementReceipt, Failure | AdmissionConflict | RetirementConflict>
}
```

- `Revision` is opaque, one-shot, caller-unforgeable, binding canonical identity + Topics revision + Policy fingerprint + Project topology fingerprint + admission-input fingerprint. **D4.**
- `Change = replace_topics | mark_matched | set_policy` — data, not Effect callbacks. **D4.**
- `retireIdentity` is the **only** identity-migration entry point.

### Routine operations
Resolve the requested Project ID → acquire **one** canonical Project commit right → resolve again → retry if retirement changed the identity. Model work happens outside the commit right; a later change uses revision comparison rather than holding a lock across provider execution. A revision issued before Identity Retirement is rejected after the identity commit point.

### Identity Retirement (forward-only; "merge into one", not a fork, not a Project Merge)
Validate source + successor before mutation → prepare a complete successor while **retaining** the source → publish **one** immutable identity tombstone (the commit point) → migrate every Project-owned database reference → treat source cleanup as retryable completion. State machine: `Requested → TargetPrepared → IdentityPublished → ReferencesRetired → CleanupPending → Completed`. **D4.** It rejects a successor that is itself retired or belongs to an independent Project. **It is Identity Retirement, not the explicitly-deferred Project Merge**: exactly one logical Project's old identity converges into its new identity, preserving one Memory (no fork). Distinct from combining two independently-owned Projects.

### Internal transaction witness (not exported)
Runtime lifetime fence (`open → closing → closed`); never exposes persistence paths. Even an escaped fiber cannot use it after close; an operation that has entered is completed before the OS flock releases. Effect Context is **not** proof that an OS lock remains held.

### Locking
- Routine: `join/recover touched retirement → resolve requested ID → one canonical Project flock → resolve again → retry on change`. Never extends a held set; never reaches the identity-ledger lock.
- Retirement: read ledger unlocked to derive expected keys → acquire the **complete sorted** `({source,successor})` Project flock set → acquire the identity-ledger flock → revalidate. Order preserves the rolling-upgrade key order used by supported older processes (no ABBA). Recovery completes before any routine Project lock; routine never goes Project → ledger.

### Atomic Topics + Policy + revision (**D1**)
Project Memory Topics, Project configuration (Policy), topology, and admission inputs contribute to **one** opaque `Revision`. **Policy lives in the Memory Home** generation (`policy.jsonc` co-tenant with topic YAML); the Home generation is the single atomic publish point (temp-dir → rename → manifest). Worktree `.agents/memory.jsonc|.json` and the global config are **admission candidates only**, not authorities. *(Supersedes ADR-0001's "Policy resolved from the primary directory so it stays user-editable": under this ADR the controller owns Policy, atomically versioned with Topics. Global config remains a fallback candidate admitted when no Home Policy exists.)* Reads are pure; normalization never writes.

### Worktree lifecycle (integration via an internal guard)
Worktree reset/remove remain the Worktree authority's operations, integrated through an internal, non-exported `ProjectMemoryDestructionGuard` whose sealed durable intent binds `{request_id, requested_project, identity_revision, normalized_target, action, topology_fingerprint, candidate_fingerprint}`. Every execution/recovery first joins Identity Retirement and re-resolves the requested Project; an identity-revision change rebases the intent and rescans before publication. The guard publishes valid candidates into the authoritative generation before invoking the one fixed action adapter, so action failure leaves only safe legacy duplicates. Destructive admission **never** trusts a process-local success cache — it rescans the Project primary + every registered worktree each time.

### Automatic Identity Retirement
Limited to **verifiable first identity convergence**: source = the observed repository's root commit; the repo-local cache names it `previous`; current resolution selects the successor from the remote identity; every existing successor directory re-resolves to that successor (different physical stores allowed — one remote Project may have several clones). A remote X→Y change, contradictory observation, or unavailable evidence **fails closed** and does not become an implicit Project Merge.

### Crash semantics
Commit point = the immutable tombstone. Pre-tombstone: source authoritative. Post-tombstone: successor authoritative, old revisions invalid; recovery rebuilds target from the latest two-sided state if either side changed after `TargetPrepared`. Each public command first joins/recovers touched journals. Source Home is preserved (non-authoritative) and is never read as an authority after the tombstone.

## Decisions D1–D4 (resolved)
- **D1 — Policy in Home generation**, atomic with Topics, one Revision; worktree/global config = admission candidates. *(Supersedes ADR-0001's primary-directory Policy.)*
- **D2 — Source Home preserved**, non-authoritative; old ID routes to successor via alias. GC/retention is **excluded** this round; retired Homes remain as backups indefinitely. *(ADR-0001/0002's retention precondition is satisfied by "retain indefinitely; GC deferred" — no non-authoritative artifact is ever silently collected.)*
- **D3 — Identity Retirement approved**: old ID retires into successor; immutable alias tombstone + canonical chain + deterministic-union into ONE Memory (no fork). Distinct from the forbidden Project Merge.
- **D4 — Surface confirmed**: 6-phase forward-only journal; opaque Revision fingerprint (identity + Topics revision + Policy + topology + admission); `changeMemory` Change algebra.

## Consequences
- `MemoryLock` (public), alias mutation, manual admission invalidation, project-directory configuration writes, and callback-shaped identity migration are **removed from application callers**; they survive only as authority-private adapters.
- Crashes across filesystem and SQLite are recovered by **advancing** the recorded retirement state; no cross-store rollback is promised.
- The source Home may temporarily remain after identity publication; it is non-authoritative and cannot be recreated through the retired ID.
- An immutable `ProjectLineageID` could remove identity movement entirely but needs a new product identity, schema backfill, rolling-upgrade protocol, and explicit Project Merge semantics — **deferred** to a separate proposal.
- Per AGENTS §7 review: the legacy `inspectHome` allow-list (`memory/identity-migration.ts:43-54`) must either be extended to the new Home contents (policy.jsonc) or the legacy path is retired when the P6 cutover lands — it must not fail-closed on a modern Home.
