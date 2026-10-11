<!--
  Shared workflow-tool guidance. The /dag-auto command prepends its routing
  contract, while the workflow tool uses this neutral reference directly.
-->

# Workflow Orchestration

The `workflow` tool orchestrates dependency-graph multi-agent workflows. Each
node runs as a real child session with its own agent and tools. The resident
Orchestration Router owns execution-mode and saved-reference selection; this
guide owns the YAML/tool interface after a workflow has been selected.

The composition examples below are optional shapes, not minimum phases or
reasons to start a DAG. Choose depth and division of work according to the
evidence still needed; the orchestration policy distinguishes those choices
from runtime-enforced model, admission, and review contracts.

## Standard and deep workflow entry

Omitting `mode` at the root of the YAML start spec preserves `standard` behavior. The `start` tool call takes `action` and `spec_path`; put `mode` in the file.
Consider `deep` when its admission and review contracts serve the task or the
user explicitly requests it. Uncertainty or high impact can justify stronger
checks without a prescribed mode or number of agents.

Before `start`, `extend`, `control(replan)`, or `validate`, write the graph to a
`.yaml` or `.yml` file and pass only `spec_path`. A one-off graph may use a
task-local file such as `.opencode/.dag-specs/<name>.yaml`; it does not need to
become a saved library workflow. After a validation failure, edit that same
file and retry with the same path. Standalone `validate` accepts start files
only; `extend` and `control(replan)` validate their own strict envelopes before
any workflow mutation.

Before a deep start, qualify the request interactively in the parent session.
The start spec places `mode: deep`, a versioned `READY` or informed `WAIVED`
admission input, and `config` at the same level. The admission input accepts
only `brief_revision`, `qa_mode`, `verdict`, `brief`, and waiver audit fields
when applicable. Do not copy additional fields from persisted records or tool
responses. Do not put admission QA inside the graph: its answers define the
graph. Use the orchestration policy below for QA modes, round budgets, verdict
recovery, revision invalidation, and waiver audit fields.

A deep start spec has this outer shape:

```yaml
title: Deep review
mode: deep
admission:
  brief_revision: 1
  qa_mode: STANDARD
  verdict: READY
  brief:
    goal: Review the requested implementation
    scope:
      in: [requested modules]
      out: [unrelated modules]
    constraints: [read-only reviewers]
    assumptions: [the working tree is the review target]
    acceptance_criteria: [all material findings are evidence-backed]
    evidence_required: [code references, relevant test results]
    risks: [missed cross-module regressions]
    review_plan: [parallel review, claim verification, final arbitration]
    open_questions: []
    blocking_questions: []
config:
  name: deep-review
  nodes: []
```

## Saved workflows

A `spec_path` with no path separator, no leading `.`, no control characters,
and no `.yaml`/`.yml` extension is a **name** resolved against the workflow
library instead of the filesystem (a leading dot or a recognized extension
means a filesystem path). The synthetic `builtin://<name>` marker the `list`
output shows for builtin templates also resolves by name:

1. `.opencode/workflows/<name>.yaml` — project scope, committed with the repo
2. `<opencode config dir>/workflows/<name>.yaml` — global scope, available in every project
3. bundled builtin templates shipped with the runtime

Project shadows global, and both shadow builtin. When discovering a reference,
call `workflow(action: "list")` and use only an exact returned name; never infer
one. A supplied path or a task-local graph does not require a library search. To inspect a
saved graph without starting it, call
`{ action: "read", spec_path: "<name-returned-by-list>" }`. Retarget its
objective and block instructions in the parent, then write the edited value to
a task-local YAML file. `read` never starts a workflow. A name that resolves
nowhere fails with the searched locations.

## Orchestration Lifecycle

When a DAG is useful, these are possible phases to adapt to the remaining
work. They are not a mandatory sequence, even for a large task:

1. **Explore + brainstorm** — exploration nodes fan out over the codebase while independent generators propose approaches; a required synthesizer converges them into a design plus architecture inventory.
2. **Design review gate** — An advanced-tier gate (`report_to_parent: true`, normalized verdict `output_schema`) reviews the design. `required: true` fails the workflow only if the gate fails to execute or meet its output contract. A successful `REVISE` or `REJECT` is a business verdict, not an execution failure. Route the static ACCEPT path through a downstream `condition`. Handle a reported non-ACCEPT verdict under the Verdict Disposal Contract.
3. **Parallel execution** — the accepted design decomposes into module-level worker nodes with disjoint write sets, fanning into a required assembler.
4. **Verify + diff review + audit** — production assurance follows `implementation → verification(PASS) → diff review → final gate/audit` with fingerprint echo; `REJECT` routes through corrected implementation and verification before a new diff review. Progress tracking is updated to reflect what shipped.
5. **Expansion decision** — Iterate with bounded `control(replan)` on affected nodes, extend the workflow with parallel nodes, or complete it with `control(complete)`. For failed work, prefer `control(recover)` to retry the affected subtree in place. Cancelled workflows require `resume_cancelled: true`. Start a continuation workflow only if the original cannot be adapted or recovered.

