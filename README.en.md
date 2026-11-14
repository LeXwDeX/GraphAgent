<p align="center">
  <a href="./README.md">简体中文</a> ·
  <b>English</b>
</p>

# GraphAgent

> A terminal coding agent for dynamic workflows: the main agent designs the dependency graph, child agents run it in parallel waves, and state is durable, so a crash does not lose the run.

[![release](https://img.shields.io/github/v/release/LeXwDeX/GraphAgent)](https://github.com/LeXwDeX/GraphAgent/releases)
[![license](https://img.shields.io/badge/license-MIT%20%2B%20Apache--2.0-blue)](#origin-and-license)
[![stars](https://img.shields.io/github/stars/LeXwDeX/GraphAgent)](https://github.com/LeXwDeX/GraphAgent/stargazers)

<!-- A screenshot or GIF of a DAG run goes here: the main conversation building a graph, nodes running in waves, live state in the TUI inspector. -->

GraphAgent is a standalone terminal coding agent built around dynamic DAG workflows. It descends from an early version of opencode and has been maintained independently since v2.0.

A single agent loop is fine for a one-step task. Once the work has ordered dependencies, parts that can run in parallel and a review in the middle, it struggles: independent work runs in series and intermediate conclusions go unchecked. If the process dies, you start over. GraphAgent has the main agent draw the task as a dependency graph first, then run it. The graph is not written in advance. The agent designs it for the task at hand, which is why a DAG workflow here is essentially a dynamic workflow.

Each node is a real child session with its own agent and context window. Nodes whose dependencies are met form a wave and run in parallel. State is persisted as events, so a run can be paused, stepped and replanned, and after a crash it recovers from the persisted record instead of replaying model calls.

## Status

v2.0 is in development and about to be released. Progress is tracked on the [milestone](https://github.com/LeXwDeX/GraphAgent/milestone/7); please report reproducible problems as [issues](https://github.com/LeXwDeX/GraphAgent/issues).

## Core capabilities

| Capability                       | Description                                                                                                                                                                                             |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DAG workflows                    | The main agent designs a dependency graph; nodes are real child sessions run in parallel waves; durable; pause, resume, replan; a node's timeout starts at execution-slot acquisition, not while queued |
| Unified child runs               | `task` and DAG nodes share ChildRun: one durable record per delegation with ownership checks, cancellation and result delivery; a child session accepts input only from its parent agent                |
| Foreground/background delegation | Prompt criteria decide whether a `task` blocks the turn or runs in the background; a finished background result returns as one message                                                                  |
| Read-only review                 | A built-in read-only `review` agent; `/review` runs in the background by default and the main agent relays its findings                                                                                 |
| Reasoning shaping 🧪             | Experimental, off by default                                                                                                                                                                            |
| Project memory                   | `/memory`; stores only what the user confirmed; shared by all worktrees of a project                                                                                                                    |
| Goal / Loop                      | `/goal`, `/subgoal`; an external judge checks progress; turn budget                                                                                                                                     |
| Hooks                            | Compatible with the Claude Code hooks protocol                                                                                                                                                          |
| Context management               | Tool-output limits, a tool-call cap, long-session compaction                                                                                                                                            |

### DAG workflows

The main agent builds a graph when it judges a task worth splitting, without being asked; you can also ask directly with `/dag-auto <task>`. An edge means the downstream node reads the upstream node's output, and nodes with no such relation run in parallel. Gate nodes do review and arbitration and emit `ACCEPT`, `REVISE`, `REJECT` or `BLOCKED`; downstream nodes can be conditioned on the verdict. The TUI inspector shows waves and live node state and lets you step into any node's child session.

Model tiers live in `dag.model` under `.agents/settings.json` (critical nodes on `advanced`, high-volume nodes on `standard`). Graphs you reuse go in `.agents/workflows/` and start by name. Curated templates are in [opencode-dag-config](https://github.com/LeXwDeX/opencode-dag-config). A node's `timeout_ms` starts when it acquires an execution slot; queue time does not count. Crash recovery relies only on the persisted record. The engine does not assume cross-process locking and does not guarantee that a node runs exactly once. Usage and engine details are in [docs/dag-workflows.md](./docs/dag-workflows.md).

### Child runs and communication

`task` and DAG nodes share one ChildRun mechanism. Each delegation has one durable record covering ownership, state and outcome; a background run's result is delivered exactly once, including runs left over after a restart or lost with their process. Child sessions do not accept free-form input: the HTTP operation layer answers writes to a child session with 409 and only allows permission replies and read-only side questions, while engine admission requires the live credential of the session's active run.

The `agent` tool carries observation and messages between the main agent and DAG nodes: `observe` pages through node progress and attempts, `send` delivers to one exact live attempt, and `receive` reads the mailbox. A node that needs clarification asks its parent, not the user. The tool is visible only while an active DAG node run exists; visibility is resolved from an in-process registry without a database query.

### Read-only review and delegation classification

`/review` uses the built-in read-only `review` agent: it can read files, search, query LSP, and run read-only git and forge commands; it cannot edit files, spawn sub-tasks, or run commands that mutate files. The command runs in the background by default and hands its findings back to the main agent, which relays them.

The `task` tool decides foreground versus background from prompt criteria, not from a code heuristic. Foreground when the work needs the user's input or confirmation, changes state shared with the main agent, is the direct input to the next step, or takes seconds. Background only when it does not block the next step, only reads or writes files the main agent will not touch, takes minutes, and its result fits in one message.

### Reasoning shaping

🧪 Experimental, off by default. Thinking models send earlier reasoning back on later requests, and it is full of restatements, abandoned guesses and corrections. This feature shortens completed reasoning in the background and uses the shorter version in later steps. If shaping fails, times out, or no small model is available, the original is kept. Originals are always stored, so turning the feature off replays them. Signed or encrypted reasoning is never touched.

What we want to know is whether shaped reasoning improves an open-source model's output. We are still checking, which is why it is experimental and off by default. Enable it with `reasoningDistillation.enabled: true`. The organizer is the configured `small_model`, or the provider's own small model if none is set.

### Project memory

With `/memory on`, GraphAgent stores preferences, decisions and terminology per project, and only what you confirmed. All worktrees of a project share one memory. It is not a code index and never outranks your current input or higher-priority instructions.

### Goal and Loop

`/goal <goal>` has the agent work one goal across turns in the current session, and `/subgoal` manages sub-goals. After each turn an external judge rules on progress: `done` ends it, `continue` runs another turn. There is a turn budget (default 20); when it runs out the goal pauses and can be resumed. State is persisted and survives restarts.

### Hooks

GraphAgent is compatible with the Claude Code hooks protocol. `hooks.json` is read from the global config directory and the project's `.agents` directory. There are five handler types (command, HTTP, MCP tool, prompt, agent), and project hooks must be trusted before they run. `/import-claude` reviews `.claude/settings*.json` and converts it into `.agents/`; `/create-hook` walks you through writing a new hook. See the [hooks guide](./packages/graphagent/src/skill/builtin/configure-hooks.md) for details.

### Context management

A set of context-management features: limits on tool output length, a cap on tool calls per input, and automatic compaction of long sessions. Truncated output includes a way to continue reading.

## Other changes

- `task` can resume a child agent by `task_id` and supports background child agents, which notify on completion.
- Every model gets the same system prompt. Tool usage lives in each tool's description instead of a per-provider prompt.
- Stricter, easier-to-debug tools: `edit` matches strictly (it lists candidate lines when several match and the closest snippet when none does), and validation errors carry field-level hints.
- Independent git worktrees can be used to manage working directories. Workflows are not isolated automatically, so concurrent workflows need different worktrees or must run serially.
- A session can be created with DAG mode on; the TUI footer shows its state, and the status endpoint reports availability, concurrency and node limits, and token-budget usage.
- `config_assistant` (command `ocfg`) is a standalone Go TUI for locating, validating and editing configuration.

## Quick start

Prebuilt binaries (Linux, macOS, Windows, with SHA256SUMS) are on the [Releases](https://github.com/LeXwDeX/GraphAgent/releases) page. Unpack one, put `graphagent` on your PATH and run it in your project directory. The `oc` installer script in this repo goes away in v2.1, when installing and upgrading move into the main program (see the roadmap). GraphAgent is not published to npm, brew or scoop, and the upstream `opencode-ai` package installs upstream opencode, not GraphAgent.

To run from source you need the Bun version pinned in `package.json` (`packageManager`) and the Node version in `.node-version`:

```bash
bun install
bun dev <project-dir>   # starts the TUI; without a directory it runs in packages/graphagent
```

Then give it work that has stages and room for parallelism. No DAG configuration is needed first:

```text
/dag-auto Migrate the auth and server packages to the new API, then run the integration tests
```

To keep a graph you reuse, save it as `.agents/workflows/parallel-migrate.yaml` and start it by name. In the spec below, the two migration nodes run in the same wave and `assemble` waits for both:

```yaml
title: Parallel migration
config:
  name: parallel-migrate
  nodes:
    - id: discover
      name: discover
      worker_type: explore
      depends_on: []
      required: true
      prompt_template: { inline: "List every package that must migrate to the new API." }

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

    - id: assemble
      name: assemble
      worker_type: build
      depends_on: [migrate-auth, migrate-server]
      prompt_template: { inline: "Run the integration tests and summarize the results." }
```

Install details, integrity checks and building from source are in [docs/install.md](./docs/install.md).

## Design

We treat the graph as an executable, durable, inspectable contract. It is not a flowchart for humans, and it is not arrows added to a prompt chain after the fact. An edge must carry output: if the downstream node does not read the upstream node, the dependency should go, and independent work runs in parallel. A template is a reference topology. The main agent may add or prune branches for the task, but every prune records its reason. Prediction, review and verdict belong to different roles, and those gates cannot be pruned. Iteration is a bounded local rewrite of the graph, never a hidden cycle. Finally, code and tests have the last word, state is recovered from the event record, and the places where mistakes are expensive stay with a human who can pause, step, cancel and replan.

The first complete DAG engine commit is dated 2026-07-02. The paper [What makes prompts a graph](https://arxiv.org/abs/2607.27578) formalized explicit structure, prompt/topology separation, executable semantics and the graph as a first-class artifact on 2026-07-30, four weeks later.

## Roadmap

v2.0's remaining work is tracked on the [milestone](https://github.com/LeXwDeX/GraphAgent/milestone/7):

- The behavioral side of DAG mode: concurrency pool, budget and quality mechanisms, automatic adjudication of node permission asks.
- Workflow tool interface convergence, workflow-level worktrees, event-driven mailboxes and durable reconciliation.
- Agent contracts and a composer: built-in research, architecture design and prototyping agents, composed inside a DAG.
- PR watching rebuilt as an event source; `/remind` persistent reminders; background task display and a read-only child-agent view.
- The v2.0.0 release: version derivation, breaking-change list, migration guides in Chinese and English, and three-platform smoke tests.
- v2.1: install and upgrade move into the main program. It looks up new versions on GitHub and upgrades itself, so the `oc` script is gone. Release packaging changes with it, so installing on macOS no longer asks for a password. Configuration can also be read from a GitHub repository ([#1281](https://github.com/LeXwDeX/GraphAgent/issues/1281)).

These are plans. The milestone has the actual status.

## Origin and license

GraphAgent descends from an early opencode (MIT, [anomalyco/opencode](https://github.com/anomalyco/opencode)) and has been maintained as an independent project since v2.0.

There are two license rules. Code inherited from upstream stays MIT, including upstream files we modified; the text is in [LICENSE](./LICENSE). Code written for GraphAgent is Apache-2.0; the text is in [LICENSE-APACHE](./LICENSE-APACHE). The exact file boundary is in [LICENSE-UPSTREAM.txt](./LICENSE-UPSTREAM.txt) and summarized in [NOTICE](./NOTICE). Redistribution must keep the copyright and attribution notices in NOTICE.

## Docs

`architecture.md` and `功能清单.md` are in Chinese; the rest are in English.

- [docs/architecture.md](./docs/architecture.md): v1 architecture, components and directories, clients and protocol, source map
- [docs/dag-workflows.md](./docs/dag-workflows.md): DAG workflow usage, configuration and engine details
- [docs/install.md](./docs/install.md): installation, integrity checks and building from source
- [docs/compaction-retry.md](./docs/compaction-retry.md): provider retries and compaction requests
- [Hooks guide](./packages/graphagent/src/skill/builtin/configure-hooks.md): events, configuration and verification
- [docs/功能清单.md](./docs/功能清单.md): feature and source index
- [AGENTS.md](./AGENTS.md): development guide
- [CONTRIBUTING.md](./CONTRIBUTING.md): contributing

## Links

[GitHub](https://github.com/LeXwDeX/GraphAgent) · [Issues](https://github.com/LeXwDeX/GraphAgent/issues) · [Releases](https://github.com/LeXwDeX/GraphAgent/releases) · [Milestone](https://github.com/LeXwDeX/GraphAgent/milestone/7) · [opencode-dag-config](https://github.com/LeXwDeX/opencode-dag-config)
