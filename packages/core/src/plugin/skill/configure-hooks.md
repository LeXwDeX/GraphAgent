<!-- Built-in skill registered in packages/core/src/plugin/skill.ts. -->

# Configuring OpenCode hooks

Hooks run a command, MCP tool, HTTP request, prompt, or agent at a local conversation boundary. Load this reference before authoring or migrating hooks. The host's active tools and configuration determine which operations exist in the current session.

## Sources and policies

The file chain is `${Global.Path.config}/hooks.json`, project `.opencode/hooks.json`, then the separate worktree's `.opencode/hooks.json`. The global path follows XDG configuration (usually `~/.config/opencode`). Event arrays append across layers. Matching foreground handlers run concurrently; identical handlers matched more than once run once per trigger. Files reload after about two seconds of polling plus debounce.

Use top-level event keys. A legacy `{ "hooks": { ... } }` wrapper is accepted. `.claude/settings*.json` and deprecated OpenCode `settings.json` hook fields are not loaded as hook sources; `/import-claude-hooks` migrates them. Skill and agent frontmatter can supply scoped `hooks`; they become active when that skill or agent is actually selected. Plugin contributions retain their real plugin provenance. A project cannot label itself as a trusted user or plugin source.

Workspace trust gating and the built-in `/trust` command have been removed. Hooks from global, project, worktree, skill, and agent sources execute without a trust-list prerequisite. Legacy `requireTrust`, `allowUntrusted`, and `OPENCODE_HOOKS_REQUIRE_TRUST` values are ignored. Existing `trusted-workspaces.json` files are neither read nor modified. Tool permissions, `allowedHttpHookUrls`, and `httpHookAllowedEnvVars` retain their existing behavior.

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

All event inputs include `hook_event_name`, `session_id`, `cwd`, and a materialized JSONL `transcript_path` when a session exists. The file reflects actual persisted history, including native V2 history; a newly created session can have an empty transcript. When a session exists, the envelope also carries `prompt_id` (the persisted user message id of the prompt being processed; absent before the first user input) and `scratchpad_dir` (a lazily created, session-hashed `0700` directory under `<tmp>/hooks/scratchpad`, removed at session end). Tool-use-context events (`PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`, `PermissionDenied`, `Stop`, `StopFailure`, `SubagentStop`) report `effort: { "level": "low" | "medium" | "high" | "xhigh" | "max" }` when the prompt's model variant maps onto that scale. Permission mode and agent metadata are included when available. `inputFormat: "claude-code"` is available on every handler and adapts built-in tool names and argument keys; native OpenCode naming remains the default. It does not translate an arbitrary custom tool schema.

Under `inputFormat: "claude-code"`, `PostToolUse.tool_response` exposes Bash `stdout`/`stderr`/`interrupted`, Read `file: { filePath, content }`, and Edit/Write/patch `filePath`/`structuredPatch`/`success`. Bash's combined capture is exposed as `stdout`, with empty `stderr`; the host cannot reconstruct separate streams. Text Read content is the returned file slice. Structured patches contain unified-diff hunks, or an empty list when no diff is available. Native mode keeps the original metadata payload unchanged. `apply_patch`, `patch`, and `multiedit` match both `Edit` and `Write` as well as their native names; Claude input includes the first `file_path` and all affected `file_paths` (including move destinations).

`PermissionDenied` and `TeammateIdle` remain accepted for configuration compatibility but have no runtime producer in this build. Loading them logs a warning and marks them inactive in the Active Hooks list.

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
- `once`: scoped skill/session lifetime; success removes/suppresses the registration, failure releases it for retry. It has no effect in `hooks.json`, whose entries are static for the process; only session/skill-registered hooks use it. Agent hooks do not gain once semantics.
- `onFailure`: `continue` or `block`, for synchronous command/HTTP execution failures. Background output cannot retroactively decide the triggering operation.
- `continueOnBlock`: prompt evaluator option for PreToolUse feedback.
- `shell`: `bash` or `powershell` for command hooks. `options` supplies command plugin-option environment variables.
- `async` and `asyncRewake`: command hooks only; see below.