A well-specified task may need implementation and verification without separate
exploration, design, or synthesis nodes. Existing evidence can remove whole
phases. Direct execution remains an option when the remaining work no longer
benefits from orchestration, after settling any active child writers.

## Node inputs and model selection

Every node automatically receives the outputs of its direct `depends_on` nodes:

- The exact dependency ID is the default template variable. A node with `depends_on: [node-a, node-b]` can use `{{node-a}}` and `{{node-b}}` directly.
- Values not already interpolated into the prompt are appended as structured context, so a downstream node can aggregate them without interpolation.
- Use `input_mapping` only to rename a variable or select a field. Its direction is **template variable → upstream source**, for example:

```yaml
input_mapping:
  resultA: node-a
  resultB: node-b
  count: node-c.output.count
prompt_template:
  inline: "Summarize {{resultA}}, {{resultB}}, and count={{count}}."
```

Put shared node defaults in the workflow's `config.node_defaults`. Every node
inherits omitted values from this durable workflow config, while an explicit
node value wins:

```yaml
config:
  node_defaults:
    required: false
    report_to_parent: false
    worker_config:
      timeout_ms: 600000
```

The listed node and default fields are exhaustive; workflow YAML has no
model-selection field. Model selection is configuration-owned: nodes with
`required: true` or `worker_type: review` / `review-*` prefer the `advanced`
tier in `dag.jsonc`; other nodes prefer `standard`. A single configured tier
serves both groups. Resolution then falls back to the selected agent model and
the parent-session model. If no
source provides a model, the workflow tool returns a blocked diagnostic and
leaves the workflow uncreated. The parent can consider authorized recovery or
report the configuration decision needed from the user.

## Collaboration Patterns

Four structural patterns illustrate common cases; none is a required template
or minimum node count. Real workflows can combine or simplify them. Every
block below is YAML file content. Save the selected shape, validate
it with `{ action: "validate", spec_path: "<file>.yaml" }`, then start it with
`{ action: "start", spec_path: "<file>.yaml" }`.

### 1. Staged Pipeline with Gate

Sequential phases where each depends on the previous. Insert a gate node between phases to block downstream execution until quality is confirmed.

```yaml
config:
  name: staged-gate
  nodes:
    - id: explore
      name: explore
      worker_type: explore
      depends_on: []
      prompt_template: { inline: "Explore the auth module and report findings."}
      required: true

    - id: gate
      name: gate
      worker_type: general
      depends_on: [explore]
      input_mapping:
        findings: explore
      required: true
      report_to_parent: true
      output_schema:
        type: object
        required: [verdict, summary]
        properties:
          verdict:
            type: string
            enum: [ACCEPT, REVISE, REJECT, BLOCKED]
          summary: { type: string }
      prompt_template:
        inline: "Review these findings and submit a structured verdict: {{findings}}"

    - id: implement
      name: implement
      worker_type: build
      depends_on: [gate]
      condition: 'gate.output.verdict == "ACCEPT"'
      prompt_template:
        inline: "Implement based on approved findings."
```

The gate node is `required: true`, so an execution or output-contract failure
cancels the workflow. A successful non-ACCEPT verdict does not fail the node;
the condition prevents `implement` from running, and the reported verdict gives
the parent an actionable replan or stop decision.

### 2. Parallel Fan-out

One preparatory node feeds N independent worker nodes, which fan back into a single assembler.

```yaml
config:
  name: parallel-fan-out
  nodes:
    - id: discover
      name: discover
      worker_type: explore
      depends_on: []
      prompt_template: { inline: "List all packages that need the API migration." }
      required: true

    - id: migrate-auth
      name: migrate-auth
      worker_type: build
      depends_on: [discover]
      prompt_template: { inline: "Migrate the auth package to the new API." }

    - id: migrate-server
      name: migrate-server
      worker_type: build
      depends_on: [discover]
      prompt_template: { inline: "Migrate the server package to the new API." }

    - id: migrate-cli
      name: migrate-cli
      worker_type: build
      depends_on: [discover]
      prompt_template: { inline: "Migrate the CLI package to the new API." }

    - id: assemble
      name: assemble
      worker_type: build
      depends_on: [migrate-auth, migrate-server, migrate-cli]
      prompt_template: { inline: "Run integration tests and assemble a summary." }
```

