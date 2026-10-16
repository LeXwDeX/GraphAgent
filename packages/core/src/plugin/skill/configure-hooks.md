<!-- Built-in skill registered in packages/core/src/plugin/skill.ts. -->

# Configuring OpenCode hooks

Hooks run a command, MCP tool, HTTP request, prompt, or agent at a local conversation boundary. Load this reference before authoring or migrating hooks. The host's active tools and configuration determine which operations exist in the current session.

## Sources and trust

The file chain is `${Global.Path.config}/hooks.json`, project `.opencode/hooks.json`, then the separate worktree's `.opencode/hooks.json`. The global path follows XDG configuration (usually `~/.config/opencode`). Event arrays append across layers. Matching foreground handlers run concurrently; identical handlers matched more than once run once per trigger. Files reload after about two seconds of polling plus debounce.

Use top-level event keys. A legacy `{ "hooks": { ... } }` wrapper is accepted. `.claude/settings*.json` and deprecated OpenCode `settings.json` hook fields are not loaded as hook sources; `/import-claude-hooks` migrates them. Skill and agent frontmatter can supply scoped `hooks`; they become active when that skill or agent is actually selected. Plugin contributions retain their real plugin provenance. A project cannot label itself as a trusted user or plugin source.

`requireTrust: true` or `OPENCODE_HOOKS_REQUIRE_TRUST=1` enables the directory trust gate. Only the global hooks file can use `allowUntrusted: true`; project/worktree files cannot opt themselves out. `allowedHttpHookUrls` and `httpHookAllowedEnvVars` constrain HTTP destinations and environment interpolation when configured.

```json
{
  "PreToolUse": [
    {
      "matcher": "Bash",
      "hooks": [{ "type": "command", "command": "./scripts/check.sh", "timeout": 10 }]
    }
  ]
}
```

## Events (33 total)

These are recognized protocol names. An event requires its corresponding product operation: the host does not create a teammate system or permission classifier merely to emit a hook. `TeammateIdle` has no local teammate-idle producer; `PermissionDenied` applies to an automatic classifier denial, and this product has no such classifier. Do not reinterpret a native permission-rule denial as that event. Preserve and report these applicability limits when importing.

| Events                                            | Boundary and principal input                                                                                          | Matcher                |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| `PreToolUse`, `PostToolUse`, `PostToolUseFailure` | Before execution, after success, after failure; `tool_name`, `tool_input`, `tool_use_id`, plus result/error           | Tool name              |
| `PermissionRequest`, `PermissionDenied`           | Permission dialog admission / classifier denial                                                                       | Tool name              |
| `PostToolBatch`                                   | A completed provider batch; `tool_calls`                                                                              | None                   |
| `UserPromptSubmit`                                | User input before admission; `prompt`                                                                                 | None                   |
| `UserPromptExpansion`                             | Expanded slash-command content; command name/arguments/content                                                        | Command name           |
| `SessionStart`                                    | `startup`, `resume`, `fork`, or `compact`; current model/agent, custom title when known; resume/fork response metrics | `source`               |
| `SessionEnd`                                      | A local session exit, switch, or deletion; `reason`                                                                   | `reason`               |
| `Stop`, `StopFailure`                             | Clean assistant completion / API failure; `stop_hook_active`, last response or displayed error; active tasks on Stop  | None / error category  |
| `SubagentStart`, `SubagentStop`                   | Task or DAG worker lifecycle; parent `session_id`, child `agent_id`, `agent_type`                                     | Agent type             |
| `PreCompact`, `PostCompact`                       | Before compaction / after successful summary                                                                          | `trigger`              |
| `TaskCreated`, `TaskCompleted`                    | Actual todo/task creation and completion                                                                              | None                   |
| `TeammateIdle`                                    | No corresponding teammate-idle business operation                                                                     | None                   |
| `Elicitation`, `ElicitationResult`                | MCP request / response; server, request and action/content                                                            | Server name            |
| `Setup`                                           | Local initialization or maintenance                                                                                   | `trigger`              |
| `Notification`                                    | Host notification                                                                                                     | Notification type      |
| `ConfigChange`                                    | Relevant configuration changes before applying them                                                                   | `source`               |
| `WorktreeCreate`, `WorktreeRemove`                | Worktree creation/removal                                                                                             | None                   |
| `InstructionsLoaded`                              | Actual instruction-file loads; file, memory type and load reason. OpenCode includes its AGENTS.md equivalents         | Load reason            |
| `CwdChanged`, `DirectoryAdded`                    | Persisted session directory move / admitted additional directory                                                      | None / source          |
| `FileChanged`                                     | A watched external file changes                                                                                       | Path basename          |
| `PreModelSwitch`, `PostModelSwitch`               | Before requested switch / after switch or saved-model restoration; model IDs, source and context/cache cost           | Canonical target model |
| `MessageDisplay`                                  | Text displayed to a user; turn/message IDs, chunk index, delta and final marker                                       | None                   |

