// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure rules of the delegation-timing evaluation (Issue #1057, plan 6).
 *
 * Nothing here touches the network, the file system or the runtime, so the
 * hook process the host spawns (`hook.ts`) and the harness that reads the
 * transcript afterwards share one definition of "what the model did":
 *
 * - which tool calls end a scenario (the first `task` call or the first call
 *   that is not a plain read) and which are only observed;
 * - how a decided scenario maps to an `Outcome`, and whether that outcome is
 *   accurate, a foreground violation, or a background hit;
 * - the metrics and gates of the decision rule, and the Markdown report.
 */

export type Outcome = "task_fg" | "task_bg" | "edit" | "exec" | "ask" | "other" | "none" | "cap" | "error"

export type ScenarioClass = "F" | "B" | "A"

/** What one tool call is, for the purpose of ending a scenario. */
export type CallKind = "read" | "command" | "task" | "edit" | "exec" | "ask" | "other"

export interface ToolCall {
  readonly tool: string
  readonly input: Readonly<Record<string, unknown>>
  /** The call id the runtime recorded; the command-driven `task` call has a ULID, a model's has a provider id. */
  readonly callID?: string
}

export interface CallClass {
  readonly kind: CallKind
  readonly background?: boolean
}

/** The command whose own `task` call the harness issues (the user-initiated background review). */
export const HARNESS_COMMAND = "review"

export const F_VIOLATION_LIMIT = 0
export const B_RATE_MIN = 5 / 6
export const ACCURACY_MIN = 0.85

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Both spellings of true count: the runtime repairs the string form before it executes the call. */
export function isBackground(value: unknown): boolean {
  return value === true || value === "true"
}

// Tools that only read project state or session-local bookkeeping. They run for real on the fixture copy.
const READ_TOOLS = new Set(["read", "grep", "glob", "list", "lsp", "skill", "todowrite", "memory_search", "invalid"])
const EDIT_TOOLS = new Set(["edit", "write", "apply_patch", "multiedit", "patch"])

const READ_COMMANDS = new Set([
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "tree",
  "pwd",
  "echo",
  "printf",
  "stat",
  "file",
  "diff",
  "cmp",
  "sort",
  "uniq",
  "cut",
  "tr",
  "basename",
  "dirname",
  "realpath",
  "readlink",
  "du",
  "df",
  "which",
  "type",
  "true",
  "false",
  "test",
  "[",
  "cd",
  "date",
  "whoami",
  "uname",
  "jq",
  "nl",
  "column",
  "fd",
  "bat",
  "md5sum",
  "shasum",
  "sha256sum",
  "less",
  "more",
  "sleep",
  "sed",
  "awk",
  "find",
  "tac",
  "rev",
  "fold",
  "paste",
  "comm",
  "join",
  "expand",
  "unexpand",
  "xxd",
  "od",
  "hexdump",
  "strings",
  "seq",
  "printenv",
  "id",
  "hostname",
  "ps",
  "expr",
  "read",
  "[[",
  "export",
  "set",
  "unset",
  "local",
  "declare",
  "readonly",
  "shift",
  "return",
  "break",
  "continue",
  "exit",
  "wait",
  ":",
])

// Shell syntax that only structures other commands: the commands inside are judged on their own.
const CONTROL_PREFIX = new Set(["if", "then", "elif", "else", "while", "until", "do", "!", "{"])
// Words that open or close a construct without running anything.
const CONTROL_WORDS = new Set(["done", "fi", "esac", "}", "in", "for", "select", "case"])
// Options of xargs that take a value.
const XARGS_VALUE_OPTIONS = new Set(["-I", "-n", "-P", "-d", "-L", "-s", "-E", "-a"])

const WRITE_COMMANDS = new Set([
  "rm",
  "mv",
  "cp",
  "mkdir",
  "rmdir",
  "touch",
  "tee",
  "chmod",
  "chown",
  "ln",
  "truncate",
  "dd",
  "install",
  "patch",
  "wget",
  "unzip",
  "tar",
  "zip",
])

const GIT_READ = new Set([
  "status",
  "log",
  "diff",
  "show",
  "blame",
  "rev-parse",
  "rev-list",
  "ls-files",
  "ls-tree",
  "cat-file",
  "describe",
  "shortlog",
  "grep",
  "merge-base",
  "name-rev",
  "for-each-ref",
  "show-ref",
  "whatchanged",
  "diff-tree",
  "diff-index",
  "count-objects",
  "show-branch",
])

