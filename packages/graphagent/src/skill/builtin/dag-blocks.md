# Composable Workflow Blocks

Blocks are the high-level interface for a one-off workflow YAML file. The tool
compiles them into ordinary durable DAG nodes before validation and
persistence; node-based YAML remains compatible.

Use blocks when a DAG serves the task. Examples are optional, not a checklist or
stage minimum; selecting a block opts into its compiler and output contracts.

Every live `extend` or `control(replan)` costs a parent turn, so declare known
structure — parallel branches, dependencies, conditions, `fan_out` writers — in
the start graph, and mutate at runtime only for structure that depends on
results.

## Authoring contract

Never infer or invent a YAML field. Copy the intended envelope and change
values only. Unknown fields are errors; a field from a tool call, runtime
result, or other action does not belong here unless listed.

### Start file

Author-written top-level fields: optional `title`, `mode`, `admission`, and
required `config`. `objective` lives INSIDE `config`; the top level carries no
graph fields. For the block route, `config` requires `name`, `objective`,
`blocks`; optional fields are `node_defaults`, `max_concurrency`,
`max_node_replan_attempts`, `max_total_nodes`.

```yaml
title: Implement session recovery
config:
  name: implement-session-recovery
  objective: Implement session recovery with focused tests and evidence-backed review.
  blocks:
    - { id: map, kind: explore }
    - { id: design, kind: plan, depends_on: [map], instruction: Define the seam and interface plus acceptance evidence. }
    - { id: coding, kind: coding, depends_on: [design], instruction: Deliver through observable tests. }
    - { id: verify, kind: verify, depends_on: [coding] }
    - { id: review, kind: review, depends_on: [verify] }
```

### Extend file

An extend file takes its graph at the top level — required `objective` plus
`blocks` or `nodes`, never both. It has no `config`, `title`, `name`, or
`fragment` wrapper and no graph budgets (`max_concurrency`,
`max_node_replan_attempts`, `max_total_nodes`) or `node_defaults`: those belong
to the start document and cannot change.

```yaml
objective: Add regression coverage for the newly confirmed recovery edge case.
blocks:
  - { id: recovery-fix, kind: coding, instruction: Implement only the confirmed fix and its test. }
  - { id: recovery-verify, kind: verify, depends_on: [recovery-fix] }
```

### Replan file

A replan file contains only `fragment`. For the block route, `fragment` takes
start's `config` fields: required `name`, `objective`, `blocks`, plus the four
optional fields.

```yaml
fragment:
  name: recover-session-recovery
  objective: Replace the invalid route with a diagnosed, verified repair path.
  blocks:
    - { id: diagnose, kind: debug, instruction: Reproduce the failure and identify the evidence-backed root cause. }
    - { id: repair, kind: coding, depends_on: [diagnose], instruction: Apply the smallest supported repair. }
    - { id: verify, kind: verify, depends_on: [repair] }
```

Every block accepts only `id`, `kind`, `depends_on`, `instruction`,
`worker_type`, `worker_config`, `required`, and `report_to_parent`; `id` and
`kind` are required. Kinds: `explore`, `plan`, `prototype`, `debug`, `coding`,
`verify`, `review`, `synthesize`. Omit `worker_type` unless the exact configured
agent name is known; never invent one. Block `worker_config` (`timeout_ms` only)
overrides `node_defaults.worker_config` for every expanded node;
`node_defaults` accepts only `required`, `report_to_parent`, and
`worker_config`. `fan_out` is described below.

`action`, `workflow_id`, `operation`, `spec_path`, and `profile` (validate only)
are tool-call fields, not YAML. These YAML fields are exhaustive: do not copy
fields from read/status output or persisted records. Deep admission is the only
exception; load skill dag-policy.

Exact calls: validate
`{ action: "spec", operation: "validate", spec_path: "workflow.yaml", profile: "portable" }`,
start `{ action: "run", operation: "start", spec_path: "workflow.yaml" }`, extend
`{ action: "run", operation: "extend", workflow_id: "dag_...", spec_path: "extend.yaml" }`,
replan `{ action: "control", operation: "replan", workflow_id: "dag_...", spec_path: "replan.yaml" }`.
`spec.validate` decodes start only; extend and replan validate their own envelopes,
and a `config` wrapper is not a valid extension file.

`objective` is required and injected into every node; use blocks or nodes, never
both. IDs use letters, numbers, underscores, and hyphens; dependencies must be
acyclic and may name fragment blocks or durable node IDs during **extend** and
replan.

## Block contracts

- `explore`: read-only repository mapping and evidence collection.
- `plan`: decision- or implementation-ready options/work packages, checks,
  falsifiers, and risks.
- `prototype`: the smallest throwaway experiment resolving a runnable
  uncertainty; it is not production code but publishes its changed files and
  fingerprint for verification or review.
- `debug`: expands to reproduce/evidence followed by root-cause diagnosis.
- `coding`: bounded production implementation plus focused tests and checks.
- `verify`: deterministic acceptance checks with explicit PASS/FAIL evidence.
- `review`: design/content inputs expand to independent standards and intent
  reviews plus a general arbiter. An implementation input must follow
  `coding → verify(PASS) → review`; the compiler binds the implementation
  fingerprint through both reviews into an `ACCEPT | REJECT` decision. Lanes
  return `required_actions`; the runtime fails an ACCEPT that lists its own
  required actions or leaves a lane's action unrefuted.
- `synthesize`: resolves dependency outputs into the parent-facing result.

Block contracts are self-contained. `instruction` specializes a lifecycle kind
into a capability such as `codebase-design` or `global-review`; it never
delegates the method to an external Skill.

Judgment and acceptance gates (`plan`, debug diagnosis, `verify`, review
decision, `synthesize`) are required by default. Volume lanes (`explore`,
`prototype`, `coding`, debug evidence, independent review lanes) are optional;
an explicit `required` overrides. `review` and `synthesize` report to the
parent by default; other blocks stay quiet. A block after a review gate is
conditioned on its accepted verdict; the condition language handles one verdict
reference, so fan multiple review lanes into one review block first.

All block workers share one workspace. Unordered `coding` and `prototype`
writers run in parallel, so their packages must be triple-disjoint: source
files, generated artifacts, and lockfiles must not overlap, and no shared build
may run. The plan block owns this partition. For an implementation review over
parallel writers, the compiler injects a read-only aggregation node before the
verification gate; it fails loudly on overlapping write sets and otherwise
publishes the union with one implementation fingerprint computed at
convergence. Ordered chains compile unchanged; read-only lanes stay parallel.
The resident Orchestration Router owns route selection and phase pruning; this
skill owns block fields, contracts, and graph mechanics.

When the number of independent slices is known only after planning, declare one
`coding` block with `fan_out: <plan-block-id>` (the plan must also be in its
`depends_on`). That plan returns `packages` of
`{ id, instruction, write_set }`. When the writer is ready, two or more disjoint
packages run as parallel writers `<writer>--<package>`, and the writer's id
becomes their aggregator, so verify/review bindings stay unchanged. One package
runs the writer as authored; overlapping or malformed packages, or a node
ceiling, run it serially with the reason in its prompt.

## When to use low-level nodes

Drop to `nodes` for custom template bindings, conditional branches, output
schemas, retry/cancel/restart controls, or deep diff-review metadata. Load
skill dag-nodes for the node interface and skill dag-recovery for gates and
recovery. Do not poll a running workflow; reporting blocks wake the parent
when a decision is actionable.