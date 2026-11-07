# ADR-0003: Reporting checkpoint gating at the authoring boundary

- Status: Accepted
- Date: 2026-08-17

## Context

On 2026-08-17 a hand-authored 15-node workflow (issue #320) ran 75 minutes to
`completed` although every one of its five decision checkpoints returned
`verdict: replan`. The checkpoint nodes carried `report_to_parent: true` but
their stage dependents declared only `depends_on`, no `condition`. The engine
spawns a dependent the moment all of its dependencies complete, so each next
stage started milliseconds (≈12ms) after its checkpoint settled; the wake to
the parent was terminal-only advisory signal, never a gate. The authoring
model ignored warning-level feedback, which is how the ungated shape shipped.

Block-compiled graphs already gate dependents on checkpoint verdicts (the
issue #294 REJECT-checkpoint shape); hand-built node graphs had no equivalent
check.

## Decision

A `report_to_parent: true` node with dependents is a **reporting checkpoint**.
Each dependent must gate on the checkpoint's output via `condition`
(`input_mapping` does not count — it feeds data, it does not gate), or the
checkpoint must be a reporting leaf, or the node must drop `report_to_parent`.
`node_defaults.report_to_parent` is honored: a node inheriting the default
reports the same way.

Enforcement lives in `checkpointGateDiagnostics`. It is wired into
`validatePostCompile` for every action — `start`/`validate` AND the
replan/extend fragment authoring paths (DAG-02, 2026-08-18: pre-fix it hid
behind the `structural === start-only` branch, so a fragment could attach an
ungated dependent to a reporting checkpoint and the engine spawned it before
the parent read the verdict) — and into `replanStructuralDiagnostics`, which
re-checks the MERGED graph at the runtime replan/extend mutation seam, so a
fragment dependent on an EXISTING checkpoint cannot escape either. Each
reporting checkpoint emits one grouped error-severity `dag.invalid` diagnostic
listing its ungated direct dependents in both `portable` and `environment`
profiles.

Two deliberate carve-outs:

- Checkpoints already terminal in the durable graph are exempt at the runtime
  merged-graph check: they are settled and immutable, the
  spawn-before-verdict race is past, and the sanctioned additive/reopen waves
  (`node("repair", ["checkpoint"])` after a completed reporting leaf) keep
  working.
- A gated checkpoint must additionally declare `output_schema` (DAG-01,
  authoring obligation): without a schema the child may complete with prose
  that resolves no fields, leaving the gate permanently false and silently
  skipping the gated subtree. The runtime path does not impose the schema
  obligation (`requireOutputSchema: false`) because runtime-created graphs
  deliberately bypass authoring validation.

`Dag.create` itself stays untouched by design: the verdict vocabulary is
open, the ACCEPT path must not wait for the parent, and runtime create-level
enforcement would change the semantics of every existing graph, including
issue #294's wake-chain and reopen-extend behavior.

## Consequences

- Ungated reporting checkpoints fail fast at start/validate — and since
  DAG-02 also at replan/extend fragment authoring and at the runtime
  replan/extend mutation seam — with a grouped diagnostic naming the
  checkpoint, its ungated dependents, and the legal fixes.
- Runtime create, wake chains, and reopen-extend semantics are unchanged;
  trusted internal callers retain full runtime flexibility at create time.
- Saved and curated workflows were audited: 14 curated block workflows are
  unaffected; only `ultra-flow-route.yaml` and `release-route.yaml` trip the
  new check and are tracked in opencode-dag-config#14.

## Alternatives Considered

- Runtime enforcement at `Dag.create`: rejected — the verdict vocabulary is
  open-ended, the ACCEPT path must not block waiting for the parent, and it
  would change the behavior of every existing graph.
- Warning-severity diagnostic: rejected — the authoring model ignores
  warnings; that is precisely how the incident happened.
- A new explicit `gate` field on dependents: rejected — `condition` already
  expresses output gating and the block compiler already emits it; a second
  mechanism would split the gating vocabulary.

## Deferred

- ~~Replan/extend fragments are not checkpoint-gate-checked~~ — resolved
  2026-08-18 (DAG-02): fragment authoring and the runtime merged-graph seam
  both enforce the gate, with the terminal-checkpoint carve-out above.
- Deprecation of advisory wake chains (no date): `report_to_parent` without
  gated dependents stays legal but is a smell worth revisiting.