`migrate-*` nodes execute concurrently (bounded by `max_concurrency`). `assemble` waits until all three complete. Non-required worker nodes that fail do not cancel the workflow — `assemble` still runs and can report which migrations failed.

### 3. Adversarial Review

Multiple reviewers can help when different expertise or independent scrutiny
adds evidence. An arbiter can resolve conflicting reports. The example gates
follow-up work on its verdict; a read-only review can instead finish with the
parent's findings report. See the Verdict Disposal Contract for options.

```yaml
config:
  name: adversarial-review
  nodes:
    - id: implement
      name: implement
      worker_type: build
      depends_on: []
      prompt_template: { inline: "Implement the requested change per the task description." }
      required: true

    - id: review-arch
      name: review-arch
      worker_type: general
      depends_on: [implement]
      prompt_template:
        inline: "Review the implementation for architecture. Report evidence-backed findings and unverified claims."

    - id: review-logic
      name: review-logic
      worker_type: general
      depends_on: [implement]
      prompt_template:
        inline: "Review the implementation for logic correctness. Report evidence-backed findings and unverified claims."

    - id: review-style
      name: review-style
      worker_type: general
      depends_on: [implement]
      prompt_template:
        inline: "Review the implementation for code style. Report evidence-backed findings and unverified claims."

    - id: arbitrate
      name: arbitrate
      worker_type: general
      depends_on: [review-arch, review-logic, review-style]
      required: true
      report_to_parent: true
      output_schema:
        type: object
        required: [verdict, summary, findings, required_actions]
        properties:
          verdict:
            type: string
            enum: [ACCEPT, REVISE, REJECT, BLOCKED]
          summary: { type: string }
          findings: { type: array }
          required_actions: { type: array }
      prompt_template:
        inline: "Three reviewers produced findings. Submit one structured ACCEPT, REVISE, REJECT, or BLOCKED decision with deduplicated findings and required actions. The parent chooses any workflow control action."

    - id: deep-dive
      name: deep-dive
      worker_type: general
      depends_on: [arbitrate]
      condition: 'arbitrate.output.verdict != "ACCEPT"'
      report_to_parent: true
      prompt_template:
        inline: "The arbiter did not accept. Verify each required action against the actual code and produce a corrected, evidence-backed action plan."
```

The three reviewer nodes use `worker_type: general` without `required: true`,
so they prefer `standard` from `dag.jsonc`. Node IDs and prompt IDs do not
select a model tier. The arbiter prefers `advanced` because it is
`required: true` — its execution failure signals
that the artifact could not be confidently accepted, while its successful
business verdict must still be interpreted. On `ACCEPT` the conditioned
`deep-dive` node is skipped and the workflow completes; on any other verdict
it runs with the arbiter's findings as context, so a non-ACCEPT outcome can
never silently terminalize the graph.

### 4. Diverge-Converge (Brainstorm)

Multiple independent generators produce candidate solutions; a converger selects and refines.

```yaml
config:
  name: diverge-converge
  nodes:
    - id: gen-a
      name: gen-a
      worker_type: general
      depends_on: []
      prompt_template:
        inline: "Propose a solution for X using approach: microservices."

    - id: gen-b
      name: gen-b
      worker_type: general
      depends_on: []
      prompt_template:
        inline: "Propose a solution for X using approach: modular monolith."

    - id: gen-c
      name: gen-c
      worker_type: general
      depends_on: []
      prompt_template:
        inline: "Propose a solution for X using approach: event-driven."

    - id: converge
      name: converge
      worker_type: general
      depends_on: [gen-a, gen-b, gen-c]
      required: true
      prompt_template:
        inline: "Three approaches were proposed. Compare trade-offs and select the best fit for the constraints."
```

## Adaptive Replanning

Workflows are not static. After creating a workflow, use `extend` and `control(replan)` to adapt based on observed results:

