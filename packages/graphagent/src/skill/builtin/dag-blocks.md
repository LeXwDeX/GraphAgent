# Composable Workflow Blocks

Blocks are the high-level interface for a one-off workflow YAML file; they
compile into durable DAG nodes before validation and persistence. Node-based
YAML remains compatible.

Use blocks when a DAG serves the task. Examples are optional, not a checklist or
stage minimum; selecting one opts into its compiler and output contracts.

Every live `extend` or `control(replan)` costs a parent turn: declare known
structure in the start graph, and mutate at runtime only for structure that
depends on results.

## Authoring contract

Never infer or invent a YAML field. Copy the intended envelope and change
values only. Unknown fields are errors; a tool-call or runtime field does not
belong here unless listed.

### Start file

Top-level fields: optional `title`, `mode`, `admission`, required `config`.
`objective` lives INSIDE `config`; the top level carries no graph fields.
`config` requires `name`, `objective`, `blocks`; optional fields are
`node_defaults`, `max_concurrency`, `max_node_replan_attempts`,
`max_total_nodes`, `acceptance`, and `review_gate`.

`acceptance` is `[{ id, text }]`; `review_gate` is `"strict"` or `"standard"`.
Both are start-only and fixed at run.start: DAG mode on or `mode: deep` fixes
`review_gate` to `strict`, overriding an authored `standard`; otherwise it
defaults to `standard`. A deep workflow without `acceptance` derives
`AC1..ACn` from `admission.brief.acceptance_criteria`.

```yaml
config:
  name: implement-session-recovery
  objective: Implement session recovery with focused tests.
  acceptance: [{ id: AC1, text: Recovery restores the interrupted session }]
  blocks: [{ id: coding, kind: coding }, { id: verify, kind: verify, depends_on: [coding] }, { id: review, kind: review, depends_on: [verify], lenses: [standards, intent, completeness] }]
```

### Extend file

An extend file takes its graph at the top level — required `objective` plus
`blocks` or `nodes`, never both. It has no `config`, `title`, `name`, or
`fragment` wrapper and no start-document fields (`node_defaults`, graph budgets,
`acceptance`, `review_gate`).

```yaml
objective: Add regression coverage.
blocks: [{ id: fix, kind: coding }, { id: verify, kind: verify, depends_on: [fix] }]
```

### Replan file

A replan file contains only `fragment`, which takes start's `config` fields
except the start-only `acceptance` and `review_gate`.

```yaml
fragment:
  name: recover-session-recovery
  objective: Replace the invalid route with a diagnosed repair path.
  blocks: [{ id: diagnose, kind: debug }, { id: repair, kind: coding, depends_on: [diagnose] }, { id: verify, kind: verify, depends_on: [repair] }]
```

Every block accepts only `id`, `kind`, `depends_on`, `instruction`,
`worker_type`, `worker_config`, `required`, and `report_to_parent`; `id` and
`kind` are required. `review` blocks also accept `lenses` and `skeptics`.
`lenses` takes `standards`, `intent`, `completeness`, `security`, `tests`, or
`performance`, defaults to `[standards, intent]`, and produces one
`<block>--<lens>` lane each. `skeptics` is 0-4 (default 0), adding
`<block>--skeptic-1..n` lanes whose fixed angles rotate: evidence existence,
counterexample/minimal reproduction, alternative explanation, then
boundaries/concurrency. Either field on another kind is a compile error. Kinds:
`explore`, `plan`, `prototype`, `debug`, `coding`, `verify`, `review`,
`synthesize`. Never invent `worker_type`. `worker_config` (`timeout_ms` only)
overrides `node_defaults.worker_config`; `node_defaults` accepts only
`required`, `report_to_parent`, and `worker_config`.

`action`, `workflow_id`, `operation`, `spec_path`, and `profile` (validate only)
are tool-call fields, not YAML. These YAML fields are exhaustive: do not copy
fields from read/status output or persisted records. Deep admission is the only
exception; load skill dag-policy.