Matchers are case-sensitive: exact names, pipe-separated alternatives, or regular expressions. Empty/omitted/`*` matches every target. Built-in tool matchers use Claude names such as `Bash`, `Read`, `Write`, and `Agent`, independently of the input naming adapter. A matcher is ignored when the event has no target. For a custom model with no canonical Claude name, model-switch hooks run without matcher filtering.

All event inputs include `hook_event_name`, `session_id`, `cwd`, and a materialized JSONL `transcript_path` when a session exists. The file reflects actual persisted history, including native V2 history; a newly created session can have an empty transcript. Permission mode and agent metadata are included when available. `inputFormat: "claude-code"` is a command-only adapter for built-in tool names and argument keys; native OpenCode naming remains the default. It does not translate an arbitrary custom tool schema.

## Handler configuration

| Type       | Required action                    | Notes                                                                                                        |
| ---------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `command`  | `command`; optional `args`         | With `args`, execute the argv directly. Without it, use the configured/default shell. JSON input is on stdin |
| `http`     | `url`                              | One POST per trigger; optional `headers`, `allowedEnvVars`                                                   |
| `mcp_tool` | `server`, `tool`; optional `input` | Validate against the real MCP schema; `${field}` templates read envelope fields                              |
| `prompt`   | `prompt`                           | One model evaluation, optionally `model`; returns `{ok, reason?, impossible?}`                               |
| `agent`    | `prompt`                           | Bounded agent evaluation using exposed tools, optionally `model`; same decision response                     |

The legacy `mcp` form with `command: "mcp__server__tool"` is an alias. Legacy HTTP/prompt/agent `command` action fields remain accepted; use `url` or `prompt` for new definitions. `$ARGUMENTS` in evaluator prompts is replaced with the serialized input; otherwise input is appended.

SessionStart and Setup allow command and MCP handlers; unavailable MCP connections are skipped at early startup. PermissionRequest permits command, HTTP, MCP and prompt handlers, but only command/HTTP output can return its nested permission decision. Tool/prompt/batch/Stop/SubagentStop/task/classifier events support all five kinds. Remaining events support command, HTTP and MCP. A recognized type does not make it valid on every event.

Optional fields:

- `timeout`: positive seconds. Command/HTTP/MCP default to 600, except UserPromptSubmit and model-switch events (30), MessageDisplay (10), and SessionEnd (1.5; `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS` may override). Prompt defaults to 30; agent to 60.
- `statusMessage`: visible progress while the handler runs.
- `if`: tool/permission condition, using permission-rule patterns such as `Bash(npm test *)`. Non-tool events cannot satisfy a tool condition. This is a filter, not permission authorization.
- `once`: scoped skill/session lifetime; success removes/suppresses the registration, failure releases it for retry. Agent hooks do not gain once semantics.
- `onFailure`: `continue` or `block`, for synchronous command/HTTP execution failures. Background output cannot retroactively decide the triggering operation.
- `continueOnBlock`: prompt evaluator option for PreToolUse feedback.
- `shell`: `bash` or `powershell` for command hooks. `options` supplies command plugin-option environment variables.
- `async` and `asyncRewake`: command hooks only; see below.

Command hooks receive the host environment plus their session's exports. `CLAUDE_PROJECT_DIR`, plugin-root/data variables, and the allowed `CLAUDE_ENV_FILE` lifecycle interface are supplied where applicable. A SessionStart environment file affects later commands in that session; it does not add arbitrary HTTP headers. HTTP environment expansion is restricted by its allowlists.

## Output and consumer behavior

Return one JSON object on stdout for structured controls; keep diagnostics on stderr. Use the matching `hookSpecificOutput.hookEventName`. An explicitly different event name cannot control this event. Invalid structured output is reported and ignored unless its configured failure policy blocks.

Exit 0 permits normal processing. Exit 2 has event-specific blocking semantics. PermissionRequest exit 2 leaves the normal dialog path available; TaskCompleted uses exit 2 to veto completion. Observation-only events cannot undo completed work. PreModelSwitch timeout blocks a requested switch. Other execution failures normally continue unless the event or `onFailure` says otherwise.

