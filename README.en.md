<p align="center">
  <a href="./README.md">简体中文</a> ·
  <b>English</b>
</p>

# GraphAgent

> A terminal coding agent for dynamic workflows: the main agent designs the dependency graph, child agents run it in parallel waves, and state is durable, so a crash does not lose the run.

[![release](https://img.shields.io/github/v/release/LeXwDeX/GraphAgent)](https://github.com/LeXwDeX/GraphAgent/releases)
[![license](https://img.shields.io/badge/license-MIT%20%2B%20Apache--2.0-blue)](#relationship-to-opencode-and-license)
[![stars](https://img.shields.io/github/stars/LeXwDeX/GraphAgent)](https://github.com/LeXwDeX/GraphAgent/stargazers)

<!-- A screenshot or GIF of a DAG run goes here: the main conversation building a graph, nodes running in waves, live state in the TUI inspector. -->

GraphAgent is an unofficial fork of an early opencode v1, with no affiliation to the OpenCode team. We added a DAG workflow engine and a few features aimed at long tasks.

A single agent loop is fine for a one-step task. Once the work has ordered dependencies, parts that can run in parallel and a review in the middle, it struggles: independent work runs in series and intermediate conclusions go unchecked. If the process dies, you start over. GraphAgent has the main agent draw the task as a dependency graph first, then run it. The graph is not written in advance. The agent designs it for the task at hand, which is why a DAG workflow here is essentially a dynamic workflow. Each node is a real child session with its own agent and context window. Nodes whose dependencies are met form a wave and run in parallel. State is persisted as events, so a run can be paused, stepped and replanned, and after a crash it recovers from the persisted record instead of replaying model calls.

## Status

v1 works, and every release so far is v1. We only fix its defects (please report reproducible problems as [issues](https://github.com/LeXwDeX/GraphAgent/issues)) and add no new platform capabilities to it. v2 is being rewritten with a redesigned runtime. The "v2 direction" column below is a plan, not a list of existing features.

## Core capabilities

| Capability           | v1 today                                                                                                                       | v2 direction                                                                                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DAG workflows        | The main agent designs a dependency graph; nodes are real child sessions run in parallel waves; durable; pause, resume, replan | Agent contracts and a composer to combine shared agents (research, architecture design, prototyping) in a DAG; a DAG mode switch (concurrency pool, budget, review) |
| Reasoning shaping 🧪 | Experimental, off by default                                                                                                   | —                                                                                                                                                                   |
| Project memory       | `/memory`; stores only what the user confirmed                                                                                 | A pointer document built into the project, loaded into the prefix prompt area                                                                                       |
| Goal / Loop          | `/goal`, `/subgoal`; an external judge checks progress; turn budget                                                            | Renamed loop; the loop prompt can be updated automatically through configuration                                                                                    |
| Hooks                | Compatible with the Claude Code hooks protocol                                                                                 | Full rewrite: events derived from canonical state transitions, a single dispatcher                                                                                  |
| Context management   | Tool-output limits, a tool-call cap, long-session compaction                                                                   | Removed                                                                                                                                                             |

### DAG workflows

The main agent builds a graph when it judges a task worth splitting, without being asked; you can also ask directly with `/dag-auto <task>`. An edge means the downstream node reads the upstream node's output, and nodes with no such relation run in parallel. Gate nodes do review and arbitration and emit `ACCEPT`, `REVISE`, `REJECT` or `BLOCKED`; downstream nodes can be conditioned on the verdict. The TUI inspector shows waves and live node state and lets you step into any node's child session.

Model tiers live in `.agents/dag.jsonc` (critical nodes on `advanced`, high-volume nodes on `standard`). Graphs you reuse go in `.agents/workflows/` and start by name. Curated templates are in [opencode-dag-config](https://github.com/LeXwDeX/opencode-dag-config). Crash recovery relies only on the persisted record. The engine does not assume cross-process locking and does not guarantee that a node runs exactly once. Usage and engine details are in [docs/dag-workflows.md](./docs/dag-workflows.md).

### Reasoning shaping

🧪 Experimental, off by default. Thinking models send earlier reasoning back on later requests, and it is full of restatements, abandoned guesses and corrections. This feature shortens completed reasoning in the background and uses the shorter version in later steps. If shaping fails, times out, or no small model is available, the original is kept. Originals are always stored, so turning the feature off replays them. Signed or encrypted reasoning is never touched.

What we want to know is whether shaped reasoning improves an open-source model's output. We are still checking, which is why it is experimental and off by default. Enable it with `reasoningDistillation.enabled: true`. The organizer is the configured `small_model`, or the provider's own small model if none is set.

### Project memory

With `/memory on`, v1 stores preferences, decisions and terminology per project, and only what you confirmed. All worktrees of a project share one memory. It is not a code index and never outranks your current input or higher-priority instructions. v2 changes this substantially: a pointer document built into the project, loaded into the prefix prompt area.

### Goal and Loop

`/goal <goal>` has the agent work one goal across turns in the current session, and `/subgoal` manages sub-goals. After each turn an external judge rules on progress: `done` ends it, `continue` runs another turn. There is a turn budget (default 20); when it runs out the goal pauses and can be resumed. State is persisted and survives restarts. In v2 it is renamed loop, and the loop prompt can be updated automatically through configuration.

### Hooks

v1 is compatible with the Claude Code hooks protocol. `hooks.json` is read from the global config directory and the project's `.agents` directory. There are five handler types (command, HTTP, MCP tool, prompt, agent), and project hooks must be trusted before they run. `/import-claude` reviews `.claude/settings*.json` and converts it into `.agents/`; `/create-hook` walks you through writing a new hook.

v2 rewrites hooks completely and drops the patch-style implementation: hook events are derived from canonical state transitions and delivered by a single dispatcher. Whether v2 stays compatible with the Claude Code protocol is not promised. For v1, see the [hooks guide](./packages/graphagent/src/skill/builtin/configure-hooks.md).

### Context management

v1 has a set of context-management features: limits on tool output length, a cap on tool calls per user input, and automatic compaction of long sessions. v2 removes them. Our judgment is that they were built for smaller windows and weaker models. With better hardware and better models they no longer have value, and keeping them would only mean paying for maintenance.

## Other changes

- `task` can resume a child agent by `task_id` and supports background child agents, which notify on completion.
- Every model gets the same system prompt. Tool usage lives in each tool's description instead of a per-provider prompt.
- Stricter, easier-to-debug tools: `edit` matches strictly (it lists candidate lines when several match and the closest snippet when none does), and validation errors carry field-level hints.
- Independent git worktrees can be used to manage working directories. Workflows are not isolated automatically, so concurrent workflows need different worktrees or must run serially.
- `config_assistant` (command `ocfg`) is a standalone Go TUI for locating, validating and editing configuration.

## Quick start

Prebuilt binaries (Linux, macOS, Windows, with SHA256SUMS) are on the [Releases](https://github.com/LeXwDeX/GraphAgent/releases) page. Unpack one, put `graphagent` on your PATH and run it in your project directory. The `oc` script in this repo is a bash installer with an fzf menu: it picks a version, checks it against SHA256SUMS and installs it (it needs curl and fzf). The fork is not published to npm, brew or scoop, and the upstream `opencode-ai` package installs upstream opencode, not this fork.

To run from source you need the Bun version pinned in `package.json` (`packageManager`) and the Node version in `.node-version`:

```bash
bun install
bun dev <project-dir>   # starts the TUI; without a directory it runs in packages/graphagent
```

Then give it work that has stages and room for parallelism. No DAG configuration is needed first:

```text
/dag-auto Migrate the auth and server packages to the new API, then run the integration tests
```

To keep a graph you reuse, save it as a YAML spec under `.agents/workflows/` and start it by name. A minimal spec is in [docs/dag-workflows.md](./docs/dag-workflows.md#using-workflows). Install details, integrity checks and building from source are in [docs/install.md](./docs/install.md).

## Design

We treat the graph as an executable, durable, inspectable contract. It is not a flowchart for humans, and it is not arrows added to a prompt chain after the fact. An edge must carry output: if the downstream node does not read the upstream node, the dependency should go, and independent work runs in parallel. A template is a reference topology. The main agent may add or prune branches for the task, but every prune records its reason. Prediction, review and verdict belong to different roles, and those gates cannot be pruned. Iteration is a bounded local rewrite of the graph, never a hidden cycle. Finally, code and tests have the last word, state is recovered from the event record, and the places where mistakes are expensive stay with a human who can pause, step, cancel and replan.

The first complete DAG engine commit is dated 2026-07-02. The paper [What makes prompts a graph](https://arxiv.org/abs/2607.27578) formalized explicit structure, prompt/topology separation, executable semantics and the graph as a first-class artifact on 2026-07-30, four weeks later.

## Roadmap

v2 is tracked on the [milestone](https://github.com/LeXwDeX/GraphAgent/milestone/7). Besides the changes in the table above, the plan includes:

- A unified child run (ChildRun) shared by `task` and DAG nodes.
- A redone TUI: themes, skeleton states, a status band, a sidebar drawer, and a read-only view of child agents.
- `/remind`: persistent scheduled reminders.
- PR watching rebuilt as an event source.
- Background task display.
- The v2.0.0 release, with migration guides in Chinese and English.

These are plans. The milestone has the actual status.

## Relationship to opencode and license

GraphAgent descends from an early opencode v1 (MIT, [anomalyco/opencode](https://github.com/anomalyco/opencode)). It is an unofficial fork, neither affiliated with nor endorsed by the OpenCode team. Multi-provider support, LSP, the client/server architecture and the TUI come from upstream.

There are two license rules. Code inherited from upstream stays MIT, including upstream files we modified; the text is in [LICENSE](./LICENSE). Code written for this fork is Apache-2.0; the text is in [LICENSE-APACHE](./LICENSE-APACHE). The exact file boundary is in [LICENSE-UPSTREAM.txt](./LICENSE-UPSTREAM.txt) and summarized in [NOTICE](./NOTICE). Redistribution must keep the copyright and attribution notices in NOTICE.

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

[GitHub](https://github.com/LeXwDeX/GraphAgent) · [Issues](https://github.com/LeXwDeX/GraphAgent/issues) · [Releases](https://github.com/LeXwDeX/GraphAgent/releases) · [Milestone](https://github.com/LeXwDeX/GraphAgent/milestone/7) · [opencode-dag-config](https://github.com/LeXwDeX/opencode-dag-config) · [Upstream opencode](https://github.com/anomalyco/opencode)
