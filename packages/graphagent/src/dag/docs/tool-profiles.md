# DAG worker tool profiles

A workflow node's effective tool profile comes from three layers:

1. The worker agent's native role rules (`nativePermission`).
2. The worker agent's configured rules (`Agent.Info.permission`) plus the child
   session permission built by `deriveSubagentSessionPermission`: parent deny
   rules, parent `external_directory` rules, and default `todowrite` / `task`
   denies for tools the agent does not already mention.
3. The user's per-message runtime tool switches (`user.tools`).

`Permission.ask` evaluates the native rules before the configured rules, so a
native deny wins over a later user allow. The advertised tool list, skill list,
MCP instructions, and reminders use the same split. A wildcard deny hides the
tool only when no later allow can still match a path; a later allow is kept
unless every matching deny after it provably covers its glob. A
pattern-scoped deny keeps the tool visible because some calls can still pass.
Individual skills are filtered by the effective native and child-session
rules. MCP instructions are omitted when every advertised tool of that server
is denied by either layer. `edit`, `write`, and `apply_patch` share the `edit`
permission; `list_mcp_resources`, `list_mcp_resource_templates`, and
`read_mcp_resource` share the `read` permission.

## Profiles

| Worker / block source            | Profile                                  | Advertised tools                                                                                                                                                                       | Hidden by the profile                                                                         |
| -------------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `explore`, `debug--evidence`     | read-only research                       | `read`, `grep`, `glob`, `bash`, `webfetch`, `websearch`, `skill`, `*_initial_instructions`                                                                                             | `edit`, `write`, `apply_patch`, `task`, `todowrite`, other MCP tools, `question`, `plan_exit` |
| `plan`                           | read-only planning, plan-file edits      | `read`, `grep`, `glob`, `bash`, `webfetch`, `websearch`, `edit`, `write`, `apply_patch` (only plan files pass), `task` (except `general`), `skill`, MCP tools, `question`, `plan_exit` | `todowrite` in a child session                                                                |
| `general`                        | writer / verifier                        | all default tools except `todowrite`; `edit`, `write`, `apply_patch`, `skill`, MCP tools                                                                                               | `todowrite`, and `task` in a child session                                                    |
| `build`                          | writer                                   | non-DAG primary: all default tools including `todowrite` and `task`; DAG child: `edit`, `write`, `apply_patch`, `skill`, MCP tools                                                     | `todowrite` and `task` in a DAG child session                                                 |
| `compaction`, `title`, `summary` | internal `* deny`                        | none                                                                                                                                                                                   | every tool; these hidden agents are not valid workflow worker types                           |
| `review`, `review-*`             | configured review worker                 | determined by the configured agent; the model tier is `advanced`                                                                                                                       | nothing is imposed by the runtime                                                             |
| `verify`, `synthesize`           | `general` unless `worker_type` overrides | same as `general`                                                                                                                                                                      | same as `general`                                                                             |

Block defaults:

- `explore` -> `explore`
- `plan` -> `plan`
- `coding`, `prototype` -> `build`
- `debug` evidence lane -> `explore`; its diagnosis lane -> `general`
- every other lane, including review lanes, verification, and synthesis -> `general`

`review` and `verify` have no built-in agent. Their effective profile is the
configured worker agent's profile. A runtime that must stay read-only should
use `worker_type: explore` or a configured agent whose ruleset denies
`edit`, `write`, `apply_patch`, `task`, and `todowrite`.

## Bootstrap tools

The read-only `explore` profile allows `skill` and tools matching
`*_initial_instructions` even though its default is `*: deny`. The `skill`
system block is injected only when both the native and configured rules allow
`skill`, and each listed skill must pass the same two layers. MCP instructions
are injected only when the server has no advertised tools or at least one of
its tools is not disabled. A server whose every tool is denied by either layer
contributes no instructions, so the node is not told to call a tool it cannot
use.

## Denial wording

- A tool denied by the worker role, including the child-session defaults for
  `todowrite` and `task`, reports:
  `This tool is not available to the <agent> agent.`
- New child sessions store role defaults first. Older persisted child sessions
  may store inherited parent rules first and role defaults after them; both
  layouts are recognized. If an inherited rule has exactly the same contents
  as a role default, the two cannot be distinguished without persisted
  provenance. In that case the denial keeps the conservative user wording.
- Native denies always report role wording. If a later inherited parent, user,
  session, or hook rule wins instead, the denial keeps the user-rule message
  and names the relevant rules.
- A tool denied by a user rule keeps the user-rule message and names the
  relevant rules.

DAG workers are ordinary child sessions, so non-DAG subagents get the same
profile and wording rules.