Command hooks receive the host environment plus their session's exports. `CLAUDE_PROJECT_DIR`, plugin-root/data variables, and the allowed `CLAUDE_ENV_FILE` lifecycle interface are supplied where applicable. A SessionStart environment file affects later commands in that session; it does not add arbitrary HTTP headers. HTTP environment expansion is restricted by its allowlists. `${user_config.*}` is substituted only in the exec form (`command` plus `args`); the shell form receives its command text unchanged, so do not rely on substitution there.

## Output and consumer behavior

Return one JSON object on stdout for structured controls; keep diagnostics on stderr. Use the matching `hookSpecificOutput.hookEventName`. An explicitly different event name cannot control this event. Invalid structured output is reported and ignored unless its configured failure policy blocks.

Exit 0 permits normal processing. Exit 2 has event-specific blocking semantics. PermissionRequest exit 2 leaves the normal dialog path available; TaskCompleted uses exit 2 to veto completion. Observation-only events cannot undo completed work. PreModelSwitch timeout blocks a requested switch. Other command exit codes ignore stdout control JSON and normally continue unless the event or `onFailure` says otherwise.

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
| `Stop`, `SubagentStop`                | Only a block decision or exit 2 continues a turn; context alone does not. V1 Stop retains context for the next user turn; other stop consumers drop non-blocking context with a debug log. DAG SubagentStop is a final-settlement notification. `continue:false` ends the chain; consecutive blocked continuations are capped at eight                    |
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

Callbacks belong to the originating session and instance. New user input, cancellation, session end, compaction, instance restart or disposal, a hooks.json reload, and the watcher's own deadline can lose or replace a pending result. A process crash loses in-memory background work. The watcher's lock and receipt under `scratchpad_dir` are the recovery source: after a missing wake, read the receipt, then run one bounded direct query for the current head instead of assuming success or failure. Stop scripts should honor `stop_hook_active` and be idempotent. Polling inside a script does not cause repeated model requests while it waits.

## Background watcher recipe

Use this when an agent would otherwise sleep or poll in the foreground for CI, reviews, deploys or long builds. When the watcher is defined in hooks.json, the Active Hooks block marks it `background`; that listing proves loading only. Skill/agent frontmatter and session-API registrations are not listed there. This skill holds the watcher setup, start confirmation and wake semantics. If the host exposes a model-facing watch tool, prefer it, but apply the same rules.

- Trigger: a `PostToolUse` handler on the tool that starts the work (for example matcher `Bash`). Exit 0 immediately when the input is not the expected start command, and add a small explicit helper command for starting a watch by hand. Recognize targets only from the tool's successful output, never by evaluating or replaying its command text.
- Start: when a target appears or its head changes, start a watch explicitly, even when a wrapper, delivery tool, API or another person created the request, and again for every push. Confirm the start from an observable artifact: the helper's validated marker line plus the lock or receipt under `scratchpad_dir`, keyed by target and head. A listed hook is not a running watch.
- Handler: `"type": "command"`, `"asyncRewake": true`, the exec form (`command` plus `args`, no shell), and a finite `timeout`. Keep the script's own deadline and per-query timeouts below that `timeout` so it can finish and report.
- Result: on a conclusion (success, failure, merged or closed, timeout, unavailable), write a bounded stderr summary and exit 2. Include status, counts, the target URL and the commands to inspect details. Do not copy logs, review text or other untrusted content into the summary.
- No callback as evidence: never record "waiting for a callback" or similar as a verification result in a request, commit or handoff. Write "not yet verified" and the concrete check to run. A wake means delivery, not authority; re-check the current head, required checks and reviews before acting.
- Missing wake: if no wake arrives by the watcher's documented deadline, or after cancellation, a restart or compaction, query the current head once with a bounded direct command. Restart the watch only when the request is still pending.
- Before merge or "done": query the required checks on the head being merged in the same turn, and update any request text that still claims a pending callback.
- State: put locks and delivery receipts under the session's `scratchpad_dir`, keyed by target and revision. That deduplicates repeated requests in the session, stops a superseded revision from reporting as current, and gives the missing-wake path its recovery source.
- Self-test: ship a fast self-test that exercises trigger -> process -> exit 2 -> wake against a fake, immediately settled target with no remote writes. Run it after writing or changing the watcher and before relying on it for the first time.
- Cleanup: record the parent PID at start, check that it is still alive about every second, and exit, releasing the lock, if the host goes away. Never use `nohup`, a detaching shell or a daemon launcher.
- Pair it with an optional `SessionStart` handler whose `additionalContext` tells the agent how to start the watcher.

