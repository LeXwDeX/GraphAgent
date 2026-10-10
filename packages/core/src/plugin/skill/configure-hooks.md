<!--
  Built-in skill. Name and description are registered in code at
  packages/core/src/plugin/skill.ts (ConfigureHooksDescription).
  This body is the model-facing configuration reference.
-->

# Configuring OpenCode hooks

Hooks run a command, MCP tool, HTTP endpoint, prompt, or agent when an event
occurs. Configure them in `hooks.json`; `opencode.json` and Claude's settings
files are not hook sources. `/import-claude-hooks` migrates Claude settings.

## Files, merge, reload, and trust

| Scope    | File                               | Behavior                                                                                                                                            |
| -------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Global   | `${Global.Path.config}/hooks.json` | Shared across projects; follows the XDG config directory (commonly `$XDG_CONFIG_HOME/opencode/hooks.json`, usually `~/.config/opencode/hooks.json`) |
| Project  | `.opencode/hooks.json`             | Project configuration                                                                                                                               |
| Worktree | `<worktree>/.opencode/hooks.json`  | Loaded when the worktree directory differs from the project directory                                                                               |

Layers concatenate in global, project, then worktree order; entries are not
overrides. Entries inside each event retain file order. All three files are
watched and reload after a change (about 2 seconds polling plus debounce); a
restart is normally unnecessary. Invalid entries are logged and skipped while
valid siblings remain active. `settings.json` and `.claude/settings*.json`
hook fields are ignored.

Optional top-level trust controls:

- `requireTrust: true` enables the hook trust gate for the merged chain (also
  enabled by `OPENCODE_HOOKS_REQUIRE_TRUST=1`). Hooks are skipped for an
  untrusted working directory.
- `allowUntrusted: true` opts out of that gate only when declared in the global
  hooks file. Project/worktree values are ignored; a repository cannot grant
  itself trust. With neither setting, there is no trust gate.

Example:

```json
{
  "PreToolUse": [
    { "matcher": "Bash", "hooks": [{ "type": "command", "command": "./scripts/check.sh", "timeout": 10 }] }
  ],
  "SessionStart": [{ "matcher": "startup", "hooks": [{ "type": "command", "command": "./scripts/welcome.sh" }] }]
}
```

## Events, input, and matcher targets

Every handler receives a JSON envelope with `hook_event_name`, `session_id`,
`transcript_path`, and `cwd`; `transcript_path` is currently an empty string.
When available it also has `permission_mode` (`plan` or `default`),
`agent_id`, and `agent_type`. Event-specific fields below use the actual
snake_case names in command stdin and HTTP request bodies. Optional values are
omitted unless noted. `inputFormat: "claude-code"` changes only the documented
tool names/argument keys for command hooks; see below.

