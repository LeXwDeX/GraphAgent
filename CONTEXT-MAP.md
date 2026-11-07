# Context Map

Read the context documents relevant to the code or decision under review. Do not load unrelated contexts by default.

| Context | Domain document | Primary areas |
| --- | --- | --- |
| Session Runtime | [`CONTEXT.md`](CONTEXT.md) | `packages/graphagent/src/session`, `packages/graphagent/src/system-context`, `packages/sdk/js` |
| Workflow Orchestration | [`packages/graphagent/src/dag/CONTEXT.md`](packages/graphagent/src/dag/CONTEXT.md) | `packages/graphagent/src/dag`, workflow tool, DAG template validation and packaging |
| Project Memory | [`packages/graphagent/src/memory/CONTEXT.md`](packages/graphagent/src/memory/CONTEXT.md) | `packages/graphagent/src/memory`, Memory-owned worktree lifecycle integration |

## Contexts created lazily

Add future contexts to this map only when they have a stable document to reference.
