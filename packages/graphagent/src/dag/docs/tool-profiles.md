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
| `auditor`                        | read-only verification; model tier `advanced` | `read`, `grep`, `glob`, `bash`, `webfetch`, `websearch`, `skill`, `*_initial_instructions`                                                                                        | `edit`, `write`, `apply_patch`, `task`, `todowrite`, other MCP tools, `question`, `plan_exit` |
| `plan`                           | read-only planning, plan-file edits      | `read`, `grep`, `glob`, `bash`, `webfetch`, `websearch`, `edit`, `write`, `apply_patch` (only plan files pass), `task` (except `general`), `skill`, MCP tools | `todowrite` in a child session; `question`, `plan_exit` (root-only, hidden from every child session) |
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
- review lanes, skeptics, the review decision, verification, and synthesis -> `auditor`

## Writers

A node is a writer, one that can change the workspace, when its block is
`coding` or `prototype`, or when its worker is not a read-only profile
(`explore`, `plan`, `auditor`, `review`, `verify`, `verification`, or a matching
`review-*` / `verify-*` / `verification-*` name) and its effective
`workspace_writes` is not `deny`. The generated fan-out aggregator is never a
writer. Three engine rules share this one definition:

- The `plan` agent may only run workflows whose newly-running nodes are all
  read-only. A graph with a writer is refused at `start`, `extend`, `replan`,
  and `recover`, before anything is created or parked. A `debug` block's
  diagnosis node runs on `general` by default, which is write-capable: set
  `worker_type: explore` on the block when the plan agent investigates.
- Two unisolated writers never share a workspace across live workflows. The
  later `start`, or an `extend`, `replan`, or `recover` that would newly run such
  a writer, is refused until the first workflow finishes or the new writers are
  isolated (a recovery re-runs stored definitions, so it can only wait). Node
  `isolation: worktree`, a workflow-level worktree, and a different `workspace`
  all count as separate directories.
- A strict workflow whose writers include a pair with no dependency path
  defaults to `isolation: worktree` when the checkout is a clean git
  repository, and starts unisolated with a warning otherwise.

## Unattended children

`question` and `plan_exit` are root-only: a `task` subagent or DAG node hides
them even when its agent profile allows them, so a node asks its parent through
`agent.send` and a task child states the need in its final answer.

DAG node attempts and task children of a DAG-on root are unattended: their
permission asks never become a user dialog. Deny rules win first. A call that
hits the built-in safety list (SF-1..6) or a global `dag.safety.extra` rule
(SX-n) is refused as a tool error naming the rule and the reason, and the node
keeps running. A user-written allow with a concrete pattern lifts SF-1..5 and
SX-n, never SF-6. All other asks auto-approve. For a DAG node, a denial is
durable node evidence (`safety_denials`) that `inspect`, coverage, and the final
report and wake show; it is not a tool-profile change.

The safety list guards against honest mistakes, not adversarial input, and is
not a sandbox (see "No Sandbox" in
[SECURITY.md](../../../../../SECURITY.md#no-sandbox)). It judges structured
facts only: the tool, resolved target paths, and request metadata. It never
interprets bash semantics; shell commands are matched only as literal patterns
on a single simple command. The rules:

- SF-1 writes outside the project. (a) The target of `edit`, `write`, or
  `apply_patch` (an `apply_patch` move target included, symlinks resolved) lies
  outside the project directory, its worktrees, and the default allowed
  directories. (b) The shell tool raises an `external_directory` request for a
  path outside the project: its existing detection of outside path arguments to
  `cd`, `rm`, `cp`, `mv`, `mkdir`, `touch`, `chmod`, `chown`, `cat`, and similar
  commands, and an outside `workdir`. (b) does not distinguish reads from
  writes: either is refused, and outside files are read with the `read` tool.
- SF-2 reading credential files. The target path of `read`, `grep`, or `glob`
  matches `.env` or `.env.*` (except `.env.example`, `.env.sample`, and
  `.env.template`), `*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa*`,
  `id_ed25519*`, `id_ecdsa*`, `.ssh/**`, `.aws/credentials`, `.npmrc`,
  `.netrc`, `.pgpass`, `.git-credentials`, `.docker/config.json`,
  `.kube/config`, `/etc/shadow`, or `/etc/sudoers*`.
- SF-3 destructive commands, as literal patterns on a single simple command:
  `git reset --hard`, `git clean`, force push (`--force`, `--force-with-lease`,
  `-f`), `sudo`, `shutdown`, `reboot`, `mkfs*`, and `dd ... of=/dev/...`.
- SF-4 publishing, as literal patterns: `npm publish`, `pnpm publish`,
  `yarn publish`, `yarn npm publish`, `cargo publish`, `docker push`,
  `gh release ...`, and `gh pr merge`. A plain `git push`, including one to a
  feature branch, passes.
- SF-5 repeated identical calls (doom loop). Only the repeated call is refused.
- SF-6 calls that need user confirmation: a call whose hook returns ask, or an
  MCP tool call that declares it needs user interaction. Both are always
  refused, because a node has nobody to ask.

Under the `strict` review gate, every review lane and its arbitration decision
must use a read-only profile: `explore`, `plan`, `auditor`, `review`, `verify`,
`verification`, or a matching `review-*` / `verify-*` / `verification-*` name.
A write-capable profile in either position is an authoring error; under
`standard` the same gap is a warning. The block compiler defaults lanes, the
decision, verification, and synthesis to `auditor`.

`review` and `review-*` worker types remain configuration-owned: their effective
profile is the configured worker agent's profile. The built-in read-only
`auditor` implements verification, synthesis, and block review lanes by default.
A runtime that must stay read-only should
use `worker_type: explore` or `auditor`, or a configured agent whose ruleset
denies `edit`, `write`, `apply_patch`, `task`, and `todowrite`.

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