| Event                | When it fires; event-specific fields                                                                                                                                                                                    | Matcher target      |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| `PreToolUse`         | Before a dispatched tool call; `tool_use_id?`, `tool_name`, `tool_input`                                                                                                                                                | `tool_name`         |
| `PostToolUse`        | After a successful tool call; `tool_use_id?`, `tool_name`, `tool_input`, `tool_response`                                                                                                                                | `tool_name`         |
| `PostToolUseFailure` | After a non-interruption tool failure (aborts do not emit this event); `tool_use_id?`, `tool_name`, `tool_input`, `error`, `is_interrupt?` (accepted, not currently populated)                                          | `tool_name`         |
| `PermissionRequest`  | When a tool needs permission; `tool_use_id?`, `tool_name`, `tool_input`, `permission_suggestions?`                                                                                                                      | `tool_name`         |
| `PermissionDenied`   | When a tool call is denied; `tool_use_id?`, `tool_name`, `tool_input`, `reason`                                                                                                                                         | `tool_name`         |
| `Setup`              | Once per instance bootstrap; `trigger` (`startup`), with empty `session_id`                                                                                                                                             | `trigger`           |
| `SessionStart`       | For a new top-level session only; currently `source` is always `startup` (other values in the accepted type are not emitted), with `session_id` set                                                                     | `source`            |
| `SessionEnd`         | On session deletion only; currently `reason` is always `delete` (clear/logout/CLI exit do not emit it)                                                                                                                  | `reason`            |
| `Stop`               | When the assistant finishes a turn cleanly; `stop_hook_active`, `last_assistant_message?`                                                                                                                               | none                |
| `StopFailure`        | When a turn ends with an error; `stop_hook_active`, `error`, `last_assistant_message?`                                                                                                                                  | none                |
| `SubagentStart`      | When the task tool starts a subagent; `agent_id` (child ID), `agent_type`; `session_id` is the parent                                                                                                                   | `agent_type`        |
| `SubagentStop`       | After a foreground task-tool child finishes cleanly; `stop_hook_active`, `agent_id`, `agent_type`. `session_id` is the parent; `agent_id` identifies the child. `agent_transcript_path` is accepted but not populated.  | `agent_type`        |
| `UserPromptSubmit`   | On prompt admission (async-hook reminders skip this event to prevent recursion); `prompt`                                                                                                                               | none                |
| `PreCompact`         | Before context compaction; `trigger` (`manual`/`auto`), `custom_instructions` (empty when absent)                                                                                                                       | `trigger`           |
| `PostCompact`        | After compaction; `trigger?`, `compact_summary?`, `custom_instructions?`                                                                                                                                                | `trigger`           |
| `TaskCreated`        | When the task tool creates a task; `task_id`, `task_title`. `task_description` is accepted but not populated.                                                                                                           | none                |
| `TaskCompleted`      | After the task tool child prompt succeeds; `task_id`, `task_title`, `result`                                                                                                                                            | none                |
| `Elicitation`        | For supported MCP `elicitation/create` form requests with a valid form schema, session, and Question UI; `prompt`, `schema`. Unsupported modes/schemas or missing interaction/session context decline before this hook. | none                |
| `ElicitationResult`  | After that form flow resolves; `result` on accept or `cancelled` on decline/dismiss/timeout                                                                                                                             | none                |
| `Notification`       | For current internal permission-ask and MCP-elicitation attention notifications; `message`, `title?`, `notification_type?`                                                                                              | `notification_type` |
| `ConfigChange`       | When a watched `hooks.json` layer reloads (not arbitrary configuration changes); `config_path`, empty `session_id`                                                                                                      | none                |
| `WorktreeCreate`     | After a worktree boots successfully; `path?`, `branch?`                                                                                                                                                                 | none                |
| `WorktreeRemove`     | Before registered-worktree cleanup, including a stale or missing path; it does not certify successful removal; `path?`, `branch?`                                                                                       | none                |
| `InstructionsLoaded` | When instruction content is loaded; `path?`, `content?`                                                                                                                                                                 | none                |
| `CwdChanged`         | When OpenCode switches into a newly booted worktree, not an arbitrary shell directory change; `old_cwd`, `new_cwd`, empty `session_id`                                                                                  | none                |
| `FileChanged`        | After successful internal `write`, `edit`, `apply_patch`, `multiedit`, or `patch` tool operations; `path` (absolute), `change_type` (`add`, `change`, `delete`). It is not an external filesystem watcher.              | basename of `path`  |

`matcher` supports case-insensitive exact names, pipe-separated names, `*`, or
regex. Its target is event-specific: the five tool/permission events use the
tool name; `SessionStart`, `SessionEnd`, `Setup`, `PreCompact`/`PostCompact`,
`Notification`, `SubagentStart`/`SubagentStop`, and `FileChanged` use the
target shown above. For `FileChanged`, match a basename such as `package.json`,
not the full path; its envelope `path` is absolute, and a rename can report the
removed path and added destination separately. When the target is `none`, a
configured matcher is ignored and every group runs (including `Stop`); omit it
for clarity. An omitted
matcher or `"*"` matches all values of a supported target.

`TeammateIdle` is unsupported and silently skipped. The event type schema
accepts some fields that current producers do not populate; those are marked
above so a hook should not wait for them. `InstructionsLoaded` fires only for
local instruction files, once per path per instance, with content truncated
to the first 32,768 JavaScript string code units; remote instruction URLs do
not fire it. Task and subagent events come from the task-tool workflow; background promotion does not mean the child
has stopped. `Notification` is currently emitted for permission asks and
supported MCP elicitation attention; it does not itself send an OS notification.

## Hook types and configuration fields

All five types are implemented. Each handler has a positive finite `timeout`
in seconds (default 60); timeout cancels the running process/request. `type`
is required. Provide the matching action: `command` for command and MCP,
`url` for HTTP, `prompt` for prompt and agent. For compatibility, HTTP also
accepts `command` as its URL and prompt/agent accept `command` as their text.