const GIT_WRITE = new Set([
  "add",
  "commit",
  "checkout",
  "switch",
  "reset",
  "restore",
  "merge",
  "rebase",
  "cherry-pick",
  "revert",
  "apply",
  "am",
  "clean",
  "rm",
  "mv",
  "push",
  "pull",
  "fetch",
  "init",
  "clone",
])

const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun", "pip", "pip3", "cargo", "go"])
const PACKAGE_WRITE = new Set([
  "install",
  "i",
  "add",
  "remove",
  "rm",
  "uninstall",
  "update",
  "up",
  "upgrade",
  "link",
  "patch",
])

type ShellKind = "read" | "edit" | "exec"

const SEGMENT_BREAKS = new Set([";", "&", "|", "\n", "(", ")"])

interface Segment {
  readonly words: readonly string[]
  readonly redirectsToFile: boolean
}

/**
 * Splits a shell command line into simple commands and their words, honouring
 * quotes. A redirection to anything but `/dev/null` or a file descriptor marks
 * the segment as writing. Command substitutions are returned as extra
 * segments so their contents are judged too.
 */
function parseShell(command: string): readonly Segment[] {
  const segments: Segment[] = []
  const substitutions: string[] = []
  let words: string[] = []
  let word = ""
  let hasWord = false
  let redirects = false
  let quote: "'" | '"' | undefined

  const endWord = () => {
    if (hasWord) words.push(word)
    word = ""
    hasWord = false
  }
  const endSegment = () => {
    endWord()
    if (words.length > 0 || redirects) segments.push({ words, redirectsToFile: redirects })
    words = []
    redirects = false
  }

  for (let i = 0; i < command.length; i++) {
    const char = command[i]
    if (char === "\\" && quote !== "'") {
      word += command[i + 1] ?? ""
      hasWord = true
      i++
      continue
    }
    if (quote) {
      if (char === quote) quote = undefined
      else {
        if (quote === '"' && char === "$" && command[i + 1] === "(") {
          const inner = readGroup(command, i + 2)
          substitutions.push(inner.text)
        }
        word += char
      }
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      hasWord = true
      continue
    }
    if (char === "$" && command[i + 1] === "(") {
      const inner = readGroup(command, i + 2)
      substitutions.push(inner.text)
      word += "$(...)"
      hasWord = true
      i = inner.end
      continue
    }
    if (char === "`") {
      const end = command.indexOf("`", i + 1)
      substitutions.push(command.slice(i + 1, end === -1 ? command.length : end))
      word += "`...`"
      hasWord = true
      i = end === -1 ? command.length : end
      continue
    }
    if (char === ">" || (char === "<" && command[i + 1] === "<")) {
      if (char === "<") {
        // Here-documents and here-strings only feed input; skip the marker.
        while (command[i + 1] === "<") i++
        continue
      }
      let j = i + 1
      if (command[j] === ">") j++
      const duplicate = command[j] === "&"
      while (command[j] === " " || command[j] === "&") j++
      let target = ""
      while (j < command.length && !/[\s;&|]/.test(command[j] ?? "")) target += command[j++]
      if (!duplicate && target !== "/dev/null" && target !== "") redirects = true
      // A file-descriptor prefix such as the 2 of `2>&1` was read as part of the word.
      if (/^\d$/.test(word)) {
        word = ""
        hasWord = false
      }
      i = j - 1
      continue
    }
    if (SEGMENT_BREAKS.has(char ?? "")) {
      if (char === "&" && command[i + 1] === "&") i++
      else if (char === "|" && command[i + 1] === "|") i++
      endSegment()
      continue
    }
    if (char === " " || char === "\t") {
      endWord()
      continue
    }
    word += char
    hasWord = true
  }
  endSegment()
  return [...segments, ...substitutions.flatMap((inner) => parseShell(inner))]
}

function readGroup(command: string, start: number): { text: string; end: number } {
  let depth = 1
  let i = start
  for (; i < command.length && depth > 0; i++) {
    if (command[i] === "(") depth++
    else if (command[i] === ")") depth--
  }
  return { text: command.slice(start, Math.max(start, i - 1)), end: i - 1 }
}

