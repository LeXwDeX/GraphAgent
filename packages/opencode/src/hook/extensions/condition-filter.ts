/**
 * [FORK:hook-ext] Hook if-condition evaluator — not in upstream
 *
 * Evaluates the `if` field on HookCommand entries to provide fine-grained
 * matching compatible with Claude Code's condition syntax.
 *
 * Supported patterns (Claude Code permission-rule semantics):
 * - `Bash(npm install *)`  → tool_name="bash" AND any subcommand matches. `*`
 *                            matches any characters (including `/` and spaces);
 *                            a trailing ` *` also matches the bare command; the
 *                            legacy `prefix:*` form is a word-boundary prefix match
 * - `Edit(*.ts)`           → gitignore-like file matching: a pattern without `/`
 *                            matches a path segment (basename) at any depth
 * - `Write(src/**)`        → a pattern containing `/` is anchored at the project
 *                            root (`cwd`); `//abs/**` is absolute, `~/x` is home
 * - `Read(*.py)`           → in file patterns `*` stays within one segment, `**` spans
 * - `*`                    → Always matches (wildcard)
 * - (empty/undefined)      → Always matches (no condition)
 *
 * For non-tool events (UserPromptSubmit, Stop, etc.), an `if` condition
 * does not match. Claude Code only evaluates these rules for tool events.
 */

import os from "os"
import path from "path"
import type { HookCommand, HookEvent } from "../settings"

/**
 * Evaluate a hook entry's `if` condition against the runtime envelope.
 *
 * @returns true if the entry should execute, false to skip
 */
export function evaluate(entry: HookCommand, envelope: Record<string, unknown>, event: HookEvent): boolean {
  const condition = entry.if
  if (!condition || condition.trim() === "" || condition.trim() === "*") return true

  // Tool events that match by tool_name support `if` condition filtering.
  // This set MUST stay in sync with `matcherTarget` in settings.ts — matcher and
  // `if` must agree on which events are tool-bound, otherwise `if` would be
  // silently ignored on events where the matcher still matches by tool_name.
  if (
    event !== "PreToolUse" &&
    event !== "PostToolUse" &&
    event !== "PostToolUseFailure" &&
    event !== "PermissionRequest" &&
    event !== "PermissionDenied"
  ) {
    return false
  }

  const toolName = (envelope.tool_name as string) ?? ""
  const toolInput = (envelope.tool_input as Record<string, unknown>) ?? {}

  // Parse: ToolName(arg_pattern)
  const match = condition.match(/^(\w+)\((.+)\)$/s)
  if (!match) {
    // Malformed condition — fail open (CC behavior: unknown conditions are truthy)
    return true
  }

  const [, condTool, condPattern] = match

  // Tool name match (case-insensitive)
  if (condTool.toLowerCase() !== toolName.toLowerCase()) return false

  const lower = toolName.toLowerCase()
  if (lower === "bash" || lower === "shell") {
    const command = toolInput.command
    if (typeof command !== "string" || !command) return true // No extractable arg — fail open
    return bashMatch(condPattern, command)
  }
  if (lower === "edit" || lower === "write" || lower === "read" || lower === "multiedit") {
    const file = toolInput.filePath ?? toolInput.file_path
    if (typeof file !== "string" || !file) return true // No extractable arg — fail open
    return fileMatch(condPattern, file, typeof envelope.cwd === "string" ? envelope.cwd : undefined)
  }
  // Other tools: best-effort match over the serialized input.
  return toRegex(condPattern, ".*").test(JSON.stringify(toolInput))
}

/** Compile a glob to an anchored regex. `*` compiles to `star`; `**` always spans separators. */
function toRegex(pattern: string, star: string): RegExp {
  let regex = "^"
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        // `**/` also matches zero directories (gitignore).
        if (pattern[i + 2] === "/") {
          regex += "(?:.*/)?"
          i += 2
        } else {
          regex += ".*"
          i++
        }
      } else regex += star
    } else if (c === "?") {
      regex += star === ".*" ? "." : "[^/]"
    } else if (".+^$|(){}[]\\".includes(c)) {
      regex += "\\" + c
    } else {
      regex += c
    }
  }
  return new RegExp(regex + "$", "s")
}

const ENV_PREFIX = /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/

/**
 * Bash rule: each subcommand (split on `&&`, `||`, `;`, `|`, newlines) is tried
 * after stripping leading `VAR=value` assignments (from the pattern too), and
 * the whole unsplit command is tried as a fallback so pipeline patterns such as
 * `cat * | grep *` still match. `*` matches anything. Hooks are guards: when
 * semantics are ambiguous, prefer matching.
 */
function bashMatch(rawPattern: string, command: string): boolean {
  const pattern = rawPattern.trim().replace(ENV_PREFIX, "")
  const legacy = pattern.endsWith(":*") ? pattern.slice(0, -2) : undefined
  const test = (candidate: string) => {
    if (legacy !== undefined) return candidate === legacy || candidate.startsWith(legacy + " ")
    if (toRegex(pattern, ".*").test(candidate)) return true
    // `Bash(ls *)` also matches a bare `ls` (word-boundary form).
    return pattern.endsWith(" *") && toRegex(pattern.slice(0, -2), ".*").test(candidate)
  }
  const whole = command.trim()
  const candidates = [
    whole,
    whole.replace(ENV_PREFIX, ""),
    ...command
      .split(/&&|\|\||;|\||\n/)
      .map((part) => part.trim().replace(ENV_PREFIX, ""))
      .filter(Boolean),
  ]
  return candidates.some(test)
}

/**
 * File rule: gitignore-like matching against the project-relative path. A
 * pattern with one leading `/` means project-root-relative in Claude Code but was
 * historically an absolute path here, so both readings are tried (union).
 */
function fileMatch(pattern: string, file: string, cwd: string | undefined): boolean {
  const normalized = file.replaceAll("\\", "/")
  if (pattern.startsWith("//")) return toRegex(pattern.slice(1), "[^/]*").test(normalized)
  if (pattern.startsWith("~/"))
    return toRegex(path.posix.join(os.homedir().replaceAll("\\", "/"), pattern.slice(2)), "[^/]*").test(normalized)
  if (pattern.startsWith("/") && toRegex(pattern.endsWith("/") ? pattern + "**" : pattern, "[^/]*").test(normalized))
    return true
  const root = cwd?.replaceAll("\\", "/").replace(/\/$/, "")
  const relative =
    root && normalized.startsWith(root + "/") ? normalized.slice(root.length + 1) : normalized.replace(/^\.\//, "")
  const body = pattern.replace(/^\.?\//, "")
  const expanded = body.endsWith("/") ? body + "**" : body
  if (!expanded.includes("/")) {
    // No separator: match a path segment at any depth (gitignore).
    const regex = toRegex(expanded, "[^/]*")
    return relative.split("/").some((segment) => regex.test(segment))
  }
  const regex = toRegex(expanded, "[^/]*")
  return regex.test(relative) || regex.test(normalized)
}