| Field            | Applies to                                              | Meaning and limits                                                                                                                                                                                             |
| ---------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `command`        | command, MCP; legacy action alias for HTTP/prompt/agent | Shell command, `mcp__<server>__<tool>` name, or legacy URL/prompt text.                                                                                                                                        |
| `url`            | HTTP                                                    | POST target.                                                                                                                                                                                                   |
| `prompt`         | prompt, agent                                           | Prompt text or agent goal.                                                                                                                                                                                     |
| `headers`        | HTTP                                                    | Request headers.                                                                                                                                                                                               |
| `allowedEnvVars` | HTTP                                                    | Expand `$NAME` / `${NAME}` in headers only for listed, set names. Unlisted or unset names become empty; when omitted, header values remain literal.                                                            |
| `shell`          | command                                                 | `bash` or `powershell`; must be installed. Omitted uses `/bin/sh` on POSIX or `cmd.exe` on Windows.                                                                                                            |
| `inputFormat`    | command                                                 | `opencode` (default) or `claude-code`; naming adapter described below.                                                                                                                                         |
| `statusMessage`  | all                                                     | Logged before dispatch; does not show UI progress.                                                                                                                                                             |
| `once`           | all                                                     | Run this loaded entry once per session, including async/concurrent triggers. Reload creates fresh entries. Dynamic session registrations also support group-level `once`, claimed only after conditions match. |
| `if`             | all; effective only for tool/permission events          | Condition such as `Bash(npm install *)` or `Edit(*.ts)`. Empty, `*`, and malformed conditions fail open. On non-tool events it is ignored.                                                                     |
| `async`          | all                                                     | Run in a background fiber. Its result cannot affect the current trigger's permission, block, or input decision. Work is process-local and is not persisted across restart.                                     |
| `asyncRewake`    | paired with `async`                                     | Admit useful completion feedback into the originating session. It is inert without `async`; `SessionEnd` and missing session IDs cannot rewake. Details below.                                                 |
| `options`        | command                                                 | Export each value as `CLAUDE_PLUGIN_OPTION_<KEY>` containing its JSON serialization.                                                                                                                           |
| `__sourceDir`    | runtime metadata                                        | Injected by OpenCode; do not configure it. It identifies the declaring directory for root and data-path resolution.                                                                                            |

Agent hooks have `read_file`, `list_dir`, `grep`, and restricted `bash` tools.
That `bash` executes validated installed utilities directly, without a shell;
interpreters, shell composition, and project-controlled PATH commands are
unavailable. On Windows use the file tools.

| Type      | Input / result protocol                                                                                                                                                                                      | Failure behavior                                                                                                             |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `command` | JSON envelope on stdin; exit 0 parses JSON stdout; exit 2 blocks with stderr; plain-text exit-0 stdout is model context only for `UserPromptSubmit` / `SessionStart`.                                        | Other nonzero exit, spawn failure, or timeout logs and allows the flow to continue.                                          |
| `mcp`     | Calls the named `mcp__<server>__<tool>` with the full envelope as tool arguments; parses the first text content item as JSON output.                                                                         | Missing tool, no text/invalid JSON, MCP error, or timeout logs and allows the flow to continue.                              |
| `http`    | POSTs the full envelope as JSON; parses a 2xx response body as JSON output.                                                                                                                                  | Non-2xx blocks. Network failure, missing HTTP service, or timeout logs and allows the flow to continue.                      |
| `prompt`  | Sends hook prompt as system message and envelope JSON as user input; requests structured hook output using OpenCode's configured default model, not the session model.                                       | Missing provider/auth, unsupported OpenAI OAuth, generation/schema failure, or timeout logs and allows the flow to continue. |
| `agent`   | Sends prompt and envelope to OpenCode's configured default model with read-only inspection tools and `synthetic_output` for the final hook result. Up to 200 model turns, but default timeout is 60 seconds. | Missing final output, missing services, OAuth, model failure, or timeout logs and allows the flow to continue.               |

### Command stdin and Claude Code naming

Command stdin is the event envelope above. Exit code 0 is success; JSON stdout
is parsed as hook output. Exit code 2 blocks and stderr supplies the reason.
Other exit codes and timeouts are warnings; their stdout control fields are
ignored. Plain-text exit-0 stdout is injected as context only for
`UserPromptSubmit` and `SessionStart`.

