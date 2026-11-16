# Unattended permissions

[简体中文](./unattended-permissions.md)

Some sessions have nobody to answer a permission question: the nodes of a DAG workflow, and the `task` subagents of a session while DAG mode is on. This guide calls them unattended sessions. It covers three things: how much freedom they get (the `dag.permission` tiers), what the built-in safety list does and does not catch, and how to put an external command guard in front of their tools.

None of this is a sandbox. See [No Sandbox](../SECURITY.md#no-sandbox) in SECURITY.md: the safety list, the tiers and a guard hook are nets for an honest agent that makes mistakes. They are not a security boundary. If you need isolation, run GraphAgent in Docker or a VM.

## The three tiers

`dag.permission` takes one of three values. `allow` is the default.

| Tier       | What an unattended session gets                                                                                                   | Fits                                                          |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `allow`    | Nobody is asked. Deny rules win first, the safety list refuses what it matches, everything else is approved automatically.        | Workflows that should run without interruption (the default). |
| `ask`      | Every edit, shell command and MCP tool call waits for your approval.                                                              | You want to review each step and accept the waiting.          |
| `readonly` | A read-only tool surface: no file edits, a short list of read-only git and gh queries, no MCP tools unless you allow one by name. | Research and review workflows that must not change anything.  |

The tier applies to unattended sessions only. Your own session keeps its permission mode, `hookPermissions.mode`, `--dangerously-skip-permissions` and the agent's rules as they are. A `task` subagent while DAG mode is off is not unattended and is asked as before.

### Setting it

Write the key in your user-level configuration, `graphagent.json` or `graphagent.jsonc` in the config directory (`GRAPHAGENT_CONFIG_DIR`, else `~/.config/graphagent`):

```json
{
  "dag": {
    "permission": "ask"
  }
}
```

`dag.permission` is read from the global layer only. A value in `<root>/.agents/settings.json` or `settings.local.json` is ignored with a warning that names the file and the key, so a shared repository cannot loosen or tighten the tier for you. An unknown value is a configuration error.

The tier is read at every permission request and is never cached per workflow or session. A running node follows a switch at its next call. GraphAgent keeps a snapshot of the global configuration: a change that GraphAgent writes itself is picked up at once, while a hand edit of the file is picked up when the configuration is reloaded (restart GraphAgent to be sure).

When DAG mode is on and the tier is not `allow`, the main agent is told in its DAG mode notice (waits in `ask`, read-only nodes in `readonly`). `/dag-mode` itself does not show or change the tier.

### `allow`

The behaviour has not changed. A permission request of an unattended session is never shown to you:

1. A `deny` rule you configured refuses the call, before everything else.
2. A call that matches the safety list (below) or a `dag.safety.extra` rule you added is refused with a tool error that names the rule and the reason. The node keeps running; the refusal is recorded on the node and shown in `inspect`, in the coverage section and in the final report.
3. An allow rule you wrote yourself, with a concrete pattern (`bash: {"npm publish *": "allow"}`), lifts SF-1 to SF-5 and `SX-n` for that call. A whole-key allow such as `bash: "allow"` does not, and nothing lifts SF-6.
4. Everything else, including what would normally ask, is approved.

### `ask`

Each edit (`edit`, `write`, `apply_patch`), each shell command and each MCP tool call of an unattended session becomes a permission question, shown the way any other question is, and attributed to the node's own session. The safety list does not run in this tier: you judge each call. `deny` rules still refuse without asking.

These calls need no question:

- A call your own allow rule covers with a concrete pattern: `bash: {"bun test*": "allow"}` lets `bun test` run. For an MCP tool the allow must name that exact tool, without a wildcard. `bash: "allow"` and `mcp_*` do not count.
- A pattern you answered "always" for earlier in the same session. Answers do not carry over to other nodes.

Reading and searching tools (`read`, `grep`, `glob`), the `agent` tool and every other key do not ask more than before. The questions that already existed still ask: a path outside the project, `.env` files, repeated calls, rules that say `ask`, and a hook answering `ask`. A hook's allow and `acceptEdits` do not skip a question this tier raises. With `hookPermissions.mode: dontAsk` configured, such a call is refused without a question.

If you reject a request, that session's current turn ends and the node attempt finishes the way the engine finishes any attempt. A node that waits for you holds its concurrency slot, and the waiting counts against its timeout, so a node you are not around for can time out. Keep graphs small.

`graphagent run` has nobody to answer: it rejects the questions of nodes and task children automatically, never hangs on them, and prints one line about the tier to stderr when it starts. `--dangerously-skip-permissions` still covers the main session only.

### `readonly`

A workflow that contains a node which can write cannot start in this tier: `start`, `extend`, `replan`, `recover` and `retry` refuse it, and the message names `dag.permission`. Drafting and validating still work. If you switch to `readonly` while a writing node is running, the node is not cancelled; its later edit requests are refused.

Unattended sessions, `task` subagents included, get this tool surface:

- No `edit`, `write` or `apply_patch`.
- `bash` is limited to the read-only git and gh queries that the built-in `review` agent may run (`git diff`, `git log` and similar). Anything else is refused, `npm test`, `rm` and `git commit` included. An allow rule of yours does not widen this: to widen it, change the tier.
- MCP tools are refused unless your configuration allows that exact tool by name. A wildcard such as `server_*` or `*` does not count.
- `read`, `grep`, `glob` and the `agent` tool keep working.

Nothing is ever asked in this tier. A call that would need your approval is refused as rule `RO-1` (for example, reading a path outside the project). The safety list still applies and comes first under its own ids: SF-2 for credential files, SF-5 for repeated calls, SF-6 for a hook that answers `ask`. A call that the tool surface refuses is an ordinary rule denial and is not recorded as a safety denial.

This narrows the tool surface. It is not isolation: the `bash` list is made of literal rules over the command text, and a shell can write through a redirection that no rule reads.

## The safety list

In the `allow` tier, and in `readonly` as far as it applies, an unattended call is checked against these rules. Each refusal names its id:

| Id   | Refuses                                                                                                                                                                                                                     |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SF-1 | Writes outside the project: the target of `edit`, `write` or `apply_patch`. Shell commands that name a path outside the project (`cd`, `rm`, `cp`, `mv`, `cat` and similar) or run in an outside `workdir`, reads included. |
| SF-2 | Reading credential files with `read`, `grep` or `glob`: `.env` and `.env.*` (not `.env.example` and similar), `*.pem`, `*.key`, SSH keys and `.ssh/**`, `.aws/credentials`, `.npmrc`, and others.                           |
| SF-3 | Destructive commands: `git reset --hard`, `git clean`, force push, `sudo`, `shutdown`, `reboot`, `mkfs*`, `dd ... of=/dev/...`.                                                                                             |
| SF-4 | Publishing: `npm publish`, `pnpm publish`, `yarn publish`, `yarn npm publish`, `cargo publish`, `docker push`, `gh release ...`, `gh pr merge`.                                                                             |
| SF-5 | Repeating the identical call (a loop).                                                                                                                                                                                      |
| SF-6 | A call that needs a human: a hook answering `ask`, or an MCP tool that declares it needs user interaction.                                                                                                                  |
| SX-n | The rules you add in the global `dag.safety.extra`. They can only deny.                                                                                                                                                     |
| RO-1 | `readonly` tier only: a call that would need your approval.                                                                                                                                                                 |

The list reads structured facts: the permission key, the paths the native tools pass, which tool raised a request, and literal wildcard patterns over a single simple command. It never interprets shell text.

### What it does not cover

These gaps are by design. A list that tried to cover them would have to parse the shell, and it would still not be a boundary.

- Writes outside the project that the shell tool's own path detection does not see: redirections (`> ../x`), `tee`, `sed -i`, `ln`, a wrapper that changes the working directory (`env -C`).
- Reading credential files from the shell (`cat .env`, `grep -f`), and a `grep` over a directory that holds them.
- Any spelling that changes the command text: `env X=1 git reset --hard`, `command git ...`, variables and functions, `bash -c '...'`, `curl ... | sh`. The literal tables miss them.
- Pushing to the default branch (`git push origin main`): every push except a force push passes.
- File-system tricks around the native tools: hard links, a path replaced between the check and the access, Windows-specific path forms, and the path arguments of MCP tools.

For more cover: add `deny` rules or `dag.safety.extra` entries, put an external command guard in front of the tools (next section), or run in Docker or a VM.

## Putting a command guard in front of the tools

GraphAgent runs your PreToolUse hooks for the tool calls of child sessions too, before the tool's own permission request. A hook that answers `deny` stops the call: the tool does not run, the model receives `[Tool denied by hook] <reason>`, and the session goes on. That makes a hook the place for a command guard, a program that reads a shell command and refuses the dangerous ones.

GraphAgent does not bundle, download or distribute any guard, and its code does not refer to one. You install the guard yourself and wire it in.

### Configuration

Put it in your user-level hooks file, `hooks.json` in the config directory (usually `~/.config/graphagent/hooks.json`):

```json
{
  "PreToolUse": [
    {
      "matcher": "Bash",
      "hooks": [
        {
          "type": "command",
          "command": "/absolute/path/to/guard",
          "inputFormat": "claude-code",
          "timeout": 10,
          "onFailure": "block"
        }
      ]
    }
  ]
}
```

- Use the user-level file. It loads without a trust prompt, and a project cannot switch it off: `disableAllHooks` in a project's `hooks.json` or `hooks.local.json` only turns off that project's side, never your global hooks (#1325). Only `disableAllHooks` in your own global file turns the guard off.
- `inputFormat: "claude-code"` gives a guard written for Claude Code the names it expects (`Bash`, `tool_input.command`). The matcher uses Claude's tool names (`Bash` for the shell tool) whichever input format you pick.
- Write `command` as an absolute path. A bare name is looked up on the `PATH` of the GraphAgent process, which can be shorter than your shell's. With the default failure behaviour, a guard that cannot be started is the same as no guard.
- `timeout` is in seconds (default 30). Give the guard enough time to answer.
- `onFailure` decides what a broken guard means. By default a hook that cannot start, times out, exits with a code other than 0 or 2, or prints output that cannot be parsed only produces a warning, and the call runs (fail-open). `"onFailure": "block"` refuses the call instead (fail-closed). A user-level hook runs for every session of yours, so with `block` a broken guard also refuses the shell commands of your own session. Choose on purpose, and test the guard once by running a command it should refuse.

Hook files reload when they change.

### What the guard is told

The tool events of an unattended session (`PreToolUse`, `PostToolUse`, `PostToolUseFailure`) carry a `permission_mode` that matches the tier:

| Tier       | `permission_mode`                                                                                |
| ---------- | ------------------------------------------------------------------------------------------------ |
| `allow`    | `dontAsk`: nobody can be asked, so a guard that is unsure should deny.                           |
| `readonly` | `plan`: the session is read-only.                                                                |
| `ask`      | Not overridden: whatever the session had (`default`, or your configured `hookPermissions.mode`). |

The value replaces any `hookPermissions.mode` you configured, because under `allow` and `readonly` the tier decides what the session does. Your own session and a `task` subagent while DAG mode is off keep the mode they had. Child sessions also carry `agent_id` and `agent_type`.

Under `allow` and `readonly` no question reaches you, so a PermissionRequest hook never runs for an unattended session. Under `ask` it runs as before.

### What the guard's answer does

| Guard answers      | Effect                                                                                                                             |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `deny` (or exit 2) | The call does not run. The model gets `[Tool denied by hook] <reason>` and continues. In every tier.                               |
| `ask`              | `allow` and `readonly`: refused by SF-6, because there is nobody to ask. `ask`: the question reaches you, and your answer decides. |
| nothing, `allow`   | The call goes on to the normal permission path.                                                                                    |

When a DAG node's call is denied by a hook, GraphAgent records it on the node like a safety denial: a `NodeSafetyDenied` event with rule `HOOK`, the permission key of the tool, and the hook's reason cut to 200 characters. The reason is stored with the node, so a guard should not echo secrets from the command into it. It shows in the `inspect` status of the node, in the coverage section as `safety denied: HOOK`, and in the denial counts of the node and workflow reports, so the main agent learns the call was refused. It creates no wake of its own. This holds in all three tiers. It also holds when the guard fails closed (`onFailure: "block"`). A `task` subagent has no node row, so only the tool result carries the denial. A confirmation you refuse yourself is not recorded as a safety denial.

### Example: dcg

[dcg](https://github.com/Dicklesworthstone/destructive_command_guard) (Destructive Command Guard) is one guard that speaks this protocol. It is an example, not a recommendation or a dependency. What follows comes from its own documentation (v0.16.0 when this guide was written); read its current documentation before you rely on any of it.

- You install it yourself, from its project, and run `command -v dcg` for the absolute path to put in `command`. GraphAgent installs and downloads nothing.
- Its default rule packs cover destructive commands: recursive deletes, `git reset --hard`, `git clean -f`, `git push --force`. Publishing and pushes to the default branch are outside them; they need packs you switch on yourself (it documents `package_managers` and `strict_git` among them), so check its pack list for what you need.
- It judges the command text. It does not know your project boundary and it does not look at file reads.
- When it cannot decide within its time limit it answers `ask`. When the input says `permission_mode` is `dontAsk` or `bypassPermissions`, it denies instead. That is why the `allow` tier reports `dontAsk`. If it asks anyway, SF-6 refuses the call.
- Its denial message can carry an allow-once code, and its documentation lists other escape hatches meant for a person. An agent that reads the message can run the command that grants the exception. The project says itself that it assumes a well-intentioned but fallible agent. Do not treat it as a security boundary.
- Its license is MIT with an additional rider that restricts certain parties. Read the license in its repository and check that it allows your use before you install it.

## Limits that stay

- None of the tiers, the safety list or a guard is a sandbox. Use Docker or a VM when you need isolation.
- The `ask` tier gives you the decision, not protection from the decision: an approved command runs with your rights.
- `readonly` narrows tools. A shell redirection can still write through an allowed read-only command, and an MCP tool you allowed by name does what that tool does.
- A guard sees command text. What it cannot see through (a script's contents, a spelling it does not model) it cannot stop.
- A guard that fails open lets calls through when it breaks. A guard that fails closed refuses every shell command, yours included, when it breaks.