## Scoped registration and verification

The session hook API is `POST /session/{sessionID}/hook`, `GET` on the same path, and `DELETE /session/{sessionID}/hook/{hookID}`. Registrations are in memory and disappear on session cleanup, instance disposal, or restart. They join the same matching and result pipeline as file hooks.

Before writing, inspect the target file and append only the intended matcher block. Preserve sibling events, unknown fields, and existing user content. Existing user authorization to create/write the hook is sufficient; ask only for missing choices. After writing, parse and reread the file, allow the polling/debounce interval, and inspect Active Hooks or the session registration API. That listing proves loading only. When global `disableAllHooks` is set, every trigger is disabled, including session-API registrations, and the Active Hooks block is empty by design; the session GET only proves an in-memory registration exists, not that a hooks.json entry loaded, and a controlled run executes no hook. Surface the setting and ask the user to remove or change it before verifying loading and execution; a later configuration layer such as project-level `false` overrides it, but only with the user's consent. Use a controlled operation and an independent observable result to verify execution and its consumer; never infer full compatibility from an accepted schema or event name. Before relying on a watcher for the first time after writing or changing it, run its self-test. That run verifies trigger -> process -> exit 2 -> wake, not a remote result; a later session uses start confirmation and the missing-wake fallback instead of a mandatory canary, and treats a callback as delivery, not evidence, until the current head is queried.

## Stop guard recipe

Use this when an agent tends to claim "done" with uncommitted changes, unpushed commits, or a request whose current-head checks were never queried. It is a one-shot end-of-turn checklist, not a commit or push gate.

- Trigger: `Stop`, with no matcher.
- Handler: `"type": "command"`, the exec form (`command` plus `args`, no shell), and a finite `timeout`. Read the hook JSON from stdin.
- Contract: exit 0 after printing one JSON object. If `stop_hook_active` is true, print nothing and allow. Otherwise run only read-only `git status --porcelain` and, when an upstream exists, `git log --oneline @{u}..HEAD`. On dirty state or unpushed commits, print `{"decision":"block","reason":"..."}` and exit 0; on clean state, allow. A missing repository, missing upstream or failed Git command allows.
- Loop safety: the host sets `stop_hook_active` for the continuation, so the guard blocks at most once in a stop chain. Never block when it is true.
- Never: modify the repository, print transcript text, echo untrusted command output, or turn the guard into a commit/push gate. The message names the safe next action, not a command to replay.

```json
{
  "Stop": [
    {
      "hooks": [
        {
          "type": "command",
          "command": "node",
          "args": ["<path>/stop-guard.mjs"],
          "timeout": 10
        }
      ]
    }
  ]
}
```

<!-- stop-guard:script:start -->