const worst = (a: ShellKind, b: ShellKind): ShellKind =>
  a === "edit" || b === "edit" ? "edit" : a === "exec" || b === "exec" ? "exec" : "read"

function gitKind(args: readonly string[]): ShellKind {
  const rest = [...args]
  while (rest.length > 0) {
    const option = rest[0] ?? ""
    if (option === "-C" || option === "-c") rest.splice(0, 2)
    else if (option.startsWith("-")) rest.shift()
    else break
  }
  const sub = rest.shift()
  if (sub === undefined) return "read"
  // `diff`, `show`, `log` and others can write their output to a file instead of stdout.
  if (rest.some((arg) => /^--output(-directory)?(=|$)/.test(arg))) return "edit"
  if (GIT_READ.has(sub)) return "read"
  if (GIT_WRITE.has(sub)) return "edit"
  const flags = rest.filter((arg) => arg.startsWith("-"))
  const operands = rest.filter((arg) => !arg.startsWith("-"))
  switch (sub) {
    case "branch":
    case "tag":
      return operands.length === 0 && flags.every((flag) => !/^-[dDmMcCfu]|--(delete|move|copy|force)/.test(flag))
        ? "read"
        : "edit"
    case "remote":
      return operands.length === 0 || ["show", "get-url"].includes(operands[0] ?? "") ? "read" : "edit"
    case "config":
      return flags.some((flag) => /^(--get|--get-all|--get-regexp|--list|-l|--show-origin)$/.test(flag))
        ? "read"
        : "edit"
    case "stash":
      return ["list", "show"].includes(operands[0] ?? "") ? "read" : "edit"
    case "worktree":
      return operands[0] === "list" ? "read" : "edit"
    case "reflog":
      return ["expire", "delete"].includes(operands[0] ?? "") ? "edit" : "read"
    default:
      return "exec"
  }
}

function wordsKind(words: readonly string[]): ShellKind {
  const rest = [...words]
  // Leading environment assignments and transparent wrappers do not change what runs.
  while (
    rest.length > 0 &&
    (/^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[0] ?? "") ||
      ["time", "command", "builtin"].includes(rest[0] ?? "") ||
      CONTROL_PREFIX.has(rest[0] ?? ""))
  )
    rest.shift()
  const head = rest.shift()
  if (head === undefined || CONTROL_WORDS.has(head)) return "read"
  const name = head.split("/").at(-1) ?? head
  // `tool --version` and `tool --help` only print.
  if (rest.length > 0 && rest.every((arg) => /^(--version|-v|-V|--help|-h)$/.test(arg))) return "read"
  if (name === "xargs") {
    while (rest.length > 0 && (rest[0] ?? "").startsWith("-")) {
      const option = rest.shift() ?? ""
      if (XARGS_VALUE_OPTIONS.has(option)) rest.shift()
    }
    return rest.length === 0 ? "read" : wordsKind(rest)
  }
  if (name === "git") return gitKind(rest)
  if (name === "gh") {
    return ["pr", "issue", "repo", "run", "release"].includes(rest[0] ?? "") &&
      ["view", "diff", "list", "checks", "status"].includes(rest[1] ?? "")
      ? "read"
      : "exec"
  }
  if (name === "sed") return rest.some((arg) => /^-[a-zA-Z]*i|^--in-place/.test(arg)) ? "edit" : "read"
  if (name === "awk") return rest.some((arg) => arg.includes("system(") || arg.includes(">")) ? "exec" : "read"
  if (name === "find") {
    if (rest.some((arg) => ["-delete", "-fprint", "-fprintf", "-fls"].includes(arg))) return "edit"
    return rest.some((arg) => ["-exec", "-execdir", "-ok", "-okdir"].includes(arg)) ? "exec" : "read"
  }
  if (name === "curl") return rest.some((arg) => /^(-[a-zA-Z]*[oO]|--output|--remote-name)/.test(arg)) ? "edit" : "exec"
  if (PACKAGE_MANAGERS.has(name)) return PACKAGE_WRITE.has(rest[0] ?? "") ? "edit" : "exec"
  if (WRITE_COMMANDS.has(name)) return "edit"
  if (READ_COMMANDS.has(name)) return "read"
  return "exec"
}

/**
 * Judges a shell command by what its words and redirections can do. The rules
 * err towards the stricter class: anything that is neither a known read nor a
 * known write is `exec`, which still ends the scenario but is not counted as
 * an edit.
 */
