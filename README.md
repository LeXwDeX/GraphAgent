<p align="center">
  <a href="./README.md"><b>English</b></a> ·
  <a href="./README.zh.md">简体中文</a>
</p>

# GraphAgent

> An opencode fork for long, multi-step coding work: durable DAG workflows of child agents, reasoning shaping, project memory, autonomous goals, and Claude Code–compatible hooks — all inspectable and controllable from the terminal.

GraphAgent is the product name for this project; the repository is published as
**OpenCode-GraphAgent**, a fork of the MIT-licensed
[opencode](https://github.com/anomalyco/opencode) terminal AI agent that adds
the DAG workflow engine and the features listed below. **Not affiliated with or endorsed by the OpenCode
team.**

> [!IMPORTANT]
> **GraphAgent v1 is in focused maintenance.** Maintenance is limited to DAG
> configuration, curated workflow templates, and reproducible defects reported
> through [GitHub Issues](https://github.com/LeXwDeX/OpenCode-GraphAgent/issues).
> Architecture defects that affect stability, data integrity, or the core DAG
> experience will receive narrowly scoped compatibility patches; v1 will not
> take new platform features or large foundational refactors. A successor
> project will redesign the runtime independently, without extending v1's
> compatibility constraints.

---

## What GraphAgent adds

Everything below is developed in this fork on top of opencode. Each feature is opt-in or self-contained; the rest of
opencode (providers, LSP, client/server, TUI/desktop/web clients) behaves as upstream.

| Feature | What it does | How to use it |
| --- | --- | --- |
| [Reasoning shaping](#reasoning-shaping) | Reorganizes each reasoning part with a small model before the model sees it again (on by default) | `reasoningDistillation.enabled` + `small_model` |
| [DAG workflows](#dag-workflows) | Decomposes a task into a durable dependency graph of child agents | `/dag-auto`, the `workflow` tool, `.opencode/dag.jsonc` |
| [Project Memory](#project-memory) | Keeps confirmed preferences, decisions and terminology per project | `/memory on` |
| [Autonomous goals](#autonomous-goals-goal) | Works one durable, budgeted goal across turns, judged externally | `/goal`, `/subgoal` |
| [Hooks](#hooks) | Claude Code–compatible lifecycle hooks | `hooks.json`, `/create-hook`, `/import-claude-hooks` |
| [Context management](#context-management) | Folds duplicate tool output, bounds tool use, compacts long sessions | `compaction`, `maxToolCalls` |

---

## Reasoning shaping

Thinking models send their earlier reasoning back to the provider on later steps. Long reasoning is full of restated
requests, abandoned guesses and correction narrative, and every later request pays for it again.

Reasoning shaping is on by default. Each reasoning part is handed to the small model **as soon as it ends**: the
configured `small_model`, otherwise the provider's own small model; with neither, nothing is rewritten. The organizer
keeps final facts, values, calculations, constraints, real execution results and open items, plus the working state the
reasoning built: excluded hypotheses with their evidence, checked locations with their results (including "nothing
found") and confirmed references. It removes duplicates, refuted guesses and filler; paths, commands, code, URLs,
configuration keys and numbers stay verbatim. The rewrite runs while the step's tools execute, and the next request
carries it.

- **Rewrite before first resend, or never.** Before every provider request, the session waits for unfinished rewrites
  up to a short window (`OPENCODE_REASONING_DISTILLATION_SETTLE_MS`, default 3000 ms). Anything not ready is sealed and
  keeps its original text for good, so provider prompt-cache prefixes from earlier requests are never invalidated.
- **Only safe carriers.** Plain reasoning and plaintext mirrors are rewritten. Signed, encrypted or referenced reasoning
  (Anthropic thinking signatures, OpenAI encrypted reasoning, Gemini thought signatures) is never touched.
- **Reversible.** The original text and metadata are stored with the part; turning the feature off replays originals.
- **Engine-level.** The organizer call goes through the built-in `@opencode-ai/llm` engine with no tools, no retries and
  `none`/`low` reasoning effort; a rewrite is adopted only if it is actually smaller.

```jsonc
// opencode.json
{
  "small_model": "provider/small-model", // prefer one with a `none` reasoning variant
  "reasoningDistillation": {
    "enabled": true, // default; false turns it off
    "language": "zh", // organizer prose language: "zh" (default) or "en"
  },
}
```

`OPENCODE_DISABLE_REASONING_DISTILLATION=1` turns it off regardless of configuration;
`OPENCODE_REASONING_DISTILLATION_AUX_TIMEOUT_MS` bounds each organizer call. Logs report every rewrite
(`reasoning distillation`) and every sealed barrier (`reasoning rewrite sealed`).

---

## Project Memory

Project Memory keeps durable, **user-confirmed** context for a project: preferences, decisions and terminology.

- `/memory on` / `/memory off` control it. The project needs a real identity first (run `/init`); Memory stays inert
  for uninitialized projects.
- One Memory per project, shared by all of its worktrees. It never forks per worktree, and it moves with the project
  when the repository gains its first remote.
- The main session injects relevant Memory into context; `memory_search` retrieves topics on demand.
- The controller owns persistence, limits and migration; models only propose bounded changes. Memory is not a code
  index and never an instruction source: current user input and higher-priority instructions always win.
- Policy lives in `.opencode/memory.jsonc`.

---

## Autonomous goals (`/goal`)

The goal loop works one durable goal autonomously across turns of the current session; graph orchestration (below) is
its multi-session counterpart.

- Commands: `/goal <text>` sets a goal and starts the loop; `/goal status|pause|resume|done|clear|stop` controls it;
  `/subgoal <text>|list|remove <n>|clear` manages subgoals attached to the active goal.
- Budget: `/goal --max-turns 30 <text>` sets a positive integer total budget (default 20). `/goal resume --max-turns 50`
  changes the total budget without resetting used turns; the new total must exceed used turns. Plain `/goal resume`
  retains the budget and permits one more execution when exhausted.
- Judge loop: after each turn an external judge evaluates progress — `done` clears the goal, `continue` injects the next
  continuation turn against the turn budget (exhaustion pauses the goal; it stays resumable). The agent can
  self-declare completion with `goal(action: "complete")`; `goal(action: "status")` inspects state.
- Visibility: while a goal is active or paused, the system prompt carries a live goal block; the TUI sidebar shows a
  compact goal widget; `GET /session/:sessionID/goal` exposes the state (`404` when no goal is set).
- Durability: goal state is persisted per session, survives restarts, and is cleared when the session is deleted. Only
  the main conversation can create or resume a goal.

---

## Hooks

Lifecycle hooks compatible with the Claude Code hooks protocol: 26 events (`PreToolUse`, `PostToolUse`,
`SessionStart`, `PermissionRequest`, `WorktreeCreate`, …) × 5 execution types (`command`, `mcp`, `http`, `prompt`,
`agent`).

- `hooks.json` is read from the global opencode config directory and from project/worktree `.opencode` directories,
  merged by appending and hot-reloaded; hooks can also be registered per session over HTTP, with optional workspace-trust
  gating.
- Command hooks can declare `inputFormat: "claude-code"` to receive Claude Code tool names and input keys. This gives
  naming compatibility, not full behavioral parity.
- Claude `.claude/settings*.json` files are not loaded automatically: `/import-claude-hooks` migrates them, and
  `/create-hook` walks through authoring a new hook.
- Reference: [hooks guide](./packages/core/src/plugin/skill/configure-hooks.md).

---

## Context management

- **Context folding**: repeated tool outputs are folded in the outbound request while the stored history stays
  canonical (`compaction.dynamic`, `compaction.prune`; `OPENCODE_DISABLE_PRUNE=1` disables pruning).
- **Bounded tool use**: tool output is size-bounded, and `maxToolCalls` caps tool calls per user input.
- **Compaction**: automatic summarization of long sessions (`compaction.auto`, `compaction.keep.tokens`,
  `compaction.buffer`, `compaction.max_context_tokens`).

Which of these apply depends on configuration, provider support and request purpose.

---

## DAG workflows

A workflow is a set of nodes connected by dependency edges. Each node is a real child session with its own agent and context window; an edge means the downstream node consumes the upstream node's output. Nodes run wave by wave in dependency order, so independent work executes in parallel and dependent work waits.

The parent agent (your main conversation) owns the graph. It designs the graph for a task, starts it, and gets woken when a node reports or the workflow finishes — it never polls. When a wave fails, the parent requests recovery of the affected nodes and the engine continues in the same workflow; the view always shows the current graph, not the history of rewrites (more on this under [Revisions](#revisions)).

Three terms worth knowing:

- **Node** — one unit of work: an `explore`, `build`, `general`, or custom agent running one prompt, with optional timeout, retry budget, and structured-output contract.
- **Wave** — the set of nodes whose dependencies are all satisfied; a wave runs in parallel up to a concurrency limit.
- **Gate** — a node whose job is judgment (review, verification, arbitration). Gates emit verdicts (`ACCEPT` / `REVISE` / `REJECT` / `BLOCKED`) and downstream nodes can be conditioned on the verdict.

### DAG features

**Orchestration**

- Composable blocks (`explore`, `plan`, `prototype`, `debug`, `coding`, `verify`, `review`, `synthesize`) compile into the node graph; low-level node fields remain available for anything blocks cannot express.
- `workflow(action="draft")` renders a structured graph through the tool schema into a validated YAML spec — field-name mistakes are rejected by the provider, not discovered at validation time.
- Saved workflow libraries at three scopes (project / global / builtin), startable by name; the `/dag-auto` command routes a requirement to a curated reference topology and retargets it to the task at hand.
- Model tiers in `dag.jsonc` separate decisions from volume: critical nodes on the `advanced` model, fan-out work on `standard`.

**Reliability**

- Event-sourced state with a declared state machine; the SQLite read model is projected inside the publish transaction. Crash recovery reconciles from durable evidence and never fabricates provider work.
- Execution-location authority: each workflow row carries the directory stamp of the session that created it, re-read from the database on every ownership check, so sibling worktrees of one project cannot act on each other's workflows. Stamps move with the session when it moves.
- Revision view: a replan supersedes the replaced segment — the inspector, status output, and summary counts render the current graph only. Live failures on the current graph (quota exhausted, API error, timeout cap) stay visible; superseded ones do not count toward the workflow's terminal state.
- Node outputs that are a single absolute file path are captured as `{content_ref, size, sha256, summary}`; the result action returns the pointer and the parent reads the file. Inline and structured payloads unchanged.

**Observability & control**

- TUI DAG inspector (`dag.open` in the command palette): workflow list, wave-ordered node view with live status, node detail with deadline countdown; `p`/`r`/`s`/`x` for pause/resume/step/cancel, `enter` drops into a node's child session.
- Sidebar panel with per-session progress; HTTP API mirroring every tool action (see [below](#observing--controlling)).
- Deep mode admission: a bounded Q&A pass (1/3/5 rounds) produces a fingerprinted Requirement Brief with a `READY` / `NOT_READY` / `WAIVED` verdict before an expensive graph starts.

**Messaging**

- The main agent can observe nodes of its own workflows and exchange messages with an exact current node attempt. Sending is non-blocking; messages provide context and never grant authorization or change workflow lifecycle.

## Using workflows

Nothing has to be configured to try it: ask for work that has stages, parallel
parts, or a review gate in the middle (`/dag-auto <task>`), and the agent
designs a graph and runs it. Three things turn that into a repeatable setup of
your own.

### 1. Choose the model tiers — `.opencode/dag.jsonc`

Nodes never name their own model. The graph declares *which nodes are critical*
and configuration decides *what runs them*:

```jsonc
{
  // Critical nodes: required: true, plus review/arbiter workers.
  "model": {
    "advanced": "anthropic/claude-sonnet-4-5",
    "standard": "anthropic/claude-haiku-4-5"
  },
  // Reasoning variant for DAG child sessions, when the model defines one.
  "thinking_depth": "medium"
}
```

A project `.opencode/dag.jsonc` overrides the global one in the opencode config
dir; a commented default is seeded there on first use. With only one tier
configured, it serves as the unified default. Resolution order per node is
tier → worker agent model → parent session model; when none of them yields a
model, the workflow is not created and you are asked to configure one.

### 2. Save the workflows you rerun — `.opencode/workflows/`

A workflow spec is a YAML file describing the graph. Put it in a workflow
directory and it gains a **name**:

| Scope | Path | Availability |
|---|---|---|
| Project | `.opencode/workflows/<name>.yaml` | This repo, committed with it — the whole team gets the same procedure |
| Global | `<opencode config dir>/workflows/<name>.yaml` | Every project on the machine |
| Builtin | Compiled into release binaries | Every release install — the last-resort tier |

Resolution takes the first match in that order, so a project file shadows a
global one with the same name, and both shadow the builtin tier. The global
scope is maintained by the [`opencode-dag-config`](https://github.com/LeXwDeX/opencode-dag-config)
repository (sync it with a plain `git clone`/`git pull` into your config
dir). A minimal spec:

```yaml
title: Dependency audit
config:
  name: dependency-audit
  nodes:
    - id: inventory
      name: inventory
      worker_type: explore
      depends_on: []
      required: true
      prompt_template:
        id: config-explore
        input:
          target: "package.json files and lockfiles"

    - id: report
      name: report
      worker_type: general
      depends_on: [inventory]
      report_to_parent: true
      prompt_template:
        inline: "Flag outdated or duplicated dependencies in {{inventory}} and propose an upgrade order."
```

Then just say "run the dependency-audit workflow" — the agent starts it by
name, no path needed. Ad-hoc specs still work exactly as before: a `spec_path`
that looks like a path (has a separator or a `.yaml`/`.yml` extension) is read
relative to the session directory instead of the library.

### 3. Let the agent author it

The built-in **`create-dag-workflow`** skill covers spec authoring: the library
scopes, the file shape, the rules a saved spec must respect (no pinned models,
`worker_type` must exist, required template variables must be supplied), and
how to verify it. Ask to "save this as a reusable workflow" and the agent
establishes the phases and gates with you, writes the file into the scope you
pick, and proves it by starting it once. For one-off graphs, `workflow(action="draft")`
takes the structured graph as tool parameters and hands back a validated
`spec_path`, so field drift never reaches the file.

Node prompts referenced by `prompt_template.id` resolve from the project's
`.opencode/dag-prompts/<id>.md`, then the global `<config dir>/dag-prompts/`.
Add your own `.md` file there to make a new template available; a global
workflow should prefer `inline` prompts so it does not depend on a repo-local
template.

## The engine

The engine lives in [`packages/core/src/dag`](./packages/core/src/dag) (state machine, dependency graph, scheduling, event projection, SQLite read model) and [`packages/opencode/src/dag`](./packages/opencode/src/dag) (workflow service, execution loop, node spawn, admission, review lifecycle, crash recovery, templates). Agents drive it through a single `workflow` tool; humans watch and control it through the TUI or HTTP API.

### Graph definition

Each node declares:

| Field | Purpose |
|---|---|
| `depends_on` | Dependency edges; cycle detection and dangling-reference validation at creation |
| `worker_type` | Which agent runs the node (`explore`, `build`, `general`, or any configured agent) |
| `prompt_template` | Prompt by `id` (from project, then global `dag-prompts/`) or `inline`, with `{{var}}` interpolation |
| `input_mapping` | Map upstream node outputs into template variables (`"count": "node-b.output.count"`) |
| `condition` | Expression over upstream outputs; false → node skipped, pure descendants cascade-skip |
| `output_schema` | JSON Schema; the child agent must call `submit_result` with a matching structured payload |
| `required` | Failure of a required node fails the workflow |
| `report_to_parent` | Wake the parent agent when this node reaches a terminal state |
| `review` | `design` or `diff` review phase with an implementation-fingerprint contract (below) |

Workflow-level knobs: `max_concurrency` (default 5), `max_node_replan_attempts` (5), `max_total_nodes` (100), per-node `timeout_ms` (default 10 min, queue wait counts toward the deadline).

### Scheduling & execution

- Nodes spawn as real child sessions through the same code path as the `task` tool, wave by wave in dependency order, bounded by a concurrency semaphore. A node is durably `queued` at admission and the child session only materializes inside the permit, so a 100-node fan-out never creates 100 sessions at once.
- Dynamic replanning, pause-first: `pause` freezes scheduling, `replan` merges a fragment atomically, and `resume` continues. `control(recover)` replaces selected nodes and their downstream attempts in the same failed or paused workflow, using `expected_graph_rev` to reject stale requests. Old attempts remain immutable. Cancelled workflows require explicit resume intent. `extend` appends nodes and may reopen a naturally completed workflow at a reporting checkpoint.
- Step mode runs one node at a time for debugging.
- The parent does not poll. Synthetic messages wake it when a `report_to_parent` node or the workflow terminalizes. Checkpoint nodes emit a normalized verdict (`ACCEPT` / `REVISE` / `REJECT` / `BLOCKED`), and the disposal contract governs what happens next. Iteration is a bounded, verdict-driven replan wave; the graph never contains a cyclic edge.

### Revisions

Rewriting a graph does not erase history, but it does retire it. A replan that supersedes nodes marks them; the workflow row carries a `graph_rev` counter and every view — status output, HTTP API, TUI inspector, summary counts — filters to the current revision. Unrelated completed nodes and valid outputs survive into the new revision untouched; recovery replaces the selected nodes and their downstream closure. Audit of superseded nodes stays possible through the result store (an agent can look it up by node id); the TUI exposes no entry to it.

Two things this fixes. A workflow whose failed segment was rewritten now reports `completed` when the replacement succeeds, instead of dragging the old failure along. And the failure counts you see are the failures that exist — a quota exhaustion or API error on the current graph stays visible until it is actually fixed.

### State machine & persistence

- Declared transition tables for workflow and node status; every mutation goes through a guard, invalid transitions and terminal violations are typed errors (HTTP 409, not 500).
- All changes are published as durable `dag.*` events; a projector writes the SQLite read model *inside* the publish transaction. History is event replay, not a log table. A drift test fails whenever the projector's guards and the declared transition tables are edited out of sync.
- Crash recovery is lazy, per-workflow, and evidence-based: nodes left `running` are reconciled against their child session's durable state. Sessions that finished back-fill their captured output; when execution ownership was genuinely lost, the workflow pauses and the parent decides disposition (replan / resume / cancel). Recovery never adopts or restarts provider work on its own.
- Failure triage: every failed node carries a failure class (`timeout` / `exec_failed` / `verdict_fail`) surfaced in `workflow(action=status)` and in the parent's wake — including a failed-nodes attribution digest when a workflow terminalizes failed — so the parent agent can select the failed node for local recovery instead of rebuilding the graph.

### Node outputs

A node's final reply can be plain text, a structured payload (`output_schema` + `submit_result`), or a file. For a node without an output schema, a final reply containing one absolute path to a non-empty file (up to 64 MiB) commits a managed copy under application data. Its receipt records the digest, size, short summary and execution provenance. Downstream nodes receive a path and read the body as needed; deleting the source working tree does not delete the managed result. Result reads, downstream execution and local recovery verify managed object integrity before reuse. Legacy receipts remain compatible. See [file artifacts and recovery](docs/dag-file-artifacts-and-recovery.md) for the tool calls and limits.

### Deep mode: admission & review

- Admission Q&A covers six dimensions (goal, scope, constraints/assumptions, acceptance criteria, evidence, risks) under a bounded policy: `LIGHT` (1 round), `STANDARD` (3), `GRILL` (5, adversarial). The resulting Requirement Brief is fingerprinted (SHA-256 over a canonical form); material changes invalidate the fingerprint and return admission to questioning. A consumed record is persisted with the workflow and never replayed.
- Review nodes declare their phase honestly: `design` reviews pre-implementation artifacts; `diff` reviews the actual implementation and requires the implementation node, a passing verification node, and a fingerprint echo. Changing the implementation changes the fingerprint, so a stale `ACCEPT` cannot satisfy the gate.

### Observing & controlling

- TUI DAG inspector (command palette → `dag.open`): workflow list, wave-ordered node view with live status, node detail (deps, errors, output preview, deadline countdown), and `p`/`r`/`s`/`x` for pause/resume/step/cancel; `enter` drops into a node's child session.
- Sidebar panel: per-session workflow progress (completed/running/failed/queued), expandable node list, driven by ephemeral summary events, with a fetch-on-open safety net instead of polling.
- HTTP API (same code path as the tool surface):

  ```
  GET  /dag                              list workflows
  POST /dag                              start a workflow
  GET  /dag/session/:sessionID           workflows for a session
  GET  /dag/session/:sessionID/summary   progress summaries
  GET  /dag/:dagID                       workflow detail
  GET  /dag/:dagID/nodes                 node list
  GET  /dag/:dagID/nodes/:nodeID         node detail
  POST /dag/:dagID/control               pause/resume/cancel/replan/extend/step/complete
  ```

### Project configuration files

Everything DAG-specific lives under `.opencode/`, with a global counterpart in
the opencode config dir (`OPENCODE_CONFIG_DIR`, else `~/.config/opencode`).
Everything else inherits the main opencode configuration.

| Path | Purpose | Global counterpart |
|---|---|---|
| `.opencode/dag.jsonc` | Model tiers (`advanced` / `standard`) and `thinking_depth` for child sessions | `<config dir>/dag.jsonc`, seeded with comments on first use |
| `.opencode/workflows/*.yaml` | Saved workflow specs, startable by name | `<config dir>/workflows/*.yaml` |
| `.opencode/dag-prompts/*.md` | Node prompt templates referenced by `prompt_template.id` (project first) | `<config dir>/dag-prompts/*.md` |
| `.opencode/workflow-reports/` | Node report files (auto-gitignored) | — |

Both `dag.jsonc` and the workflow library are read lazily, so an edit applies to
the next workflow start without a restart.

## Background

GraphAgent treats a graph as an executable, durable, inspectable contract — not a diagram of agents, and not a prompt chain with arrows added afterward. The first complete DAG-engine commit landed on **2026-07-02**; the paper [*What makes prompts a graph*](https://arxiv.org/abs/2607.27578), which formalized explicit structure, prompt/topology separation, executable semantics, and the graph as a first-class artifact, appeared on **2026-07-30**.

The operating doctrine that came out of it:

1. Edges must carry work. A dependency exists only when the downstream node consumes the upstream artifact; ceremonial sequencing gets deleted, independent work runs in parallel.
2. A template is a reference topology, not a cage. The parent agent may expand or prune lanes to match the task, but every prune records its reason and replacement coverage.
3. Prediction, verification, and merge have different owners. A `reasoner` simulates likely execution paths, a fresh-context reviewer checks the preceding local wave, and exactly one arbiter owns the verdict. These gates cannot be pruned.
4. Iteration is a bounded local graph rewrite. `PASS` finalizes, `LOOP` adds a new correction/review wave through pause → replan → resume, and `BLOCKED` stops with evidence. Completed nodes never form a hidden cycle.
5. Reality outranks self-report. State is event-sourced, recovery follows durable evidence, tests and code settle claims, and humans retain pause/step/cancel/replan authority where mistakes are expensive.

Why a DAG at all: a single agent loop struggles once a task has staged dependencies, parallelizable independent work, or a quality gate in the middle. Splitting decisions from volume (advanced vs. standard tiers), asking before building (deep-mode admission), gating verdicts with mandatory disposal, and recovering from evidence rather than guesses are the four judgments this engine is built on.

Curated reference topologies — design decision deep-dive, parallel project delivery, deep review of an existing subsystem, compact change review — ship through the workflow library's global scope (curated by the [`opencode-dag-config`](https://github.com/LeXwDeX/opencode-dag-config) repo) and a builtin tier embedded in release binaries. See the [workflow library](https://github.com/LeXwDeX/opencode-dag-config) for the catalog.

---

## Other changes in this fork

- **Delegated agents**: `task` delegates to sub-agents and continues them by `task_id`; background sub-agents with completion notifications are available behind `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS`.
- **Tool robustness**: JSON repair for broken multi-byte Unicode escapes in LLM output, structured validation errors with field-level hints, expanded tool docs, child-process pipe fixes.
- **CJK & IME fixes**: corrections for Chinese/Japanese/Korean input in the terminal UI (IME composition flushing, full-width text handling), plus a Korean IME fix script under [`patches/`](./patches).
- **Worktree isolation**: per-workflow `git worktree` isolation, with experimental sandbox-worktree HTTP endpoints.
- **Configuration assistant**: a standalone Go TUI under [`config_assistant`](./config_assistant) for locating, validating, and editing opencode configuration (`cd config_assistant && go run ./cmd/ocfg`).

All upstream capabilities (multi-provider, built-in LSP, client/server architecture, TUI/desktop/web clients) are preserved.

---

## Install

Prebuilt CLI binaries (Linux / macOS / Windows, with SHA256SUMS) are published on the [releases page](https://github.com/LeXwDeX/OpenCode-GraphAgent/releases). Stable releases are built from `main`; the `oc` installer selects and installs a release.

Release acceptance enforces two distinct integrity boundaries:

- **Archive integrity (before extraction)**: the `oc` installer verifies the release `SHA256SUMS` entry before unpacking and refuses to extract on mismatch. If upstream serves no `SHA256SUMS`, it installs with a warning (GitHub HTTPS transport only).
- **Post-install signature validity (macOS)**: the installer clears quarantine attributes (`xattr -cr`) and ad-hoc re-signs (`codesign -fs -`); acceptance then asserts `codesign --verify` passes and the binary runs. The installed binary's hash is intentionally **not** compared to the archive payload — ad-hoc signing can rewrite the binary's bytes, so differing hashes are legitimate. No post-signature digest is published (cross-version reproducibility of codesign output has not been established, and no supported reproducibility matrix exists).

From source (requires the [Bun](https://bun.sh) version pinned in `package.json` `packageManager` and the Node version in `.node-version`):

```bash
bun install
bun dev              # TUI
bun dev serve        # headless API server (port 4096)

# standalone binary
./packages/opencode/script/build.ts --single
```

> This fork is not published to npm/brew/scoop. The upstream `opencode-ai` package installs upstream opencode, not this fork.

---

## Quality gates

- **CI**: typecheck on every PR; the `main` gate additionally runs the Bun/Turbo unit suite and config-assistant Go tests (Linux), Playwright e2e (Linux + Windows), an HTTP API contract exerciser, and generated-SDK freshness checks.
- **DAG-specific tests**: core scheduling unit tests, projector/state-machine drift tests, workflow lifecycle integration tests, and HTTP API exercise scenarios for every DAG route.

## License

Mixed license model:

| Content | License | Text |
|---------|---------|------|
| Upstream opencode code (the vast majority) | MIT | [`LICENSE`](./LICENSE) |
| DAG workflow engine (fork-authored) | AGPL-3.0-or-later | [`packages/core/src/dag/LICENSE`](./packages/core/src/dag/LICENSE), [`packages/opencode/src/dag/LICENSE`](./packages/opencode/src/dag/LICENSE) |

Exact file boundaries are listed in [`NOTICE`](./NOTICE). The AGPL covers the DAG engine and derivatives of it, including network-server deployments. If you don't touch the DAG engine, the rest of the repository is plain MIT.

## Docs

- [`docs/architecture.md`](./docs/architecture.md) — system overview, client/API boundaries, and source map
- [`docs/reasoning-rewrite-engine-2026-10-08.md`](./docs/reasoning-rewrite-engine-2026-10-08.md) — reasoning shaping design, measurements and acceptance
- [`packages/opencode/src/memory/CONTEXT.md`](./packages/opencode/src/memory/CONTEXT.md) — Project Memory model and invariants
- [Hooks guide](./packages/core/src/plugin/skill/configure-hooks.md) — events, schemas and verification
- [Saved workflow authoring guide](./packages/core/src/plugin/skill/create-dag-workflow.md) — the `create-dag-workflow` skill body
- [`opencode-dag-config`](https://github.com/LeXwDeX/opencode-dag-config) — curated workflows, composable blocks and worker prompts
- [`docs/harness-dag.md`](./docs/harness-dag.md) — deep-mode admission & review lifecycle
- [`AGENTS.md`](./AGENTS.md) — contribution & development guide

## Links

- [GitHub](https://github.com/LeXwDeX/OpenCode-GraphAgent) · [Issues](https://github.com/LeXwDeX/OpenCode-GraphAgent/issues)
- [Upstream opencode](https://opencode.ai)
