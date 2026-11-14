# DAG Nodes

Nodes are the low-level durable interface: a workflow graph is a list of nodes
connected by `depends_on`. Blocks compile into these nodes; load skill
dag-blocks for the block route and skill dag-policy for policy contracts. It
owns node fields, saved-workflow resolution, prompt assets, budgets, and
workspace discipline.

## Saved workflows

A `spec_path` with no separator, no leading `.`, no control characters, and no
`.yaml`/`.yml` extension is a **name** resolved against the workflow library (a
leading dot or recognized extension means a filesystem path). The synthetic
`builtin://<name>` marker shown by `list` also resolves by name:

1. `.agents/workflows/<name>.yaml` — project scope, committed with the repo
2. `<graphagent config dir>/workflows/<name>.yaml` — global, every project
3. bundled builtin templates shipped with the runtime

Project shadows global, and both shadow builtin. When discovering a reference,
call `workflow({params:{action:"spec",operation:"list"}})` and use only an exact
returned name; never infer one. A supplied path or task-local graph needs no
search. To inspect a saved graph without starting it, call
`{ operation: "read", spec_path: "<name-returned-by-list>" }`; retarget its
objective and block instructions in the parent, write the edited value to a
task-local YAML file, then start that path. `read` never starts a workflow. A
name that resolves nowhere fails with the searched locations.

After choosing a DAG, a saved workflow can be a useful starting point; a small
task-local graph needs no library search. Keep one primary reference so the
objective stays clear, and borrow secondary checks where they add evidence
rather than concatenating whole workflows. `lite` and `full` are reference
shapes, not mandatory tiers. Uncertainty, irreversibility, public contracts,
concurrency, persistence, authorization, or upstream executable dependencies
can warrant more evidence; choose checks that address the actual risk. A risk
label or non-`ACCEPT` verdict alone never requires a full graph or a fixed
reviewer count. Retarget a matching custom workflow and reuse valid results;
the Verdict Disposal Contract (skill dag-recovery) describes follow-up options.

## Node inputs and model selection

Every node receives its direct `depends_on` outputs:

- The exact dependency ID is the default template variable. A node with
  `depends_on: [node-a, node-b]` can use `{{node-a}}` and `{{node-b}}` directly.
- Values not interpolated into the prompt are appended as structured context,
  so a downstream node can aggregate them without interpolation.
- Use `input_mapping` only to rename a variable or select a field. Its direction
  is **template variable → upstream source**:

```yaml
input_mapping:
  resultA: node-a
  resultB: node-b
  count: node-c.output.count
prompt_template:
  inline: "Summarize {{resultA}}, {{resultB}}, and count={{count}}."
```

Put shared node defaults in `config.node_defaults`; every node inherits omitted
values from this durable config, and an explicit node value wins:

```yaml
config:
  node_defaults:
    required: false
    report_to_parent: false
    worker_config:
      timeout_ms: 600000
```

The listed node and default fields are exhaustive; workflow YAML has no
model-selection field. Model selection is configuration-owned: `required: true`
and `worker_type: review` / `review-*` nodes prefer the `advanced` tier in the
`dag` section of `settings.json`; others prefer `standard` (one configured tier
serves both). Resolution falls back to the selected agent model and the
parent-session model. If none provides a model, the tool returns a blocked
diagnostic and creates no workflow; authorized recovery or a configuration
decision may be needed.

## Prompt Templates

Templates are read-only prompt fragments installed under project
`.agents/workflows/prompts/*.md` or global
`<graphagent config dir>/workflows/prompts/*.md`. Project assets shadow global;
prompt IDs have no bundled fallback, and bundled YAML does not install
fragments. Confirm a referenced ID exists before use; missing assets are
rejected during environment validation. Supply required `{{variable}}` inputs
through static `prompt_template.input` or `input_mapping`; validation checks
bindings and spawn resolves actual values. These example assets require
separate installation; inspect each for its current contract:

- `code-explore` / `test-explore` / `config-explore` (each requires `target`):
  structure searches
- `arch-gate`, `implement` (requires `spec`), `plan`, `verify`,
  `integration-test`, `patcher-assemble`, `review-arch`, `review-logic`,
  `review-style`

Dependency outputs not interpolated into a prompt are appended as structured
context. For review prompts, request an `unverified_claims` section a
downstream verification wave can check against the code.

For ad-hoc prompts, use `prompt_template: { inline: "...", input: {...} }`.
Static `prompt_template.input` supplies literal, local values; it does not read
upstream output. Inline templates interpolate static values and direct
dependency variables. Use `input_mapping` when an upstream output needs a
stable variable name or field selection. Mapped objects/arrays render as
indented JSON; they must never appear as `[object Object]`.

