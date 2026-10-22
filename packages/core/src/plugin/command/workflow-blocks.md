# Composable Workflow Blocks

Blocks are the high-level interface for assembling a one-off workflow YAML
file. The tool compiles them into ordinary durable DAG nodes before validation
and persistence. Existing node-based YAML remains compatible.

Use blocks when a DAG serves the task. The examples are optional compositions,
not a checklist or a minimum number of stages. Selecting a block does opt into
its actual compiler and output contracts described below.

## Authoring contract

Never infer or invent a YAML field. Copy the envelope for the intended action
and change values only. Unknown fields are errors; a field from a tool call,
runtime result, low-level node, or another action does not belong here unless
it is explicitly listed below.

### Start file

The author-written top-level fields are optional `title`, optional `mode`,
optional `admission`, and required `config`. For the block route, `config`
contains required `name`, `objective`, and `blocks`; its only optional fields
are `node_defaults`, `max_concurrency`, `max_node_replan_attempts`, and
`max_total_nodes`.

```yaml
title: Implement session recovery
config:
  name: implement-session-recovery
  objective: Implement session recovery with focused tests and evidence-backed review.
  blocks:
    - id: map
      kind: explore
      instruction: Locate the ownership and persistence seams.
    - id: codebase-design
      kind: plan
      depends_on: [map]
      instruction: Define the owning seam, deep interface, migration path, and acceptance evidence.
    - id: coding
      kind: coding
      depends_on: [codebase-design]
      instruction: Deliver the bounded design through observable tests and focused checks.
    - id: verify
      kind: verify
      depends_on: [coding]
    - id: global-review
      kind: review
      depends_on: [verify]
```

### Extend file

An extend file takes its graph at the top level — required `objective` plus
`blocks` for the block route, or `nodes` for the low-level route, never both.
It has no `config`, `title`, `name`, or `fragment` wrapper and carries no
graph budgets (`max_concurrency`, `max_node_replan_attempts`,
`max_total_nodes`) or `node_defaults`: those belong to the start document and
cannot be changed by an extension.

```yaml
objective: Add regression coverage for the newly confirmed recovery edge case.
blocks:
  - id: recovery-fix
    kind: coding
    instruction: Implement only the confirmed edge-case fix and its regression test.
  - id: recovery-verify
    kind: verify
    depends_on: [recovery-fix]
```

```yaml
nodes:
  - id: recovery-reprobe
    name: recovery-reprobe
    worker_type: general
    depends_on: []
    prompt_template:
      inline: "Re-run the confirmed edge case and report PASS or FAIL with evidence."
```

### Replan file

A replan file contains only `fragment`. For the block route, `fragment` has the
same fields as start's `config`: required `name`, `objective`, and `blocks`,
plus the four optional config fields listed above.

```yaml
fragment:
  name: recover-session-recovery
  objective: Replace the invalid route with a diagnosed, verified repair path.
  blocks:
    - id: diagnose
      kind: debug
      instruction: Reproduce the failure and identify the evidence-backed root cause.
    - id: repair
      kind: coding
      depends_on: [diagnose]
      instruction: Apply the smallest repair supported by the diagnosis.
    - id: verify
      kind: verify
      depends_on: [repair]
```

Every block accepts only `id`, `kind`, `depends_on`, `instruction`,
`worker_type`, `worker_config`, `required`, and `report_to_parent`. `id` and
`kind` are required. Allowed `kind` values are `explore`, `plan`, `prototype`,
`debug`, `coding`, `verify`, `review`, and `synthesize`. Omit `worker_type`
unless the exact configured agent name is already known; never invent one. An
optional block-level `worker_config` accepts only `timeout_ms` and applies to
every node the block expands into; it overrides `node_defaults.worker_config`
for that block.

For optional `node_defaults`, the only fields are `required`,
`report_to_parent`, and `worker_config`; `worker_config` accepts only
`timeout_ms`.