export function classifyShell(command: string): ShellKind {
  return parseShell(command).reduce<ShellKind>(
    (kind, segment) => worst(kind, segment.redirectsToFile ? "edit" : wordsKind(segment.words)),
    "read",
  )
}

/**
 * The review command's own `task` call: the harness starts it, the model does not. The runtime gives a
 * command-driven call a fresh ULID as its call id, which no provider uses, so a model cannot pass for it
 * by filling in the `command` field.
 */
export function isCommandTask(call: ToolCall): boolean {
  return (
    call.input.command === HARNESS_COMMAND &&
    call.input.subagent_type === HARNESS_COMMAND &&
    /^[0-9A-HJKMNP-TV-Z]{26}$/.test(call.callID ?? "")
  )
}

export function classifyCall(call: ToolCall): CallClass {
  const tool = call.tool.toLowerCase()
  if (tool === "task") {
    if (isCommandTask(call)) return { kind: "command" }
    if (call.input.action === "cancel") return { kind: "other" }
    return { kind: "task", background: isBackground(call.input.background) }
  }
  if (READ_TOOLS.has(tool)) return { kind: "read" }
  if (EDIT_TOOLS.has(tool)) return { kind: "edit" }
  if (tool === "bash") return { kind: classifyShell(typeof call.input.command === "string" ? call.input.command : "") }
  if (tool === "question") return { kind: "ask" }
  return { kind: "other" }
}

/** A call the hook must stop: it ends the scenario, so it must not run. */
export function isDecisive(kind: CallKind): boolean {
  return kind !== "read" && kind !== "command"
}

export interface TaskCall {
  readonly subagent: string
  readonly background: boolean
  readonly description: string
  readonly prompt: string
}

export interface Decision {
  readonly outcome: Outcome
  /** Every task call the model issued in scope, in order. */
  readonly tasks: readonly TaskCall[]
  /** Edit-class calls the model issued in scope. */
  readonly edits: number
  /** The call that decided the scenario, with the input it carried. */
  readonly first?: ToolCall
}

const text = (value: unknown) => (typeof value === "string" ? value : "")

function taskCall(input: Readonly<Record<string, unknown>>): TaskCall {
  return {
    subagent: text(input.subagent_type),
    background: isBackground(input.background),
    description: text(input.description),
    prompt: text(input.prompt).slice(0, 400),
  }
}

/**
 * Maps the model's ordered calls in scope to what it decided. `steps` is the
 * number of model steps taken in scope; a scenario that used its whole step
 * budget without deciding is `cap`.
 */
export function decide(input: {
  readonly calls: readonly ToolCall[]
  readonly steps: number
  readonly stepCap: number
  readonly error?: string
}): Decision {
  const classified = input.calls.map((call) => ({ call, ...classifyCall(call) }))
  const tasks = classified.filter((item) => item.kind === "task").map((item) => taskCall(item.call.input))
  const edits = classified.filter((item) => item.kind === "edit").length
  if (input.error !== undefined) return { outcome: "error", tasks, edits }
  const first = classified.find((item) => isDecisive(item.kind))
  if (!first) return { outcome: input.steps >= input.stepCap ? "cap" : "none", tasks, edits }
  const outcome: Outcome =
    first.kind === "task"
      ? first.background === true
        ? "task_bg"
        : "task_fg"
      : first.kind === "edit" || first.kind === "exec" || first.kind === "ask" || first.kind === "other"
        ? first.kind
        : "other"
  return { outcome, tasks, edits, first: first.call }
}

/**
 * The workspace is the final word on edits. Classifying shell commands can only approximate which
 * ones write (`sort -o`, `git diff --output`, ...); a run that changed the workspace edited it,
 * whatever the classification said, so it counts as an edit and can never pass as read-only.
 */
export function withWorkspaceCheck(decision: Decision, changed: boolean): Decision {
  if (!changed || decision.outcome === "error") return decision
  return { ...decision, outcome: "edit", edits: Math.max(decision.edits, 1) }
}

export interface Expectation {
  readonly class: ScenarioClass
  /** Outcomes that count as accurate. */
  readonly accept: readonly Outcome[]
  /** A user-initiated background result was injected; edits after it are violations. */
  readonly injection?: boolean
}

