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
 * - `Edit`                 → a bare tool rule matches every call of that tool
 * - `WebFetch(domain:x)`   → compares the request host
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
export function evaluate(
  entry: HookCommand,
  envelope: Record<string, unknown>,
  event: HookEvent,
  tool: { canonicalToolName?: string } = {},
): boolean {
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

  const nativeName = typeof envelope.tool_name === "string" ? envelope.tool_name : ""
  const toolInput = (envelope.tool_input as Record<string, unknown>) ?? {}
  // The official name comes from the runtime's real binding; the native id stays accepted.
  const names = [tool.canonicalToolName, nativeName].filter((name): name is string => !!name)

  // Parse: ToolName(arg_pattern) or a bare ToolName rule (matches every call of that tool).
  const trimmed = condition.trim()
  const match = trimmed.match(/^([\w*.-]+)\((.*)\)$/s)
  const bare = match ? undefined : trimmed.match(/^[\w*.-]+$/)
  if (!match && !bare) {
    // Malformed condition — fail open (CC behavior: unknown conditions are truthy)
    return true
  }

  const condTool = match ? match[1] : trimmed
  const condPattern = match ? match[2] : ""

  // Tool name match (case-insensitive); `mcp__server` covers every tool of that server.
  if (!names.some((name) => toolNameMatches(condTool, name))) return false
  if (!match || condPattern.trim() === "" || condPattern.trim() === "*") return true

  const lower = (tool.canonicalToolName ?? nativeName).toLowerCase()
  const nativeLower = nativeName.toLowerCase()
  const is = (...kinds: string[]) => kinds.includes(lower) || kinds.includes(nativeLower)
  if (is("bash", "shell")) {
    const command = toolInput.command
    if (typeof command !== "string" || !command) return true // No extractable arg — fail open
    return bashMatch(condPattern, command)
  }
  if (is("edit", "write", "read", "multiedit", "notebookedit")) {
    const file = toolInput.filePath ?? toolInput.file_path ?? toolInput.notebook_path
    if (typeof file !== "string" || !file) return true // No extractable arg — fail open
    return fileMatch(condPattern, file, typeof envelope.cwd === "string" ? envelope.cwd : undefined)
  }
  if (is("webfetch")) {
    const url = toolInput.url
    if (typeof url !== "string" || !url) return true
    return webFetchMatch(condPattern, url)
  }
  // Other tools: best-effort match over the serialized input.
  return toRegex(condPattern, ".*").test(JSON.stringify(toolInput))
}

function toolNameMatches(rule: string, name: string): boolean {
  const left = rule.toLowerCase()
  const right = name.toLowerCase()
  if (left === right) return true
  if (left.includes("*")) return toRegex(left, ".*").test(right)
  return left.startsWith("mcp__") && left.split("__").length === 2 && right.startsWith(left + "__")
}