```js
#!/usr/bin/env node
import { execFileSync } from "node:child_process"

function allow() {
  process.exitCode = 0
}
function block(reason) {
  process.stdout.write(JSON.stringify({ decision: "block", reason }) + "\n")
}
function git(cwd, args) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()
  } catch {
    return undefined
  }
}
function main(payload) {
  if (payload.stop_hook_active === true) return allow()
  const cwd = typeof payload.cwd === "string" && payload.cwd ? payload.cwd : process.cwd()
  const status = git(cwd, ["status", "--porcelain"])
  if (status === undefined) return allow()
  if (status)
    return block(
      "Uncommitted changes remain. Commit or revert them before stopping; do not claim done with a dirty worktree.",
    )
  const upstream = git(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])
  if (!upstream) return allow()
  const unpushed = git(cwd, ["log", "--oneline", "@{u}..HEAD"])
  if (!unpushed) return allow()
  block("Unpushed commits remain. Push them or explain why they stay local before stopping.")
}
let input = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => (input += chunk))
process.stdin.on("end", () => {
  try {
    main(JSON.parse(input || "{}"))
  } catch {
    allow()
  }
})
```

<!-- stop-guard:script:end -->

## Scope guard recipe

Use this when static permission rules cannot express a context-sensitive dangerous command: force pushes, destructive resets, or recursive deletion outside the worktree. The guard is a narrow filter, not a permission classifier.

- Trigger: `PreToolUse` on `Bash`, narrowed with `if` so the script runs only for the listed command families. Native and configured deny rules still win.
- Handler: `"type": "command"`, the exec form (`command` plus `args`, no shell), and a short finite `timeout`. Read the hook JSON from stdin.
- Contract: inspect only `tool_input.command` as text. Deny only explicit patterns with `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"..."}}`. Allow near-misses by printing nothing or exiting 0. The reason names the safe alternative.
- Patterns: force push (`git push -f`, `--force`, `--force-with-lease`), `git reset --hard`, and recursive deletion (`rm -r`, `-rf`, `-fr`) whose target resolves outside the hook's `cwd`. A relative path that stays inside the worktree is allowed; an absolute path, `..`, `~`, or an unresolvable shell expansion is denied.
- Never: evaluate or replay the command text, call the forge, mutate the repository, or deny unrelated Bash commands. This guard complements, and never replaces, native deny rules.

```json
{
  "PreToolUse": [
    {
      "matcher": "Bash",
      "hooks": [
        {
          "type": "command",
          "command": "node",
          "args": ["<path>/scope-guard.mjs"],
          "if": "Bash(git push*)",
          "timeout": 5
        }
      ]
    },
    {
      "matcher": "Bash",
      "hooks": [
        {
          "type": "command",
          "command": "node",
          "args": ["<path>/scope-guard.mjs"],
          "if": "Bash(git reset --hard*)",
          "timeout": 5
        }
      ]
    },
    {
      "matcher": "Bash",
      "hooks": [
        {
          "type": "command",
          "command": "node",
          "args": ["<path>/scope-guard.mjs"],
          "if": "Bash(rm *)",
          "timeout": 5
        }
      ]
    }
  ]
}
```

<!-- scope-guard:script:start -->