export interface Verdict {
  readonly accurate: boolean
  readonly violation: boolean
  readonly hit: boolean
}

/**
 * F scenarios must never background a task (and, after an injected review,
 * must not edit); B scenarios hit when the first decision is a background
 * task; every scenario is accurate when its outcome is in the accepted set.
 */
export function judge(expectation: Expectation, decision: Decision): Verdict {
  const violation =
    expectation.class === "F" &&
    (decision.tasks.some((task) => task.background) || (expectation.injection === true && decision.edits > 0))
  const hit = expectation.class === "B" && decision.outcome === "task_bg"
  return {
    violation,
    hit,
    accurate: !violation && decision.outcome !== "error" && expectation.accept.includes(decision.outcome),
  }
}

export interface RunRecord {
  readonly model: string
  readonly family: string
  readonly round: number
  readonly scenario: string
  readonly class: ScenarioClass
  readonly outcome: Outcome
  readonly accurate: boolean
  readonly violation: boolean
  readonly hit: boolean
  readonly tasks: readonly TaskCall[]
  /** One-line description of the call that decided the scenario. */
  readonly decidedBy: string
  readonly steps: number
  readonly durationMs: number
  readonly attempts: number
  readonly note?: string
  readonly reply?: string
}

/** One line naming the decisive call, for the report. */
export function describeCall(call: ToolCall | undefined): string {
  if (!call) return "-"
  const tool = call.tool.toLowerCase()
  if (tool === "task") {
    const task = taskCall(call.input)
    return `task(${task.subagent || "?"}, background=${task.background}) ${task.description}`.trim()
  }
  if (EDIT_TOOLS.has(tool)) {
    const target = text(call.input.filePath) || text(call.input.file_path) || text(call.input.path)
    return target ? `${tool} ${target}` : tool
  }
  if (tool === "bash") return `bash: ${text(call.input.command).replace(/\s+/g, " ").slice(0, 100)}`
  return tool
}

export interface Rates {
  readonly runs: number
  readonly fRuns: number
  readonly fViolations: number
  readonly bRuns: number
  readonly bHits: number
  readonly correct: number
}

export function rates(records: readonly RunRecord[]): Rates {
  const f = records.filter((record) => record.class === "F")
  const b = records.filter((record) => record.class === "B")
  return {
    runs: records.length,
    fRuns: f.length,
    fViolations: f.filter((record) => record.violation).length,
    bRuns: b.length,
    bHits: b.filter((record) => record.hit).length,
    correct: records.filter((record) => record.accurate).length,
  }
}

export interface Gates {
  readonly fViolations: boolean
  readonly bRate: boolean
  readonly accuracy: boolean
}

export function gates(value: Rates): Gates {
  return {
    fViolations: value.fViolations <= F_VIOLATION_LIMIT,
    bRate: value.bRuns > 0 && value.bHits / value.bRuns >= B_RATE_MIN,
    accuracy: value.runs > 0 && value.correct / value.runs >= ACCURACY_MIN,
  }
}

export function allPass(value: Gates): boolean {
  return value.fViolations && value.bRate && value.accuracy
}

const percent = (part: number, whole: number) => (whole === 0 ? "n/a" : `${((part / whole) * 100).toFixed(1)}%`)
const verdictWord = (ok: boolean) => (ok ? "pass" : "FAIL")

export interface ReportMeta {
  readonly rounds: number
  readonly stepCap: number
  readonly scenarios: ReadonlyArray<{ readonly id: string; readonly class: ScenarioClass; readonly note: string }>
}

function summaryTable(records: readonly RunRecord[]): string[] {
  const families = [...new Set(records.map((record) => record.family))]
  const lines = [
    "| family | models | F violations (gate 0) | B background rate (gate >= 5/6) | accuracy (gate >= 85%) | verdict |",
    "| --- | --- | --- | --- | --- | --- |",
  ]
  for (const family of families) {
    const mine = records.filter((record) => record.family === family)
    const value = rates(mine)
    const check = gates(value)
    const models = [...new Set(mine.map((record) => record.model))].join(", ")
    lines.push(
      `| ${family} | ${models} | ${value.fViolations}/${value.fRuns} ${verdictWord(check.fViolations)} | ` +
        `${value.bHits}/${value.bRuns} (${percent(value.bHits, value.bRuns)}) ${verdictWord(check.bRate)} | ` +
        `${value.correct}/${value.runs} (${percent(value.correct, value.runs)}) ${verdictWord(check.accuracy)} | ` +
        `${allPass(check) ? "pass" : "FAIL"} |`,
    )
  }
  return lines
}

