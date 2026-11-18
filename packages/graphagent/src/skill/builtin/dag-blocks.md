# Composable Workflow Blocks

Blocks are the high-level interface for a workflow YAML file; they compile
into durable DAG nodes before validation and persistence, and node-based YAML
remains compatible.

Use blocks when a DAG serves the task; examples are optional, and selecting one
opts into its compiler and output contracts.

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
`review_gate` to `strict`, overriding a `standard`; otherwise it defaults to
`standard`. A deep workflow without `acceptance` derives
`AC1..ACn` from `admission.brief.acceptance_criteria`. `strict` also requires
block writers (`coding`/`prototype`/fan-out aggregator), a required
non-skippable diff decision bound to each writer after verify, `completeness`
among its lenses, read-only lanes and decision, and 1-50 unique `acceptance`
ids; `standard` warns instead.

```yaml
config:
  name: implement-session-recovery
  objective: Implement session recovery with focused tests.
  acceptance: [{ id: AC1, text: Recovery restores the session }]
  blocks: [{ id: coding, kind: coding }, { id: verify, kind: verify, depends_on: [coding] }, { id: review, kind: review, depends_on: [verify] }]
```

### Extend file

An extend file has the graph at top level — required `objective` plus
`blocks` or `nodes`, never both — and no `config`, `title`, `name`, `fragment`
wrapper, or start-only fields (`node_defaults`, graph budgets, `acceptance`,
`review_gate`).

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
`kind` are required. `review` blocks also accept `lenses`, `skeptics`, and
`prior_round: { workflow_id, review_id }`; the engine injects that stored
round's lane `required_actions` and dispositions as `prior_findings` keyed
`<workflow_id>/<lane>/<index>`, never hand-written.
`lenses` takes `standards`, `intent`, `completeness`, `security`, `tests`, or
`performance`, defaults to `[standards, intent]`, and produces one
`<block>--<lens>` lane each. `skeptics` is 0-4 (default 0), adding
`<block>--skeptic-1..n` lanes whose fixed angles rotate: evidence existence,
counterexample/minimal reproduction, alternative explanation, then
boundaries/concurrency. Other kinds reject these fields. Kinds:
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
both. IDs use letters, numbers, underscores, and hyphens; dependencies are
acyclic and may name fragment blocks or durable node IDs.

## Block contracts

- `explore`: read-only repository mapping and evidence.
- `plan`: decision- or implementation-ready packages, checks, falsifiers, and
  risks.
- `prototype`: the smallest throwaway experiment resolving a runnable
  uncertainty; it publishes changed files and fingerprint, not production code.
- `debug`: reproduce/evidence, then root-cause diagnosis.
- `coding`: bounded production implementation plus focused tests and checks.
- `verify`: deterministic acceptance checks with explicit PASS/FAIL evidence.
- `review`: `lenses` expand into one read-only lane per lens (default standards
  and intent), `skeptics` add 0-4 adversarial lanes, and `auditor` arbitrates.
  The `completeness` lens judges every `config.acceptance` item
  covered/partial/missing with evidence and enters unlisted items in
  `required_actions`. Implementation input follows `coding → verify(PASS) →
  review`; the compiler binds its fingerprint through every lane into
  `ACCEPT | REJECT`. Lanes return `required_actions` and may declare
  `not_examined`; ACCEPT fails on its own required actions or an unrefuted lane
  action. The decision returns `dispositions` for every lane action regardless
  of verdict and `resolved` for every prior finding; missing, duplicated, or
  dangling entries fail settlement, and ACCEPT rejects any upheld finding,
  `still_open` item, or duplicate of a still-open prior finding.
- `synthesize`: resolves dependency outputs into the parent-facing result.

Lanes, decision, `verify`, and `synthesize` default to the read-only
`auditor`; a writing `synthesize` declares `worker_type`.

`instruction` specializes a lifecycle kind such as `codebase-design` or
`global-review`; it never delegates method to an external Skill.

Judgment and acceptance gates (`plan`, debug diagnosis, `verify`, review
decision, `synthesize`) and writers (`prototype`, `coding`, fan-out packages)
default to required; `explore`, debug evidence, and review lanes are optional;
`required` overrides. `review` and `synthesize` report to the parent by
default. A block after a review gate is conditioned on
its accepted verdict; conditions handle one verdict reference, so fan multiple
review lanes into one review block first.

All block workers share one workspace. Unordered `coding` and `prototype`
writers run in parallel, so their packages must be triple-disjoint: source
files, generated artifacts, and lockfiles never overlap, and no shared build
may run; the plan block owns this partition. For parallel writers, the compiler
injects a read-only aggregator before verification; it fails on overlapping
write sets and otherwise publishes the union with one implementation
fingerprint.

When slices emerge only after planning, declare one `coding` block with
`fan_out: <plan-block-id>` (also in its `depends_on`). That plan returns
`packages` of `{ id, instruction, write_set }`. Two or more disjoint packages
run as parallel writers `<writer>--<package>` joined by an aggregator under the
writer's id, so bindings stay unchanged; otherwise the writer runs serially.

## When to use low-level nodes

Drop to `nodes` for custom templates, conditional branches, output schemas,
retry/cancel, or deep diff-review metadata. Load skill
dag-nodes for node fields and skill dag-recovery for gates and recovery.