```js
#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }) + "\n",
  )
}
function forcePush(command) {
  return /(^|[\s;|&])git\s+push\b[^;\n|&]*(\s--force(-with-lease)?\b|\s-f\b)/.test(command)
}
function hardReset(command) {
  return /(^|[\s;|&])git\s+reset\s+--hard(\s|$)/.test(command)
}
function segments(command) {
  const out = []
  let current = ""
  let quote = ""
  for (let index = 0; index < command.length; index++) {
    const char = command[index]
    if (quote) {
      if (quote === '"' && char === "\\" && index + 1 < command.length) {
        if (command[index + 1] === "\n") index++
        else current += char + command[++index]
      } else {
        current += char
        if (char === quote) quote = ""
      }
    } else if (char === "'" || char === '"') {
      quote = char
      current += char
    } else if (char === "\\" && index + 1 < command.length) {
      if (command[index + 1] === "\n") index++
      else current += char + command[++index]
    } else if (char === ";" || char === "|" || char === "&" || char === "\n") {
      if (current.trim()) out.push(current.trim())
      current = ""
    } else current += char
  }
  if (current.trim()) out.push(current.trim())
  return { segments: out, unterminated: Boolean(quote) }
}
function tokens(input) {
  const out = []
  let current = ""
  let quote = ""
  for (let index = 0; index < input.length; index++) {
    const char = input[index]
    if (quote) {
      if (quote === '"' && char === "\\" && index + 1 < input.length) {
        const next = input[index + 1]
        if (next === "\n") index++
        else if (["$", "`", '"', "\\"].includes(next)) {
          current += next
          index++
        } else current += char
      } else if (char === quote) quote = ""
      else current += char
    } else if (char === "'" || char === '"') quote = char
    else if (char === "\\" && index + 1 < input.length) {
      if (input[index + 1] === "\n") index++
      else current += input[++index]
    } else if (/\s/.test(char)) {
      if (current) out.push(current)
      current = ""
    } else current += char
  }
  if (current) out.push(current)
  return { tokens: out, unterminated: Boolean(quote) }
}
function rmTargets(command) {
  const targets = []
  let unterminated = false
  for (const segment of segments(command).segments) {
    const parsed = tokens(segment)
    let start = 0
    while (start < parsed.tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(parsed.tokens[start])) start++
    if (parsed.tokens[start] !== "rm") continue
    if (parsed.unterminated) {
      unterminated = true
      continue
    }
    let recursive = false
    let options = true
    const values = []
    for (const token of parsed.tokens.slice(start + 1)) {
      if (options && token === "--") {
        options = false
        continue
      }
      if (options && token.startsWith("-") && token !== "-") {
        if (/^-[A-Za-z]*[rR][A-Za-z]*$/.test(token) || token === "--recursive") recursive = true
        continue
      }
      values.push(token)
    }
    if (recursive) targets.push(...values)
  }
  return { targets, unterminated: unterminated || segments(command).unterminated }
}
function actual(value) {
  try {
    return fs.realpathSync(value)
  } catch {
    try {
      return path.join(fs.realpathSync(path.dirname(value)), path.basename(value))
    } catch {
      return value
    }
  }
}
function outside(cwd, target) {
  const root = actual(path.resolve(cwd))
  const value = target.replace(/^['"]|['"]$/g, "")
  if (!value || value.startsWith("$") || value.includes("`")) return true
  if (value.split(/[\\/]+/).includes("..")) return true
  const expanded =
    value === "~"
      ? process.env.HOME || "~"
      : value.startsWith("~/")
        ? path.join(process.env.HOME || "", value.slice(2))
        : value
  const resolved = actual(path.resolve(root, expanded))
  return resolved === root || resolved === path.parse(resolved).root || !resolved.startsWith(root + path.sep)
}
function main(payload) {
  const command = payload?.tool_input?.command
  if (typeof command !== "string" || !command.trim()) return
  const cwd = typeof payload.cwd === "string" && payload.cwd ? payload.cwd : process.cwd()
  if (forcePush(command)) {
    return deny(
      "Force pushing rewrites shared history. Push a new commit instead; ask the user to run an explicit history rewrite if it is truly required.",
    )
  }
  if (hardReset(command)) {
    return deny(
      "git reset --hard discards uncommitted work. Use git stash or a new commit; ask the user before a destructive reset.",
    )
  }
  const rm = rmTargets(command)
  if (rm.unterminated)
    return deny("Could not parse the recursive deletion safely. Ask the user to run an explicit, quoted deletion.")
  for (const target of rm.targets) {
    if (outside(cwd, target)) {
      return deny(
        "Recursive deletion outside the worktree. Delete only paths inside the current worktree; ask the user before anything broader.",
      )
    }
  }
}
let input = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => (input += chunk))
process.stdin.on("end", () => {
  try {
    main(JSON.parse(input || "{}"))
  } catch {
    // A malformed payload is not a matching dangerous command.
  }
})
```

<!-- scope-guard:script:end -->