- **Scale up**: a node reports the work is larger than expected → `extend` with additional parallel nodes to split the load.
- **Cut short**: a node proves the remaining work is unnecessary → `control(complete)` to early-complete and skip pending nodes.
- **Redirect**: If a gate or review shows the workflow is going in the wrong direction, call `control(pause)` to freeze scheduling. Then call `control(replan)` with `restart: true` on affected nodes and `cancel: true` on their downstream dependents. A successful replan resumes the workflow automatically. Call `control(resume)` manually only if the output says automatic resume raced with another control operation.
- **Grant more time**: A running node may be extended only after its formal timeout escalation is delivered to the parent. Call `control(extend_timeout)` with a larger `timeout_ms`. It extends the deadline in place and uses no replan, graph rewrite, new child session, or replan attempt. Prefer it over `control(replan)` unless the graph must also change.

Only nodes with `report_to_parent: true` produce intermediate parent
checkpoints, and those reports are delivered at the next actionable wake
boundary. Terminal workflow state also wakes the parent. Do not poll `status`
merely to wait. When a report exposes a flawed decomposition, consider whether
targeted replanning, direct follow-up, or stopping best serves the task. Note the terminal
boundary: the runtime's mandatory-action guard only covers workflows that are
still live, so a checkpoint that terminalizes its workflow delivers its
verdict with no runtime enforcement — the Verdict Disposal Contract in the
orchestration policy governs exactly that case (`extend` remains valid after
a reporting leaf naturally completed the graph).

### Escalation: change approach after repeated failures

**Change your approach** when a node or workflow repeatedly fails. Triggers include `orchestrator_unresponsive` (the turn ended with the workflow still RUNNING and stalled), a replan-attempt ceiling rejection, or repeated review failures. A rejected replan or extend parks the workflow as paused and recoverable, not failed. Call `control(pause)` before stopping to ask the user. Try a different decomposition, model, or prompt, or split the node into smaller steps. Repeating the same failing plan wastes budget. Never cancel the graph just to avoid `orchestrator_unresponsive`; pause and ask the user instead of destroying in-flight work.

### Crash recovery: a recovered workflow arrives paused

After a process restart, nodes that were mid-flight are failed conservatively
(`execution ownership lost on recovery`) — recovery never re-runs provider work
implicitly. The workflow then PAUSES instead of terminalizing, and you receive
the failed-node wake. Downstream nodes stay `pending`, so the graph is still
replannable. Available choices include:

- **Recover (preferred for an unchanged graph)**: Read `status`, then call `control(recover)` with the failed `node_ids` and `expected_graph_rev`. It creates attempts for the affected subtree and resumes scheduling. If prompts or topology must change, use pause → replan instead.
- **Resume as-is**: accept the failure. A required-node failure terminalizes the workflow as `failed` (attributed to the node ids); optional failures degrade and continue.
- **Cancel**: abandon the workflow.

Never assume a crashed workflow resumes or retries on its own — it will wait,
paused, until you act.

### Node failure triage

A node-failure wake is evidence for diagnosis, not an automatic retry or restart
instruction. Every node failed via `dag.node.failed` carries an `error_class` in
`status` output and in the wake summary. Exception: a node cancelled via replan
appears as `failed` with error_reason `cancelled via replan` and NO
`error_class` — deliberate action, no triage needed. Triage on the class
before acting:

| error_class           | What it means                                                                                                                               | Correct response                                                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `timeout`             | The node exceeded `timeout_ms`; its child session was cancelled. The cause may be workload, a stalled tool, or an unsuitable decomposition. | Inspect partial work before choosing a larger budget, a smaller task, direct follow-up, or a stop.                                                  |
| `exec_failed`         | Runtime/session failure; `error_reason` distinguishes configuration, provider, crash ownership loss, and workflow-collateral failure.       | Diagnose the actual cause. Recover relevant attempts after an authorized fix; configuration errors do not authorize model or credential changes.    |
| `verdict_fail`        | Output or review contract failure, including pre-spawn template/input problems or missing structured output.                                | Inspect the error and child evidence before retrying. Prompt emphasis cannot repair broken interpolation, stale fingerprints, or provider failures. |
| (cascade — see below) | Dependents of a failed node. No dedicated class.                                                                                            | Determine which upstream evidence failed before repeating dependent work.                                                                           |

Cascade detection has two shapes:

- **Required node failed** → the workflow terminalizes `failed`; still-running nodes are failed with the workflow reason and all other pending/queued/paused dependents are terminalized to `skipped` with error_reason `workflow_failed` (dependents stay untouched only while the workflow is still `paused` — terminalization happens when the scheduler evaluates). The culprit is a node in the Failed-nodes block whose `error_class` is a real failure class; collateral rows carry the workflow reason instead.
- **Optional node failed** → dependents ran with `Dependency "X" failed: ...` / `Dependency "X" skipped: ...` interpolated into their prompt text (inspect the dependent's rendered prompt/input, not its `error_reason`). Judge per dependent whether its output is still valid with the degraded input.

In both shapes, select the root/classed node for `control(recover)`; its downstream closure is replaced automatically. If the work definition needs changes, repair the graph through `replan` and rewire dependents explicitly.

`orchestrator_unresponsive` recipe (zero attribution by design — the parent
took no mandatory action while the workflow stalled): read `status`, identify
which nodes were `running` or stuck when the guard fired, then dispose per the
Verdict Disposal Contract: recover those nodes, or change the approach
(see Escalation) if the stall repeats. Never repair collateral rows blindly.

The value set above is what the runtime produces today; `push_exhausted`
exists in the schema but is reserved and currently never emitted.

Budget exhaustion is a separate class: `replan attempt ceiling exceeded` or
`Total node ceiling exceeded` means the budget is spent — change the approach
or stop, do not retry the identical plan (see Escalation).

Where to apply the repair:

- **Local retry in the same workflow**: pause live scheduling, read `status`, then call `control(recover)` with the current `expected_graph_rev` and selected `node_ids`. Failed workflows can recover directly. The runtime creates new attempts for these nodes and their downstream closure, preserves unrelated nodes, checks reusable managed artifacts, and resumes scheduling atomically. Old attempts and results remain readable; no BUILD or replacement YAML is needed.
- **Cancelled workflow**: recovery additionally requires `resume_cancelled: true`, reflecting an explicit request to resume cancelled work. Completed and archived workflows do not use this recovery action.
- **Change the work definition**: use existing `replan`/`extend` for a different graph. Recovery retries the stored definitions; it does not rewrite prompts, reset budgets, roll back code, or undo external actions.

An isolated failure often calls for targeted recovery rather than starting
over. Completed outputs may be reusable; check their validity before repeating
work. If the graph no longer helps, consider direct follow-up or a different
decomposition while preserving useful evidence and settling active children.

### Graph-action acceptance is not execution

`start`, `extend`, `control(replan)`, and `control(recover)` responses confirm that a graph was
**accepted**, not that its nodes **execute**. Acceptance-time validation checks
variable bindings, input-mapping structure, and condition syntax. Environment
validation also checks referenced prompt assets. It does not substitute real
upstream outputs or prove runtime values. Missing output fields, runtime
interpolation failures, or prompt assets changed after acceptance can still
fail a node at spawn. Report only the state actually observed. A wake or
`status` result can establish execution; an acceptance receipt alone cannot.
After a rejected call, decide whether to repair and retry or report a blocker.
Editing the spec alone does not apply a graph change, and repeating unchanged
invalid input does not constitute recovery.

## Model Assignment Strategy

Workflow YAML has no model-selection field. Resolution follows the `dag.jsonc`
tier, then the configured agent model, then the parent-session model. If all
three are absent, the workflow tool returns a blocked diagnostic and does not
create the workflow. Recovery does not grant permission to change models.

- Expensive models for planning, review, and arbitration — high-stakes decisions where reasoning quality matters.
- Fast models for mechanical implementation — well-specified edits where speed and cost matter.
- Diverse models in adversarial review — reduces single-model blind spots.

The two-tier defaults in `dag.jsonc` implement the split mechanically:
`required: true` nodes and `review`/`review-*` workers prefer the
`advanced` tier; every other node prefers `standard`. A single configured
tier serves both groups.

## Prompt Templates

Templates are read-only prompt fragments installed under project
`.opencode/dag-prompts/*.md` or global `<opencode config dir>/dag-prompts/*.md`.
Project assets shadow global assets. Prompt IDs have no bundled fallback;
bundled workflow YAML does not install these fragments. Confirm that a
referenced ID exists before using it. Missing assets are rejected during
environment validation. Supply required `{{variable}}` inputs through static
`prompt_template.input` or `input_mapping`; validation checks bindings, and
spawn resolves the actual values. The names below describe example assets
that require separate installation. Inspect each installed file for its
current input and output contract:

- `code-explore` (requires `target`): Search codebase structure, output file paths + responsibilities
- `test-explore` (requires `target`): Search test structure, output coverage gaps
- `config-explore` (requires `target`): Search config/deploy files, output config inventory
- `arch-gate`: Review architecture constraints and approve direction
- `implement` (requires `spec`): Implement per specification
- `verify`: Verify completeness and compatibility
- `plan`: Synthesize findings into a structured plan
- `review-arch`: Review from architecture perspective
- `review-logic`: Review from logic correctness perspective
- `review-style`: Review from code style perspective
- `patcher-assemble`: Assemble clean patch from completed work
- `integration-test`: Run integration tests and report

Dependency outputs not interpolated into a prompt are appended as structured context. For review prompts, request an `unverified_claims` section that a downstream verification wave can check against the actual code. Confirm that an installed template includes this requirement before relying on it.

For ad-hoc prompts, use `prompt_template: { inline: "...", input: {...} }`.
Static `prompt_template.input` supplies literal, local template values; it does
not read upstream node output. Inline templates interpolate those static values
and direct dependency variables. Use `input_mapping` when an upstream output
needs a stable variable name or field selection. When a mapped placeholder
contains an object or array, interpolation renders it as indented JSON; it must
never appear as `[object Object]`.

## Budget Declaration

The engine enforces declared budgets and does not adaptively increase them.
Defaults can be sufficient; adjust them when expected tool time, resource
limits, or evidence volume warrants it, rather than because a task is labelled
large. Higher concurrency is useful only for genuinely independent work:

- `max_concurrency`: default 5. Balance independent work against host and provider capacity.
- `max_node_replan_attempts`: default 5. Increase only if you expect iterative quality-driven convergence (review → revise → review cycles on a single artifact).
- `max_total_nodes`: default 100. Increase for large-scale decompositions.
- `worker_config.timeout_ms`: default 10 minutes. Increase for long-running nodes (compilation, large test suites). Verifier and aggregator nodes are the most common timeout victims: a node that consumes several parallel reports and re-checks their claims against code runs sequentially and routinely needs 20–30 minutes (e.g. `timeout_ms: 1800000`) — declaring the fan-out lanes' budget for the fan-in lane is a recurring failure pattern.

## Single-Workspace Discipline

All nodes share the same workspace. Write conflicts are an orchestration concern, not an infrastructure one. Two tiers:

**Tier A — Disjoint write sets**: parallel nodes that write to non-overlapping files/paths can run concurrently without coordination. Structure the decomposition so each node owns a distinct module or file set.

**Tier B — Propose-then-assemble**: when disjoint write sets cannot be guaranteed, parallel nodes should only produce proposals (structured output via `output_schema` and the workflow's `result_protocol`), not directly write files. A single assembly node then applies the changes sequentially. The review point converges on the assembly node's diff, not on scattered parallel edits.

## Design Principles

- Each node is a real child session with its own message history, tools, and context window. There is no shared memory between nodes — data flows only through `depends_on` and `input_mapping`.
- `required: true` means failure fails the entire workflow (terminal status `failed`, attributed to the node ids; `cancelled` is reserved for explicit cancels). Use it for nodes whose output is indispensable (gates, core implementation). Omit it for nodes whose failure is recoverable.
- A successful fan-in node must actually contain the requested comparison,
  synthesis, or final decision. Unresolved placeholders, missing dependency
  outputs, or a claim that inputs were aggregated are not successful
  aggregation.
- Layers are computed automatically from `depends_on`. Nodes in the same layer execute concurrently up to `max_concurrency`. Do not try to control execution order beyond declaring dependencies.
- Newly created workflows default to `result_protocol: final_response`. With this protocol, a node that declares `output_schema` must end with exactly one JSON value matching the schema, without Markdown fences or surrounding prose. The runtime validates and captures that final answer; the child must not send the same result through `agent.send`. A node without `output_schema` returns its complete final answer as plain text. Use `agent.send` for questions, decisions, and collaboration.
- Existing persisted workflows that omit `result_protocol` retain the legacy `submit_result` protocol. Under that protocol, a node with `output_schema` must call `submit_result`; ending without a successful submission fails the node (`verdict_fail`). Set `result_protocol: submit_result` explicitly when a newly authored workflow needs this legacy behavior.
- A completed workflow delivers its selected result directly to the parent assistant message once; the parent should not generate a second summary of that result. Set `delivery_node` to choose the result node. In composable-block workflows, the sole leaf `synthesize` block is selected automatically. If no unique delivery node is specified, the parent receives a deterministic index of the available results. Result delivery does not change scheduling, pause, failure, timeout, or actionable-wake behavior.

## Tool Reference

### Actions

**start** — Create a workflow from `config` and optional `title`, `mode`, and
admission input stored in YAML. Pass a task-local YAML path for one-off work or
a saved workflow name returned by `list`, such as
`{ action: "start", spec_path: "<name-returned-by-list>" }`.
Returns the workflow ID. Nodes declare `depends_on` (node IDs); layers and
execution order are computed automatically.

**list** — Show saved workflow specs in project, global, and builtin scopes
with names, titles, bounded objectives, block or node counts, paths, and
validation status. This lists reusable specs, not running workflows; use
`status` for a workflow's live state.

**read** — Return one saved workflow as structured JSON without starting it.
Pass `spec_path`, then retarget generic objectives and block instructions in
the parent, write the edited result to YAML, and start that file by path.

**draft** — Render a structured graph `config` (same fields as the start
file's `config`) into a validated YAML spec and return its `spec_path`; no
workflow is created. Preferred over hand-writing YAML: the parameter schema
rejects unknown fields, eliminating serialization drift. When validation fails
the file is still on disk — fix it by calling draft again with corrected
fields, then start the returned `spec_path`.

**guide** — Load on-demand authoring guidance. `topic` is one of `blocks`
(composable block schema), `interface` (low-level node fields), `policy`
(gates, admission, recovery), or `patterns` (cross-domain playbooks); omit it
for the compact index. Load only the topic needed for the current decision.

**validate** — Pre-flight a start file without creating a workflow. Pass
`spec_path` and an optional `profile` (`portable` for distributable-template
checks, `environment` to additionally resolve prompts, workers, and models in
this project; builtin specs default to portable, everything else to
environment). Extend and replan files are validated by their respective
mutation actions, not by this start-only preflight. Returns diagnostics with
per-error paths, never a workflow ID.

**extend** — Add nodes to a running workflow. Existing nodes are unaffected;
new nodes are immediately eligible for scheduling if their dependencies are
met. It also accepts a genuinely additive wave after a reporting leaf
checkpoint naturally completed the current graph; an early
`control(complete)` workflow remains terminal. Put the new nodes under `nodes`
in a YAML file, then call
`{ action: "extend", workflow_id: "dag_...", spec_path: "extend.yaml" }`.

**status** — Read durable state for one workflow and all its nodes. Pass `workflow_id`. Use it when the user asks for current state, or once before a decision that needs fresh state, such as replan or control. Do not poll just to wait; node reports and terminal outcomes wake the parent automatically.

**result** — Read one node's complete durable output in bounded pages. Pass
`workflow_id` and `node_id`; when the response is truncated, pass its
`next_cursor` unchanged until no cursor remains. Wake messages contain only a
bounded preview plus the exact workflow/node reference, so use `result` before
verifying or synthesizing any output marked `truncated=true`. Never infer the
omitted content from its preview.

**control** — Control a running workflow:

- `pause` — Let running nodes finish and stop spawning new ones. Pause does not stop nodes already running. For a live graph, pause before composing a replan to prevent scheduling races. For explicit cancellation, use `cancel` directly.
- `resume` — Resume scheduling. A successful replan or extend auto-resumes a paused workflow. Resume manually only if its output says automatic resume raced with another control operation and the workflow is still paused.
- `cancel` — cancel the entire workflow
- `recover` — Retry selected `node_ids` and their downstream closure under the same workflow ID. Pass `expected_graph_rev` from `status`. The action is rejected for stale revisions, unavailable reusable artifacts, or exhausted attempt/node budgets. Pause a live workflow first. Cancellation requires `resume_cancelled: true`. The response lists old-to-new attempt IDs and reused/preserved/superseded sets. Unrelated pending work stays unchanged; rows the workflow termination itself skipped or aborted (`workflow_failed` / `workflow_cancelled`) get new attempts automatically.
- `replan` — Put `fragment: { ... }` with graph fields and node definitions in YAML, then pass `spec_path`. Set `restart: true` or `cancel: true` for running nodes. Pending nodes missing from the fragment are cancelled. Replan is valid while paused. Safest order: pause, write the file, then replan. Success resumes the workflow automatically. Resume manually only if output says automatic resume raced with another control operation and the workflow is still paused. A validation rejection does not itself fail or cancel the workflow. The tool attempts to park it paused; inspect the reported actual state. If it is paused, fix the field named by the diagnostic and replan. If automatic pause failed and it is still running, explicitly pause or settle it before ending the turn. For terminal or unknown state, inspect status and use the applicable recovery path. Do not cancel the whole graph merely because validation rejected a fragment.
- `extend_timeout` — Give a RUNNING node with a pending formal timeout escalation already delivered to the parent more time without a replan. Pass `node_id` and a fresh `timeout_ms`; the new deadline starts now. The node keeps its child session and attempt. No replan is consumed and the graph is unchanged. The deadline watcher updates to the new deadline. The action is refused without a pending formal escalation (`no_escalation`) or before its wake is delivered (`escalation_undelivered`). An elapsed deadline alone does not authorize an extension. Prefer this over replan for timeout escalation. Use replan only if the graph must also change.
- `complete` — early-complete: remaining pending nodes are skipped (non-violation)
- `step` — Advance exactly one ready node, selected by lexicographic node ID, then wait. Use it for controlled debugging or staged verification of a critical path. Unlike `pause`, it advances one node and waits again. A second `step` is rejected while that node is running. Use `resume` to restore full-speed scheduling. Lexicographic selection keeps the order deterministic.

### Workflow result delivery

| Field | Required | Description |
| ----- | -------- | ----------- |
| `result_protocol` | no | `final_response` by default for newly created workflows. With `output_schema`, the node's final assistant answer must be one JSON value matching the schema; without a schema, the complete final answer is captured as text. Historical workflows without this field keep `submit_result` behavior. |
| `delivery_node` | no | Node whose completed output is copied once into the parent assistant message. A composable-block workflow with exactly one leaf `synthesize` block selects it automatically. When no unique delivery node is configured, completion provides a deterministic index of available results. |

With `final_response`, the child must not report its final result again through `agent.send`. Use `agent.send` for clarification, decisions, and collaboration. A failed, paused, timed-out, or otherwise actionable workflow still follows its normal wake and control path.

### Node Fields

| Field              | Required | Description                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`               | yes      | Unique node identifier, used in `depends_on`                                                                                                                                                                                                                                                                                                                                                                                                             |
| `name`             | yes      | Human-readable name                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `worker_type`      | yes      | Agent type (`explore`, `build`, `general`, `plan`, or custom)                                                                                                                                                                                                                                                                                                                                                                                            |
| `depends_on`       | yes      | Array of node IDs this node waits for (`[]` for root)                                                                                                                                                                                                                                                                                                                                                                                                    |
| `required`         | no       | If true and this node fails, the workflow terminalizes as failed. Default: false                                                                                                                                                                                                                                                                                                                                                                         |
| `prompt_template`  | yes      | `{ id: "..." }` or `{ inline: "...", input: {...} }`                                                                                                                                                                                                                                                                                                                                                                                                     |
| `condition`        | no       | One comparison `<dep-id>.output.<field> <op> <value>` over a direct dependency, evaluated before spawn; node is skipped if false. `op` is `==`, `!=`, `>`, `<`, `>=` or `<=`; `value` is a number, `true`/`false`/`null`, a bare word, or a quoted string. Acceptance rejects other syntax (`===`, `!==`, `&&`, `\|\|`)                                                                                                                                  |
| `input_mapping`    | no       | Map upstream node outputs into template variables                                                                                                                                                                                                                                                                                                                                                                                                        |
| `report_to_parent` | no       | If true, the parent agent is woken when this node completes or fails. The workflow's terminal status always wakes the parent regardless of this flag                                                                                                                                                                                                                                                                                                     |
| `worker_config`    | no       | `{ timeout_ms }` — bounds the node from admission to completion (defaults to 10 minutes if omitted); queue wait counts toward the budget, an expired queued node fails without spawning, and a running node that exceeds it escalates to the parent for adjudication (capped deadline extensions) before failing                                                                                                                                         |
| `output_schema`    | no       | JSON Schema for the node result. Under `final_response`, the complete final answer must be exactly one JSON value matching the schema. Under legacy `submit_result`, the child must submit the value through that tool or the node fails                                                                                                                                                                                                                      |
| `restart`          | no       | (replan only) Re-spawn this running node with new prompt                                                                                                                                                                                                                                                                                                                                                                                                 |
| `cancel`           | no       | (replan only) Cancel this node                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `review`           | no       | (deep review workers) `{ phase: "design" \| "diff" }`; a `diff` review must also declare `implementation_node_id` / `verification_node_id` and wire them: transitive review→verification→implementation dependencies, `input_mapping` for the diff artifact + fingerprint + verification output, a PASS-gated `condition`, and a `verdict`+`implementation_fingerprint` `output_schema`. Authoring rejects violations in deep mode and warns in standard |

### What NOT to expect

- No `node_complete` action — completion is automatic
- No `history` action — inspect a known workflow with `status`; browsing running workflows remains TUI-only (`list` shows saved specs, not running workflows)
- No runtime-side magical topology selection — the routing command (`/dag-auto`) selects and adapts saved reference graphs in the parent agent; the workflow runtime executes the resulting validated spec