Validate
`{ action: "spec", operation: "validate", spec_path: "workflow.yaml", profile: "portable" }`;
start and extend use `{ action: "run", operation: "start" | "extend", spec_path: "file.yaml" }`;
replan uses
`{ action: "control", operation: "replan", workflow_id: "dag_...", spec_path: "replan.yaml" }`.
`spec.validate` decodes start only; extend and replan validate their own
envelopes, and a `config` wrapper is not a valid extension file.

`objective` is required and injected into every node; use blocks or nodes, never
both. IDs use letters, numbers, underscores, and hyphens; dependencies must be
acyclic and may name fragment blocks or durable node IDs.

## Block contracts

- `explore`: read-only repository mapping and evidence collection.
- `plan`: decision- or implementation-ready options/work packages, checks,
  falsifiers, and risks.
- `prototype`: the smallest throwaway experiment resolving a runnable
  uncertainty; it publishes changed files and fingerprint, not production code.
- `debug`: expands to reproduce/evidence followed by root-cause diagnosis.
- `coding`: bounded production implementation plus focused tests and checks.
- `verify`: deterministic acceptance checks with explicit PASS/FAIL evidence.
- `review`: `lenses` expand into one read-only lane per lens (default standards
  and intent), `skeptics` add optional adversarial lanes, and `auditor`
  arbitrates them. The `completeness` lens judges every `config.acceptance` item
  covered/partial/missing with evidence, lists unlisted expectations, and enters
  missing/unlisted items in `required_actions`. An implementation input must
  follow `coding → verify(PASS) → review`; the compiler binds the implementation
  fingerprint through every review lane into an `ACCEPT | REJECT` decision.
  Lanes return `required_actions`; the runtime fails an ACCEPT that lists its
  own required actions or leaves a lane's action unrefuted.
- `synthesize`: resolves dependency outputs into the parent-facing result.

Review lanes, skeptics, the decision, `verify`, and `synthesize` default to the
built-in read-only `auditor`; a writing `synthesize` declares `worker_type`.

`instruction` specializes a lifecycle kind such as `codebase-design` or
`global-review`; it never delegates the method to an external Skill.

Judgment and acceptance gates (`plan`, debug diagnosis, `verify`, review
decision, `synthesize`) default to required; volume lanes (`explore`,
`prototype`, `coding`, debug evidence, independent review lanes) are optional,
and an explicit `required` overrides. `review` and `synthesize` report to the
parent by default; other blocks stay quiet. A block after a review gate is
conditioned on its accepted verdict; the condition language handles one verdict
reference, so fan multiple review lanes into one review block first.

All block workers share one workspace. Unordered `coding` and `prototype`
writers run in parallel, so their packages must be triple-disjoint: source
files, generated artifacts, and lockfiles never overlap, and no shared build
may run. The plan block owns this partition. For an implementation review over
parallel writers, the compiler injects a read-only aggregation node before the
verification gate; it fails on overlapping write sets and otherwise publishes
the union with one implementation fingerprint. Ordered chains compile unchanged;
read-only lanes stay parallel. The Orchestration Router owns routing; this skill
owns block fields and graph mechanics.

When independent slices are known only after planning, declare one `coding`
block with `fan_out: <plan-block-id>` (the plan must also be in its
`depends_on`). That plan returns `packages` of
`{ id, instruction, write_set }`. Two or more disjoint packages run as parallel
writers `<writer>--<package>` joined by an aggregator under the writer's id, so
verify/review bindings stay unchanged; one package, or overlapping/malformed
packages or a node ceiling, runs the writer serially with the reason in its
prompt.

## When to use low-level nodes

Drop to `nodes` for custom template bindings, conditional branches, output
schemas, retry/cancel controls, or deep diff-review metadata. Load skill
dag-nodes for node fields and skill dag-recovery for gates and recovery. Do not
poll a running workflow; reporting blocks wake the parent.