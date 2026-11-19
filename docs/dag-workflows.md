# DAG workflows

A workflow is a set of nodes connected by dependency edges. Each node is a real child session with its own agent and context window; an edge means the downstream node consumes the upstream node's output. Nodes run wave by wave in dependency order, so independent work executes in parallel and dependent work waits.

The parent agent (your main conversation) owns the graph. It designs the graph for a task, starts it, and gets woken when a node reports or the workflow finishes — it never polls. When a wave fails, the parent requests recovery of the affected nodes and the engine continues in the same workflow; the view always shows the current graph, not the history of rewrites (more on this under [Revisions](#revisions)).

Three terms worth knowing:

- **Node** — one unit of work: an `explore`, `build`, `general`, or custom agent running one prompt, with optional timeout, retry budget, and structured-output contract.
- **Wave** — the set of nodes whose dependencies are all satisfied; a wave runs in parallel up to a concurrency limit.
- **Gate** — a node whose job is judgment (review, verification, arbitration). Gates emit verdicts (`ACCEPT` / `REVISE` / `REJECT` / `BLOCKED`) and downstream nodes can be conditioned on the verdict.

## DAG features

**Orchestration**

- Composable blocks (`explore`, `plan`, `prototype`, `debug`, `coding`, `verify`, `review`, `synthesize`) compile into the node graph; low-level node fields remain available for anything blocks cannot express.
- `workflow(action="draft")` renders a structured graph through the tool schema into a validated YAML spec — field-name mistakes are rejected by the provider, not discovered at validation time.
- Saved workflow libraries at three scopes (project / global / builtin), startable by name; the `/dag-auto` command (backed by the non-hidden `dag-auto` built-in skill) routes a requirement to a curated reference topology and retargets it to the task at hand. Five hidden `dag-*` reference skills — `dag-blocks`, `dag-nodes`, `dag-recovery`, `dag-patterns`, and `dag-policy` — carry the authoring, recovery, pattern, and policy contracts and load on demand.
- The agent promotes to a workflow on its own judgment — the user need not ask — and declares the graph structure up front, mutating it at runtime only for structure that depends on results. When later work depends on items a node produces (for example one verifier per finding), the parent turns that node into a checkpoint, deduplicates and ranks the reported items, and adds only the needed item nodes with a bounded `extend`; `fan_out` is for writers from a plan's `packages`, not general per-item expansion.
- Model tiers in `dag.model` follow the node's role, not its `required` flag: planning, verification, synthesis, review and composer nodes run on the `advanced` model; writers (fan-out packages included), exploration and compose-expansion children on `standard`.

**Reliability**

- Event-sourced state with a declared state machine; the SQLite read model is projected inside the publish transaction. Crash recovery reconciles from durable evidence and never fabricates provider work.
- Execution-location authority: each workflow row carries the directory stamp of the session that created it, re-read from the database on every ownership check, so sibling worktrees of one project cannot act on each other's workflows. Stamps move with the session when it moves.
- Revision view: a replan supersedes the replaced segment — the inspector, status output, and summary counts render the current graph only. Live failures on the current graph (quota exhausted, API error, timeout cap) stay visible; superseded ones do not count toward the workflow's terminal state.
- Node outputs that are a single absolute file path are captured as `{content_ref, size, sha256, summary}`; the result action returns the pointer and the parent reads the file. Inline and structured payloads unchanged.

**Observability & control**

- TUI DAG inspector (`dag.open` in the command palette): workflow list, wave-ordered node view with live status, node detail with deadline countdown; `p`/`r`/`s`/`x` for pause/resume/step/cancel, `enter` drops into a node's child session.
- Sidebar panel with per-session progress; HTTP API mirroring every tool action (see [below](#observing)).
- Deep mode admission: a bounded Q&A pass (1/3/5 rounds) produces a fingerprinted Requirement Brief with a `READY` / `NOT_READY` / `WAIVED` verdict before an expensive graph starts.

**Messaging**

- The main agent can observe nodes of its own workflows and exchange messages with an exact current node attempt. Sending is non-blocking; messages provide context and never grant authorization or change workflow lifecycle.

## Using workflows

Nothing has to be configured to try it: ask for work that has stages, parallel
parts, or a review gate in the middle (`/dag-auto <task>`, which loads the
`dag-auto` skill), and the agent designs a graph and runs it. Three things turn
that into a repeatable setup of your own.

### 1. Choose the model tiers — `dag.model` in `.agents/settings.json`

Nodes never name their own model. A node's role decides _which tier_ it runs on
and configuration decides _which model_ each tier is:

```jsonc
{
  "dag": {
    // advanced: plan, verify, synthesize and review blocks, review/arbiter workers,
    // composers; a hand-written node without a block takes it when required: true.
    // standard: writers, exploration and the children of a compose expansion.
    "model": {
      "advanced": "anthropic/claude-sonnet-4-5",
      "standard": "anthropic/claude-haiku-4-5"
    },
    // Reasoning variant for DAG child sessions, when the model defines one.
    "thinking_depth": "medium"
  }
}
```

A project `.agents/settings.json` overrides the user-level
`graphagent.json`/`graphagent.jsonc` in the config dir, field by field; the
rest of the `dag` section (`mode`, `concurrency`, budgets, safety rules) stays
user-level policy. With only one tier configured, it serves as the unified
default. Resolution order per node is
tier → worker agent model → parent session model; when none of them yields a
model, the workflow is not created and you are asked to configure one.

### 2. Save the workflows you rerun — `.agents/workflows/`

A workflow spec is a YAML file describing the graph. Put it in a workflow
directory and it gains a **name**:

| Scope   | Path                                          | Availability                                                          |
| ------- | --------------------------------------------- | --------------------------------------------------------------------- |
| Project | `.agents/workflows/<name>.yaml`               | This repo, committed with it — the whole team gets the same procedure |
| Global  | `<config dir>/workflows/<name>.yaml`          | Every project on the machine                                          |
| Builtin | Compiled into the binary                      | Every install — stage specs always, curated templates in releases     |

Resolution takes the first match in that order, so a project file shadows a
global one with the same name, and both shadow the builtin tier. The builtin
tier always holds four stage specs for DAG mode — `stage-understand`,
`stage-design`, `stage-implement`, and `stage-review`; each declares template
inputs (see below), so a stage starts from the request alone. A curated template
with the same name replaces a stage spec. The global
scope is maintained by the [`opencode-dag-config`](https://github.com/LeXwDeX/opencode-dag-config)
repository (sync it with a plain `git clone`/`git pull` into your config
dir). A minimal spec:

```yaml
title: Dependency audit
config:
  name: dependency-audit
  objective: Flag outdated or duplicated dependencies and propose an upgrade order.
  blocks:
    - id: inventory
      kind: explore
      instruction: Inventory the package.json files and lockfiles with their dependency versions.
    - id: report
      kind: synthesize
      depends_on: [inventory]
      instruction: Flag outdated or duplicated dependencies and propose an upgrade order.
```

Then just say "run the dependency-audit workflow" — the agent starts it by
name, no path needed. Ad-hoc specs still work exactly as before: a `spec_path`
that looks like a path (has a separator or a `.yaml`/`.yml` extension) is read
relative to the session directory instead of the library.

With DAG mode on, every start runs under the strict review gate, whatever the
spec declares, and `spec validate`, `read`, `list` and `draft` judge a spec
under that same gate. The spec above is valid under both gates. Under strict, a
spec written as `nodes` may only use read-only workers (`explore`, `plan`,
`auditor`, ...); a writer is a `coding` or `prototype` block followed by a
`verify` block, a `review` block whose `lenses` include `completeness`, and a
`synthesize` block that depends on the review, with `config.acceptance` listing
what the completeness lane judges.

#### Template inputs

A spec can declare `inputs` and refer to them as `{{name}}`, so the agent fills
in a few values instead of copying and rewriting the file. `workflow(action="spec",
operation="list")` shows each template's inputs (`*` marks a required one), and
the agent starts it with `workflow(action="run", operation="start", spec_path,
inputs)`:

```yaml
inputs:
  objective: {}                      # no default: required
  paths: { type: array, default: [src] }
config:
  name: dependency-audit
  objective: "Audit dependencies. Request: {{objective}}"
  blocks:
    - id: inventory
      kind: explore
      instruction: "Inventory the manifests under {{paths}}"
```

An input is a `string` (the default type), `number`, `boolean`, or `array`; one
without a `default` is required. Substitution replaces only declared names, so
the `{{node-id}}` bindings in node prompts keep working. A field that is exactly
one placeholder takes the input's own type (for example `acceptance:
"{{acceptance}}"` receives an array); inside longer text a value is rendered as
plain text. `spec validate` accepts the same `inputs` and reports what a start
would reject.

### 3. Let the agent author it

For one-off graphs, `workflow(action="draft")` takes the structured graph as
tool parameters and hands back a validated `spec_path`, so field drift never
reaches the file.

Node prompts referenced by `prompt_template.id` resolve from the project's
`.agents/workflows/prompts/<id>.md`, then the global
`<config dir>/workflows/prompts/`. Add your own `.md` file there to make a new
template available; a global workflow should prefer `inline` prompts so it does
not depend on a repo-local template.

## The engine

The engine lives in [`packages/core/src/dag`](../packages/core/src/dag) (state machine, dependency graph, scheduling, event projection, SQLite read model) and [`packages/graphagent/src/dag`](../packages/graphagent/src/dag) (workflow service, execution loop, node spawn, admission, review lifecycle, crash recovery, templates). Agents drive it through a single `workflow` tool; humans watch and control it through the TUI or HTTP API.

### Graph definition

Each node declares:

| Field              | Purpose                                                                                             |
| ------------------ | --------------------------------------------------------------------------------------------------- |
| `depends_on`       | Dependency edges; cycle detection and dangling-reference validation at creation                     |
| `worker_type`      | Which agent runs the node (`explore`, `build`, `general`, or any configured agent)                  |
| `prompt_template`  | Prompt by `id` (from project, then global `.agents/workflows/prompts/`) or `inline`, with `{{var}}` interpolation |
| `input_mapping`    | Map upstream node outputs into template variables (`"count": "node-b.output.count"`)                |
| `condition`        | Expression over upstream outputs; false → node skipped, pure descendants cascade-skip               |
| `output_schema`    | JSON Schema; the child agent's final answer must be exactly one JSON value matching it              |
| `required`         | Failure of a required node fails the workflow                                                       |
| `report_to_parent` | Wake the parent agent when this node reaches a terminal state; with DAG mode off, a delivery leaf's report is only displayed |
| `review`           | `design` or `diff` review phase with an implementation-fingerprint contract (below)                 |

Workflow-level knobs: `max_concurrency` (default 5), `max_node_replan_attempts` (5), `max_total_nodes` (the lower of the workflow's declaration and the user's global `dag.max_total_nodes`, default 100), per-node `timeout_ms` (default 10 min, counted from permit acquisition; time spent queued does not count and a queued node never times out).

### Scheduling & execution

- Nodes spawn as real child sessions through the same code path as the `task` tool, wave by wave in dependency order, bounded by a concurrency semaphore. A node is durably `queued` at admission and the child session only materializes inside the permit, so a 100-node fan-out never creates 100 sessions at once.
- Dynamic replanning, pause-first: `pause` freezes scheduling, `replan` merges a fragment atomically, and `resume` continues. `control(recover)` replaces selected nodes and their downstream attempts in the same failed or paused workflow, using `expected_graph_rev` to reject stale requests. Old attempts remain immutable. Cancelled workflows require explicit resume intent. `extend` appends nodes and may reopen a naturally completed workflow at a reporting checkpoint.
- Step mode runs one node at a time for debugging.
- The parent does not poll. Synthetic messages wake it when a `report_to_parent` node or the workflow terminalizes. With DAG mode on, every completed workflow is followed by one turn after its delivered report; with it off, a workflow that completes through its delivery leaf alone only displays that report. Checkpoint nodes emit a normalized verdict (`ACCEPT` / `REVISE` / `REJECT` / `BLOCKED`), and the disposal contract governs what happens next. Iteration is a bounded, verdict-driven replan wave; the graph never contains a cyclic edge.

### Revisions

Rewriting a graph does not erase history, but it does retire it. A replan that supersedes nodes marks them; the workflow row carries a `graph_rev` counter and every view — status output, HTTP API, TUI inspector, summary counts — filters to the current revision. Unrelated completed nodes and valid outputs survive into the new revision untouched; recovery replaces the selected nodes and their downstream closure. Audit of superseded nodes stays possible through the result store (an agent can look it up by node id); the TUI exposes no entry to it.

Two things this fixes. A workflow whose failed segment was rewritten now reports `completed` when the replacement succeeds, instead of dragging the old failure along. And the failure counts you see are the failures that exist — a quota exhaustion or API error on the current graph stays visible until it is actually fixed.

### State machine & persistence

- Declared transition tables for workflow and node status; every mutation goes through a guard, invalid transitions and terminal violations are typed errors (HTTP 409, not 500).
- All changes are published as durable `dag.*` events; a projector writes the SQLite read model _inside_ the publish transaction. History is event replay, not a log table. A drift test fails whenever the projector's guards and the declared transition tables are edited out of sync.
- Crash recovery is lazy, per-workflow, and evidence-based: nodes left `running` are reconciled against their child session's durable state. Sessions that finished back-fill their captured output; when execution ownership was genuinely lost, the workflow pauses and the parent decides disposition (replan / resume / cancel). Recovery never adopts or restarts provider work on its own.
- Failure triage: every failed node carries a failure class (`timeout` / `exec_failed` / `verdict_fail`) surfaced in `workflow(action=status)` and in the parent's wake — including a failed-nodes attribution digest when a workflow terminalizes failed — so the parent agent can select the failed node for local recovery instead of rebuilding the graph.

### Node outputs

A node's final reply can be plain text, a structured payload (one final JSON value matching `output_schema`), or a file. For a node without an output schema, a final reply containing one absolute path to a non-empty file (up to 64 MiB) commits a managed copy under application data. Its receipt records the digest, size, short summary and execution provenance. Downstream nodes receive a path and read the body as needed; deleting the source working tree does not delete the managed result. Result reads, downstream execution and local recovery verify managed object integrity before reuse. Legacy receipts remain compatible. See [file artifacts and recovery](./dag-file-artifacts-and-recovery.md) for the tool calls and limits.

### Deep mode: admission & review

- Admission Q&A covers six dimensions (goal, scope, constraints/assumptions, acceptance criteria, evidence, risks) under a bounded policy: `LIGHT` (1 round), `STANDARD` (3), `GRILL` (5, adversarial). The resulting Requirement Brief is fingerprinted (SHA-256 over a canonical form); material changes invalidate the fingerprint and return admission to questioning. A consumed record is persisted with the workflow and never replayed.
- Review nodes declare their phase honestly: `design` reviews pre-implementation artifacts; `diff` reviews the actual implementation and requires the implementation node, a passing verification node, and a fingerprint echo. Changing the implementation changes the fingerprint, so a stale `ACCEPT` cannot satisfy the gate.

### Observing

- TUI DAG inspector (command palette → `dag.open`): workflow list, wave-ordered node view with live status, node detail (deps, errors, output preview, deadline countdown); `enter` drops into a node's child session. Workflow control goes through the `workflow` tool, not the inspector.
- Sidebar panel: per-session workflow progress (completed/running/failed/queued), expandable node list, driven by ephemeral summary events, with a fetch-on-open safety net instead of polling.
- HTTP API (read-only queries; mutations go through the `workflow` tool):

  ```
  GET  /dag                              list workflows
  GET  /dag/session/:sessionID           workflows for a session
  GET  /dag/session/:sessionID/summary   progress summaries
  GET  /dag/:dagID/nodes                 node list
  ```

  There is deliberately no per-workflow or per-node detail endpoint: read
  workflow status from the session-scoped list and node state from the node
  list; mutations go through the `workflow` tool.

### Project configuration files

Everything DAG-specific lives under `.agents/`, with a global counterpart in
the config dir (`GRAPHAGENT_CONFIG_DIR`, else `~/.config/graphagent`).
Everything else inherits the main GraphAgent configuration.

| Path                                | Purpose                                                                       | User-level counterpart                                             |
| ----------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `.agents/settings.json` `dag.model` | Model tiers (`advanced` / `standard`) and `thinking_depth` for child sessions | `graphagent.json(c)` `dag`, overridden by the project              |
| `.agents/workflows/*.yaml`          | Saved workflow specs, startable by name                                       | `<config dir>/workflows/*.yaml`                                    |
| `.agents/workflows/prompts/*.md`    | Node prompt templates referenced by `prompt_template.id` (project first)      | `<config dir>/workflows/prompts/*.md`                              |

Both the DAG settings and the workflow library are read lazily, so an edit applies to
the next workflow start without a restart.