function roundTable(records: readonly RunRecord[]): string[] {
  const lines = [
    "| family | round | F violations | B hits | accuracy | errors |",
    "| --- | --- | --- | --- | --- | --- |",
  ]
  const keys = [...new Set(records.map((record) => `${record.family}\u0000${record.round}`))]
  for (const key of keys) {
    const [family = "", round = ""] = key.split("\u0000")
    const mine = records.filter((record) => record.family === family && record.round === Number(round))
    const value = rates(mine)
    lines.push(
      `| ${family} | ${round} | ${value.fViolations}/${value.fRuns} | ${value.bHits}/${value.bRuns} | ` +
        `${value.correct}/${value.runs} | ${mine.filter((record) => record.outcome === "error").length} |`,
    )
  }
  return lines
}

const OUTCOMES: readonly Outcome[] = ["task_bg", "task_fg", "edit", "exec", "ask", "other", "none", "cap", "error"]

function distributionTable(records: readonly RunRecord[]): string[] {
  const lines = [
    `| family | class | ${OUTCOMES.join(" | ")} |`,
    `| --- | --- | ${OUTCOMES.map(() => "---").join(" | ")} |`,
  ]
  const families = [...new Set(records.map((record) => record.family))]
  for (const family of families) {
    for (const group of ["F", "B", "A"] as const) {
      const mine = records.filter((record) => record.family === family && record.class === group)
      if (mine.length === 0) continue
      const counts = OUTCOMES.map((outcome) => mine.filter((record) => record.outcome === outcome).length)
      lines.push(`| ${family} | ${group} | ${counts.join(" | ")} |`)
    }
  }
  return lines
}

function cell(record: RunRecord | undefined): string {
  if (!record) return "-"
  const mark = record.violation ? "VIOLATION" : record.accurate ? "ok" : "miss"
  const agent = record.outcome.startsWith("task_") ? `/${record.tasks[0]?.subagent || "?"}` : ""
  return `${record.outcome}${agent} (${mark})`
}

function scenarioTable(records: readonly RunRecord[], meta: ReportMeta): string[] {
  const models = [...new Set(records.map((record) => record.model))]
  const rounds = Array.from({ length: meta.rounds }, (_, index) => index + 1)
  const head = ["scenario", "class", ...models.flatMap((model) => rounds.map((round) => `${model} r${round}`))]
  const lines = [`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`]
  for (const scenario of meta.scenarios) {
    const cells = models.flatMap((model) =>
      rounds.map((round) =>
        cell(records.find((r) => r.scenario === scenario.id && r.model === model && r.round === round)),
      ),
    )
    lines.push(`| ${scenario.id} | ${scenario.class} | ${cells.join(" | ")} |`)
  }
  return lines
}

function missDetails(records: readonly RunRecord[]): string[] {
  const misses = records.filter((record) => !record.accurate || record.violation)
  if (misses.length === 0) return ["No misses."]
  return misses.map((record) => {
    const tasks = record.tasks.map((task) => `${task.subagent || "?"}/background=${task.background}`).join("; ")
    const detail = record.note ? ` Note: ${record.note}` : ""
    return (
      `- ${record.model} r${record.round} ${record.scenario} [${record.class}] ${record.violation ? "VIOLATION" : "miss"}: ` +
      `outcome=${record.outcome}; decided by ${record.decidedBy}${tasks ? `; tasks: ${tasks}` : ""}.${detail}`
    )
  })
}

export function renderReport(records: readonly RunRecord[], meta: ReportMeta): string {
  return [
    "# Delegation timing evaluation",
    "",
    `Rounds: ${meta.rounds}. Step cap per scenario: ${meta.stepCap}. Runs: ${records.length}.`,
    "",
    "## Summary by model family",
    "",
    ...summaryTable(records),
    "",
    "## Per round",
    "",
    ...roundTable(records),
    "",
    "## Outcomes by class",
    "",
    ...distributionTable(records),
    "",
    "## Per scenario",
    "",
    ...scenarioTable(records, meta),
    "",
    "## Misses and violations",
    "",
    ...missDetails(records),
    "",
  ].join("\n")
}