| Event                                 | Effective output                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PreToolUse`                          | `permissionDecision` (`allow`, `deny`, `ask`, `defer`), reason, complete `updatedInput` replacement, additional context. Replacement is revalidated and native/configured deny still wins. `continue:false` takes precedence. Defer is valid for a sole tool call in noninteractive main conversation and preserves the original call for explicit resume |
| `PermissionRequest`                   | Nested `decision:{behavior,updatedInput?,updatedPermissions?,message?,interrupt?}`. Rewritten arguments are revalidated before side effects. Permission updates respect their destination                                                                                                                                                                 |
| `UserPromptSubmit`                    | Block/stop, additional context, session title, and `suppressOriginalPrompt` with replacement context                                                                                                                                                                                                                                                      |
| `UserPromptExpansion`                 | Block or context for the expanded command                                                                                                                                                                                                                                                                                                                 |
| `SessionStart`                        | Additional context, `initialUserMessage`, `sessionTitle`, `watchPaths`, `reloadSkills`. An initial user message passes ordinary prompt admission and runs as a separate first turn; supplied input waits behind it, including after defer/restart                                                                                                         |
| `SubagentStart`                       | Additional context delivered to the actual child                                                                                                                                                                                                                                                                                                          |
| `PostToolUse`                         | Additional context and supported `updatedToolOutput` / `updatedMCPToolOutput`; the next model sees the validated replacement                                                                                                                                                                                                                              |
| `PostToolUseFailure`, `PostToolBatch` | Supported model feedback after the failure or completed batch                                                                                                                                                                                                                                                                                             |
| `Stop`, `SubagentStop`                | Block or additional context can continue the turn; `continue:false` ends the chain. Consecutive hook-only continuations are capped at eight                                                                                                                                                                                                               |
| `PreCompact`                          | Block before summary; a failed/aborted summary has no PostCompact event                                                                                                                                                                                                                                                                                   |
| `ConfigChange`                        | Block before applying a watched configuration change                                                                                                                                                                                                                                                                                                      |
| `TaskCreated`, `TaskCompleted`        | Veto the actual task mutation under their event-specific decision rules                                                                                                                                                                                                                                                                                   |
| `Elicitation`, `ElicitationResult`    | Action: `accept`, `decline`, or `cancel`; accepted `content`. Discard top-level `reason`, `systemMessage`, and `continue`.                                                                                                                                                                                                                                |
| `WorktreeCreate`                      | Command stdout's final nonempty line supplies the created path; failure prevents fallback creation                                                                                                                                                                                                                                                        |
| `WorktreeRemove`                      | The hook owns removal; failure is surfaced while an unremoved path remains                                                                                                                                                                                                                                                                                |
| `CwdChanged`, `FileChanged`           | Supported `watchPaths` and session environment updates                                                                                                                                                                                                                                                                                                    |
| `PreModelSwitch`                      | `allow`, `deny`, `ask` with reason. Only an interactive `/model` command can ask; other surfaces refuse. No durable model change occurs on refusal                                                                                                                                                                                                        |
| `PostModelSwitch`                     | Plain stdout or additional context for the next request on the final target model, including `source:resume`. Wait up to five seconds at request time; late output waits for a later request                                                                                                                                                              |
| `MessageDisplay`                      | `displayContent`, including an empty string to hide text. Copy/render use it; canonical transcript and model history remain unchanged                                                                                                                                                                                                                     |

For synchronous hooks, supported `systemMessage` output is a user-facing warning, separate from model context. Ordinary `async` command-hook results are different: both `systemMessage` and `additionalContext` are delivered only in the next model request and are not shown as user warnings. Supported `terminalSequence` output reaches terminal clients. Do not use accepted but unconsumed aliases such as `displayMessage`, `compactSummary`, or `customSummary` in new hooks. Use `displayContent` for display changes. `suppressOutput` concerns hook-output presentation, not canonical assistant text.

`updatedPermissions` supports session memory, `localSettings` (`.opencode/permissions.local.json`), `projectSettings` (project OpenCode configuration), and `userSettings` (existing OpenCode user configuration). It preserves unrelated settings. `bypassPermissions` requires a separate explicit startup capability; a hook cannot grant itself that capability or override native/configured deny. There is no automatic permission classifier mode. Never map a local destination into a shared project file or write Claude configuration as a substitute.

## Async delivery and cleanup

`async:true` returns immediately. When the command exits, its `additionalContext` and `systemMessage` are queued for model input on the next actual request; neither field is shown as a user warning. Print the JSON response alone on stdout (pretty-printed JSON may span lines) or put one complete JSON object on a single line among other stdout logs. A field with the wrong value type is dropped without discarding valid fields. Ordinary async commands have no timeout after background execution starts.

`asyncRewake:true` also implies background execution, but its command remains subject to the configured timeout. Only exit code 2 starts a wake; exit-0 output waits for a real later request. SessionEnd never rewakes.

Callbacks belong to the originating session and instance. New user input, cancellation, session end, and disposal invalidate relevant stale continuations. A process crash loses in-memory background work. Stop scripts should honor `stop_hook_active` and be idempotent. Polling inside a script does not cause repeated model requests while it waits.

## Scoped registration and verification

The session hook API is `POST /session/{sessionID}/hook`, `GET` on the same path, and `DELETE /session/{sessionID}/hook/{hookID}`. Registrations are in memory and disappear on session cleanup, instance disposal, or restart. They join the same matching and result pipeline as file hooks.

Before writing, inspect the target file and append only the intended matcher block. Preserve sibling events, unknown fields, and existing user content. Existing user authorization to create/write the hook is sufficient; ask only for missing choices. After writing, parse and reread the file, allow the polling/debounce interval, and inspect Active Hooks or the session registration API. That listing proves loading only. Use a controlled operation and an independent observable result to verify execution and its consumer; never infer full compatibility from an accepted schema or event name.
