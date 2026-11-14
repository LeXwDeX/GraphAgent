# Context Map

Read the context documents relevant to the code or decision under review. Do not load unrelated contexts by default.

| Context | Domain document | Primary areas |
| --- | --- | --- |
| Session Runtime | [`CONTEXT.md`](CONTEXT.md) | `packages/graphagent/src/session`, `packages/graphagent/src/system-context`, `packages/sdk/js` |
| Workflow Orchestration | [`packages/graphagent/src/dag/CONTEXT.md`](packages/graphagent/src/dag/CONTEXT.md) | `packages/graphagent/src/dag`, workflow tool, DAG template validation and packaging |
| Project Memory | [`packages/graphagent/src/memory/CONTEXT.md`](packages/graphagent/src/memory/CONTEXT.md) | `packages/graphagent/src/memory`, Memory-owned worktree lifecycle integration |
| Task Delegation | [`packages/graphagent/CONTEXT.md`](packages/graphagent/CONTEXT.md) | `packages/graphagent/src/agent`, `packages/graphagent/src/tool`, `packages/graphagent/src/session/child`, `packages/graphagent/src/background`, `packages/graphagent/src/command` |

## Contexts created lazily

Add future contexts to this map only when they have a stable document to reference.