/** `WebFetch(domain:example.com)` compares the host; any other pattern is a URL glob. */
function webFetchMatch(pattern: string, url: string): boolean {
  const domain = pattern.trim().match(/^domain:(.+)$/)
  if (!domain) return toRegex(pattern.trim(), ".*").test(url)
  try {
    const host = new URL(url).hostname.toLowerCase()
    const want = domain[1].trim().toLowerCase()
    return want.startsWith("*.") ? host.endsWith(want.slice(1)) : host === want
  } catch {
    return true
  }
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
const SHELL_KEYWORDS = new Set([
  "if",
  "then",
  "else",
  "elif",
  "do",
  "while",
  "until",
  "time",
  "!",
  "{",
  "}",
  "fi",
  "done",
])
const VARIABLE_START = /[A-Za-z_{@*#?0-9]/

interface BashAnalysis {
  /** Commands the input runs: each separated segment plus commands inside `$()`, backticks and `<()`. */
  readonly commands: string[]
  /** The input expands `$()`, backticks or a variable somewhere. */
  readonly dynamic: boolean
  /** The runner cannot be determined (unbalanced input, `eval`, a variable as command name). */
  readonly opaque: boolean
}

/** Index of the delimiter closing a nested construct, honoring quotes; -1 when unbalanced. */
function closingIndex(text: string, from: number, open: string, close: string): number {
  let depth = 1
  for (let i = from; i < text.length; i++) {
    const c = text[i]
    if (c === "\\") i++
    else if (c === "'") {
      const end = text.indexOf("'", i + 1)
      if (end === -1) return -1
      i = end
    } else if (c === '"') {
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === "\\") i++
      if (i >= text.length) return -1
    } else if (c === open) depth++
    else if (c === close && --depth === 0) return i
  }
  return -1
}

/** Split Bash input into the commands it runs, honoring quotes and nested substitutions. */
function analyzeBash(command: string): BashAnalysis {
  const commands: string[] = []
  let dynamic = false
  let opaque = false

  const scan = (text: string) => {
    let segment = ""
    const flush = () => {
      const stripped = segment.trim()
      segment = ""
      if (!stripped) return
      let value = stripped.replace(ENV_PREFIX, "")
      for (;;) {
        const word = value.split(/\s+/, 1)[0]
        if (!word || !SHELL_KEYWORDS.has(word)) break
        value = value.slice(word.length).trim()
      }
      if (!value) return
      commands.push(value)
      const first = value.split(/\s+/, 1)[0] ?? ""
      if (/^["']?\$/.test(first) || first === "eval" || first === "source" || first === ".") opaque = true
    }
    const nested = (start: number): number => {
      const end = closingIndex(text, start + 2, "(", ")")
      if (end === -1) {
        opaque = true
        return text.length
      }
      dynamic = true
      segment += text.slice(start, end + 1)
      scan(text.slice(start + 2, end))
      return end
    }
    for (let i = 0; i < text.length; i++) {
      const c = text[i]
      if (c === "\\") {
        segment += c + (text[i + 1] ?? "")
        i++
      } else if (c === "'") {
        const end = text.indexOf("'", i + 1)
        if (end === -1) {
          opaque = true
          return flush()
        }
        segment += text.slice(i, end + 1)
        i = end
      } else if (c === '"') {
        let j = i + 1
        for (; j < text.length && text[j] !== '"'; j++) {
          if (text[j] === "\\") j++
          else if (text[j] === "$" && text[j + 1] === "(") {
            const end = closingIndex(text, j + 2, "(", ")")
            if (end === -1) {
              opaque = true
              break
            }
            dynamic = true
            scan(text.slice(j + 2, end))
            j = end
          } else if (text[j] === "`") {
            const end = text.indexOf("`", j + 1)
            if (end === -1) {
              opaque = true
              break
            }
            dynamic = true
            scan(text.slice(j + 1, end))
            j = end
          } else if (text[j] === "$" && VARIABLE_START.test(text[j + 1] ?? "")) dynamic = true
        }
        if (j >= text.length) {
          opaque = true
          segment += text.slice(i)
          return flush()
        }
        segment += text.slice(i, j + 1)
        i = j
      } else if (c === "$" && text[i + 1] === "(") {
        i = nested(i)
      } else if (c === "`") {
        const end = text.indexOf("`", i + 1)
        if (end === -1) {
          opaque = true
          return flush()
        }
        dynamic = true
        segment += text.slice(i, end + 1)
        scan(text.slice(i + 1, end))
        i = end
      } else if ((c === "<" || c === ">") && text[i + 1] === "(") {
        i = nested(i)
      } else if (c === "$" && VARIABLE_START.test(text[i + 1] ?? "")) {
        dynamic = true
        segment += c
      } else if (c === "\n" || c === ";" || c === "|" || c === "(" || c === ")") {
        flush()
      } else if (c === "&") {
        const redirect = text[i - 1] === ">" || text[i - 1] === "<" || text[i + 1] === ">"
        if (redirect) segment += c
        else flush()
      } else segment += c
    }
    flush()
  }
  scan(command)
  return { commands, dynamic, opaque }
}

/**
 * Bash rule: each command the input runs — separated subcommands and the contents of
 * `$()`, backticks and process substitution — is tried after stripping leading
 * `VAR=value` assignments (from the pattern too), and the whole unsplit command is
 * tried as a fallback so pipeline patterns such as `cat * | grep *` still match.
 * Hooks are guards: when the runner cannot be determined, or a pattern that names more
 * than the command meets a dynamic expansion, the hook runs.
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
  const analysis = analyzeBash(command)
  if (analysis.opaque) return true
  const nameOnly = legacy !== undefined ? !/\s/.test(legacy) : /^[^\s*]+(?: \*)?$/.test(pattern)
  if (analysis.dynamic && !nameOnly) return true
  return [whole, whole.replace(ENV_PREFIX, ""), ...analysis.commands].some(test)
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