`inputFormat: "claude-code"` adapts command stdin and PreToolUse `updatedInput`
for six known built-ins only: `bash`/`read`/`write`/`edit`/`grep`/`glob` become
`Bash`/`Read`/`Write`/`Edit`/`Grep`/`Glob`; known argument keys such as
`filePath`→`file_path`, edit's `oldString`→`old_string`, and grep's
`include`→`glob` are translated. Other tools, including MCP/custom tools, pass
through unchanged; emit native keys when rewriting those tools. This is naming
compatibility, not full Claude Code behavior or output compatibility.

`${CLAUDE_PLUGIN_ROOT}` expands to the directory containing the declaring
hooks file. `${CLAUDE_PLUGIN_DATA}` expands to a path under
`${Global.Path.data}/hooks/` with an identifier derived from that directory;
the script may need to create it. Both values are also exported as environment
variables; `CLAUDE_PROJECT_DIR` contains the hook execution directory (`cwd`).
Command hooks inherit the host process environment and run with its OS
permissions. `options` values are serialized into `CLAUDE_PLUGIN_OPTION_<KEY>`
variables (keys uppercased, non-alphanumeric characters replaced with `_`).
`${user_config.<key>}` interpolates an option directly into the command (strings unchanged, other values serialized as JSON). Unknown or
unresolved templates remain unchanged for the shell to handle. Quote paths
and option values appropriately for the chosen shell.

## Hook output: accepted fields and actual effects

Handlers may return a JSON object with these top-level fields:

| Field                | Runtime effect / limit                                                                                                                                                                                |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `continue: false`    | Stops prompt admission/continuation where the event consumer honors it; it takes precedence over a Stop hook's request to continue.                                                                   |
| `stopReason`         | Used as the reason when continuation is stopped.                                                                                                                                                      |
| `decision: "block"`  | Requests a block with `reason` (or a generic reason), where the event caller honors it. `"approve"` does not grant tool permission; use `hookSpecificOutput.permissionDecision` on permission events. |
| `reason`             | Block explanation for `decision: "block"`.                                                                                                                                                            |
| `systemMessage`      | Logged, and delivered as session feedback by consumers that land hook system messages.                                                                                                                |
| `suppressOutput`     | Accepted for compatibility; no-op. Hook stdout is not shown directly in the UI.                                                                                                                       |
| `hookSpecificOutput` | Event-tagged object below. The runtime aggregates supported fields by property; the tag does not make an unsupported field effective.                                                                 |

Supported `hookSpecificOutput` fields:

- `hookEventName`: conventional tag (for example `PreToolUse`); it does not
  override the actual triggering event.
- `permissionDecision`: `allow`, `deny`, or `ask`; consumed by
  `PreToolUse`/`PermissionRequest`. Most restrictive wins (`deny` > `ask` >
  `allow`). `ask` always asks the user; `permissionDecisionReason` supplies
  its explanation. On `PreToolUse`, `ask` shows the proposed input, including
  any `updatedInput`. On a forced ask handled by `PermissionRequest`, `deny`
  may reject the request; `allow` is ignored and logged.
- `updatedInput`: changes arguments before a `PreToolUse` tool runs. It cannot
  change a tool after execution or change non-tool events.
- `additionalContext`: model-facing context where the triggering event's
  consumer supports it. For post-tool events it is feedback after the action
  and cannot undo that action; repeated context may be deduplicated.
- `permissionDecisionReason`: reason shown with a permission decision.

The synchronous caller determines which aggregate results change control flow;
the same schema does not mean every event consumes every field:

| Event(s)                                                                                                                                           | What the caller actually consumes                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PreToolUse`                                                                                                                                       | `blocked` or `permissionDecision: deny` denies; `ask` forces a user dialog where available (the task-tool path degrades it to deny); `allow` does not bypass the tool's normal permission checks. `updatedInput` shallow-merges into tool args before execution; `continue: false` stops the call/turn. `additionalContext` is added to tool feedback if execution continues. `systemMessage` is logged. |
| `PermissionRequest`                                                                                                                                | `blocked`, `continue: false`, or `permissionDecision: deny` rejects the ask; `allow` approves only a normal ask, not a hook-forced ask. `ask` has no extra effect because the user is already being asked. `systemMessage` is logged; `additionalContext` is not injected.                                                                                                                               |
| `PermissionDenied`                                                                                                                                 | Fired after a permission-rule denial; only `systemMessage` is logged. Other output cannot reverse the denial or add model feedback.                                                                                                                                                                                                                                                                      |
| `UserPromptSubmit`                                                                                                                                 | `blocked` or `continue: false` stops the prompt before model admission. If admitted, `additionalContext` and `systemMessage` are added as synthetic model-visible parts; on a blocked prompt, `systemMessage` is logged only.                                                                                                                                                                            |
| `SessionStart`                                                                                                                                     | `additionalContext` is queued for the session's next prompt; `systemMessage` is logged. Current producer fires only for top-level startup, with empty transcript path.                                                                                                                                                                                                                                   |
| `PostToolUse`, `PostToolUseFailure`, `FileChanged`                                                                                                 | Supported context, system message, block reason, and stop reason are appended to the completed tool result/error as model feedback. They cannot undo a successful side effect. `PostToolUse` `continue: false` ends the turn after recording its result.                                                                                                                                                 |
| `PreCompact`                                                                                                                                       | `blocked` cancels compaction. The caller records `systemMessage`; it ignores `additionalContext`. `continue: false` is not a compaction control.                                                                                                                                                                                                                                                         |
| `PostCompact`                                                                                                                                      | `systemMessage` is logged. `additionalContext` and display/summary fields are not injected by this caller.                                                                                                                                                                                                                                                                                               |
| `Stop`                                                                                                                                             | A clean-turn `blocked` result requests another model turn; `continue: false` prevents that continuation. Context and system messages are included in turn feedback. Continuation is capped at five.                                                                                                                                                                                                      |
| `StopFailure`                                                                                                                                      | Error-turn feedback records `additionalContext` and `systemMessage`; the synchronous block reason is not separately injected because an errored turn cannot continue. A completion callback may rewake the originating session.                                                                                                                                                                          |
| `SubagentStop`                                                                                                                                     | A foreground task-tool child is re-prompted when blocked, unless `continue: false`; at most five continuations. `session_id` is the parent session and `agent_id` is the child. `systemMessage` is logged; `additionalContext` is not separately injected.                                                                                                                                               |
| `TaskCreated`, `TaskCompleted`, `SubagentStart`                                                                                                    | The task-tool caller logs `systemMessage`; it ignores block, continuation, and context output.                                                                                                                                                                                                                                                                                                           |
| `Elicitation`                                                                                                                                      | A blocking result declines the supported form request before showing the Question UI. `systemMessage` is logged.                                                                                                                                                                                                                                                                                         |
| `ElicitationResult`, `Notification`, `Setup`, `SessionEnd`, `ConfigChange`, `CwdChanged`, `WorktreeCreate`, `WorktreeRemove`, `InstructionsLoaded` | These callers do not use hook output to alter the surrounding operation. Whether `systemMessage` or context is landed varies by caller and is not guaranteed model feedback.                                                                                                                                                                                                                             |

The schema also accepts `initialUserMessage`, `watchPaths`,
`updatedMCPToolOutput`, `displayMessage`, `compactSummary`, and `customSummary`
for compatibility, but OpenCode warns that they are unsupported and ignores
them. Use `additionalContext` for supported model feedback. Invalid JSON or
output shapes are logged and ignored. Prompt/agent hooks using OpenAI OAuth are
skipped with a warning; use a supported API-key provider.

## Transient session hooks

An HTTP client can register a hook for one existing session with `POST
/session/{sessionID}/hook`, list that session's registrations with `GET` on
the same path, and remove one by ID with `DELETE
/session/{sessionID}/hook/{hookID}`. A registration body has required `event`
and non-empty `hooks`, plus optional top-level `matcher` and `once`. Each hook
entry supports the normal handler fields, including optional `if` and its own
`once`; entry-level `once` removes the whole registration before its first
matching execution attempt, while hook-level `once` suppresses that handler
after its first execution attempt for the session. `if` is only evaluated on
tool/permission events.
These entries join the regular matcher and result-aggregation pipeline but are
held in process memory, scoped to the session and its OpenCode instance. They
are cleared after `SessionEnd` (currently deletion only), when the owning
instance directory is disposed, and on process restart. Keep the same host and
instance alive while relying on them. The **Active Hooks** file summary lists
the on-disk chain, not transient session registrations; use the session hook
list endpoint to inspect those.

## Create and verify

For a hook requested in ordinary conversation, load this skill, read the
relevant global/project/worktree files, and append to the existing event list
without overwriting sibling hooks. Choose the narrowest event and matcher;
use `if` only for a tool/permission event. Keep command stdout clean JSON when
returning hook controls (send diagnostics to stderr), and set a bounded timeout
with margin for expected completion.

After the final write, wait at least the 2-second polling interval plus the
500-millisecond debounce before ending the first Stop turn or treating the
change as reloaded. The **Active Hooks** block confirms loaded file
configuration only. Verify execution with a controlled trigger and an
independent, safe signal such as a temporary marker or test endpoint response;
do not infer execution from the listing alone.

### Async completion and `asyncRewake`

Use `async: true` when a handler may take time and should not hold up the
current hook trigger. OpenCode requires both flags (`async: true` and
`asyncRewake: true`) for a completion callback; `asyncRewake` by itself is
inert. Claude Code also has an `asyncRewake` field, but its behavior differs: it
implicitly runs it asynchronously and wakes on exit code 2, while OpenCode
requires both flags and can wake on exit-0 JSON `systemMessage` or other output
listed below. `asyncRewake: true` then delivers useful output only
after that handler has completely exited/settled; it does not poll or wake the
model while the handler is still running. A simple bounded poll can run inside
the command, for example up to the default 60-second timeout, then exit with a
result. The callback is in memory: it is lost if OpenCode exits, and it is
discarded if a newer non-hook prompt or session end makes a pending Stop
callback stale. For task-tool `SubagentStop`, `session_id` is the parent and
`agent_id` is the stopped child; an async rewake targets the parent session and
does not resume that child.

Completion feedback that can trigger a rewake is: exit code 2 stderr,
`systemMessage`, a `decision: "block"` with a `reason`,
`hookSpecificOutput.additionalContext`, or non-JSON plain text on exit 0 for
`UserPromptSubmit` / `SessionStart`. Permission decisions, `updatedInput`,
`stopReason`, and other fields do not by themselves trigger a rewake. The
completed output is wrapped in a synthetic system reminder and admitted into
the same session. In particular, valid JSON stdout with `systemMessage` on
exit 0 is completion feedback and rewakes. `SessionEnd` never rewakes, even if
output is present.

```json
{
  "Stop": [
    {
      "hooks": [
        {
          "type": "command",
          "command": "./scripts/poll-and-report.sh",
          "timeout": 60,
          "async": true,
          "asyncRewake": true
        }
      ]
    }
  ]
}
```

The script may poll for readiness within its timeout. On completion, emit a
useful JSON result such as `{"systemMessage":"The background check is ready."}`
to stdout and exit 0. The model receives that message only after the script
exits; do not use `asyncRewake` as a progress signal.

`Stop` is the clean end of an assistant turn; a blocking synchronous Stop hook
can request another turn. `StopFailure` is selected when the turn ended with
an error and does not drive that synchronous clean-turn continuation; an async
completion can still deliver useful feedback. Async Stop completions share a
maximum of five continuations in the hook chain. After a
rewake, subsequent Stop envelopes carry `stop_hook_active: true`; check this
flag and make the script idempotent or it can repeatedly block and consume
the full cap. `stop_hook_active` does not mean the session ended. `SessionEnd`
currently fires on session deletion only, clears session hook state, and
cannot deliver an async rewake.

## Migration

`/import-claude-hooks` reads Claude settings and offers each candidate for
review. Claude hook settings are not loaded directly. OpenCode's deprecated
`settings.json` hook fields are ignored and produce a warning. Preserve Claude
files and scripts unless the user explicitly asks to remove confirmed-unused
items.

Imported command hooks default to `inputFormat: "claude-code"`; other hook
types receive no envelope translation, so their behavior needs manual review.
Claude Code also supports an `asyncRewake` field, but its semantics differ:
that field implies background execution and wakes on exit code 2. OpenCode
requires both `async: true` and `asyncRewake: true`, and its callback can wake
for additional result types. Inspect each source hook's intended behavior and
explicitly adapt it; do not blindly copy the field or assume its implicit
async behavior. Preserve ordinary source `async` only after checking that its
OpenCode handler type and timeout behavior are appropriate. Claude's
`TeammateIdle` has no OpenCode equivalent and is skipped.