## Budget Declaration

The engine enforces declared budgets without adaptive increases. Defaults can
be sufficient; adjust when expected tool time, resource limits, or evidence
volume warrants it, rather than because a task is labelled large. Higher
concurrency only helps genuinely independent work:

- `max_concurrency`: default 5. Balance independent work against host and
  provider capacity.
- `max_node_replan_attempts`: default 5. Increase only for iterative
  quality-driven convergence (review → revise → review on one artifact).
- `max_total_nodes`: default and minimum 100 (lower values are raised to 100).
- `worker_config.timeout_ms`: default 10 minutes. Increase for long-running
  nodes (compilation, large test suites). Verifiers and aggregators are the
  most common timeout victims: consuming several parallel reports and
  re-checking their claims runs sequentially and routinely needs 20–30 minutes
  (for example `timeout_ms: 1800000`). Declaring the fan-out lanes' budget for
  the fan-in lane is a recurring failure pattern.

## Single-Workspace Discipline

All nodes share the same workspace. Write conflicts are an orchestration
concern, not an infrastructure one. Two tiers:

**Tier A — Disjoint write sets**: parallel nodes that write to non-overlapping
files/paths can run concurrently without coordination. Structure the
decomposition so each node owns a distinct module or file set.

**Tier B — Propose-then-assemble**: when disjoint write sets cannot be
guaranteed, parallel nodes produce proposals (structured output via
`output_schema`) instead of writing files. One assembly node applies the
changes sequentially; review converges on its diff, not scattered edits.

## Node Fields

| Field              | Required | Description |
| ------------------ | -------- | ----------- |
| `id`               | yes      | Unique node identifier, used in `depends_on` |
| `name`             | yes      | Human-readable name |
| `worker_type`      | yes      | Agent type (`explore`, `build`, `general`, `plan`, or custom) |
| `depends_on`       | yes      | Node IDs this node waits for (`[]` for root) |
| `required`         | no       | If true and this node fails, the workflow terminalizes as failed. Default: false |
| `prompt_template`  | yes      | `{ id: "..." }` or `{ inline: "...", input: {...} }` |
| `condition`        | no       | One comparison `<dep-id>.output.<field> <op> <value>` over a direct dependency, evaluated before spawn; the node is skipped if false. `op` is `==`, `!=`, `>`, `<`, `>=`, or `<=`; `value` is a number, `true`/`false`/`null`, a bare word, or a quoted string. Other syntax (`===`, `!==`, `&&`, `\|\|`) is rejected |
| `input_mapping`    | no       | Map upstream node outputs into template variables |
| `report_to_parent` | no       | If true, the parent wakes when this node completes or fails. Terminal status always wakes the parent regardless |
| `worker_config`    | no       | `{ timeout_ms }` — bounds the node from permit acquisition to completion (default 10 minutes); queued time does not count, but a permit wait longer than `timeout_ms` fails the node without spawning, and a running node that exceeds it escalates before failing |
| `output_schema`    | no       | JSON Schema for the node result. The final answer must be exactly one matching JSON value; validation/capture happen before the node settles, and a near-miss on a present field gets one bounded correction turn |
| `restart`          | no       | (replan only) Re-spawn this running node with the new prompt |
| `cancel`           | no       | (replan only) Cancel this node |
| `review`           | no       | (deep review workers) `{ phase: "design" \| "diff" }`; a `diff` review must declare `implementation_node_id` / `verification_node_id` and wire transitive review→verification→implementation dependencies, `input_mapping` for the diff artifact + fingerprint + verification output, a PASS-gated `condition`, and a `verdict` + `implementation_fingerprint` `output_schema`. Authoring rejects violations in deep mode and warns in standard |

A node that declares `output_schema` must end with exactly one JSON value
matching the schema, without Markdown fences or surrounding prose; the runtime
validates and captures that final answer. A node without `output_schema`
returns its complete final answer as plain text. The final answer is the only
result path; the child must not send the same result through `agent.send`.
Use `agent.send` for questions, decisions, and collaboration.

### Result delivery

A completed workflow delivers its selected result to the parent once; the
parent must not summarize it again. Set `delivery_node` to choose the result
node. A one-leaf `synthesize` workflow selects it automatically; otherwise the
parent gets a deterministic index of results. Delivery does not change
scheduling, pause, failure, timeout, or actionable-wake behavior.