`action`, `workflow_id`, `operation`, and `spec_path` are tool-call fields, not
YAML fields. `profile` is also a tool-call field used only by validate. The
listed YAML fields are exhaustive: do not copy extra fields from read/status
output or persisted runtime records. Deep admission is the only exception to
the minimal start envelope; load `guide(topic=policy)` and copy its
author-written admission shape instead of guessing fields.

Use these exact calls after writing the file:

- validate (start files only): `{ action: "validate", spec_path: "workflow.yaml", profile: "portable" }`
- start: `{ action: "start", spec_path: "workflow.yaml" }`
- extend: `{ action: "extend", workflow_id: "dag_...", spec_path: "extend.yaml" }`
- replan: `{ action: "control", operation: "replan", workflow_id: "dag_...", spec_path: "replan.yaml" }`

`validate` decodes a start envelope only. Extend and replan files are validated
by `extend` and `control(replan)` before any workflow mutation; standalone
preflight for those envelopes is not supported. A `config` wrapper that passes
start validation is not a valid extension file.

This guide owns the author-written block fields and semantics. The action
schema stays shallow and accepts only `spec_path`; the YAML validator rejects
unknown or missing graph fields by name and reports each error with its path.

`objective` is required and is injected into every generated node. Use blocks
or nodes, never both. Block IDs use letters, numbers, underscores, and hyphens.
Dependencies must be acyclic; they may name blocks in the submitted fragment
or existing durable node IDs during **extend** and replan.

## Block contracts

- `explore`: read-only repository mapping and evidence collection.
- `plan`: decision- or implementation-ready options/work packages, checks,
  falsifiers, and risks.
- `prototype`: the smallest throwaway experiment that resolves a runnable
  uncertainty; it does not silently become production code. It still publishes
  its changed-file list and fingerprint so later verification or review cannot
  bind to stale experiment evidence.
- `debug`: expands to reproduce/evidence followed by root-cause diagnosis.
- `coding`: bounded production implementation plus focused tests and checks.
- `verify`: deterministic acceptance checks with explicit PASS/FAIL evidence.
- `review`: design/content inputs expand to independent standards and intent
  reviews plus a general arbiter. An implementation input must follow a
  `coding → verify(PASS) → review` route; the compiler binds the implementation
  fingerprint through both reviews into an `ACCEPT | REJECT` decision. Lanes
  return structured `required_actions`; the runtime fails an ACCEPT that lists
  its own required actions or leaves a lane's action unrefuted.
- `synthesize`: resolves dependency outputs into the parent-facing result.

Block contracts are self-contained. `instruction` specializes a lifecycle kind
into a capability such as `codebase-design`, `domain-modeling`, or
`global-review`; it never delegates the method to an external Skill.

Judgment and acceptance gates (`plan`, debug diagnosis, `verify`, review
decision, and `synthesize`) are required by default. Volume lanes (`explore`,
`prototype`, `coding`, debug evidence, and independent review lanes) are
optional by default; an explicit `required` value on a block overrides its
default. `review` and `synthesize` report to the parent by default; other blocks
stay quiet. A block immediately after a review gate is conditioned on its
accepted verdict. Because the condition language handles one verdict reference,
fan multiple review lanes into one review block before continuing.

All block workers share one workspace. Unordered `coding` and `prototype`
writers run in parallel, so their work packages must be triple-disjoint:
source files, generated artifacts, and lockfiles must not overlap, and no
shared build may be triggered. The plan block owns this partition. For an
implementation review over parallel writers, the compiler injects one
read-only aggregation node between the writers and the verification gate; it
fails loudly when the declared write sets overlap and otherwise publishes the
union with a single implementation fingerprint computed at the convergence
point. Total-ordered writer chains compile unchanged. Read-only lanes remain
parallel throughout. The resident Orchestration Router owns route selection and
phase pruning; this guide owns block fields, contracts, and graph mechanics.

## When to use low-level nodes

Drop to `nodes` for custom template bindings, several conditional branches,
special output schemas, exact retry/cancel/restart controls, or deep diff-review
metadata. Load `guide(topic=interface)` for the full node interface and
`guide(topic=policy)` for gate and recovery contracts. Do not poll a running
workflow; reporting blocks wake the parent when a decision is actionable.
