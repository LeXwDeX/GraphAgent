// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * Shell parsing shared by the bash tool and the DAG safety guard (#1031 M7).
 *
 * The tree-sitter parsers are loaded lazily, once per process. The bash tool
 * walks commands to find external directories and permission patterns; the
 * safety guard needs the same simple-command view plus the redirections a
 * statement carries. Keeping the tree access here means both callers agree on
 * what a command and its arguments are.
 */
export * as ShellParse from "./parse"

import { Effect } from "effect"
import { fileURLToPath } from "node:url"
import { Language, type Node } from "web-tree-sitter"
import { lazy } from "@/util/lazy"

export type Part = {
  type: string
  text: string
}

/** One redirection attached to the statement containing a command. */
export interface Redirect {
  /** The operator text: `>`, `>>`, `&>`, `>|`, `<`, ... */
  readonly op: string
  /** The raw destination/source token, quotes included. */
  readonly target: string
}

/** One simple command, in source order. */
export interface Segment {
  /** Command-name and argument tokens, quotes included. */
  readonly argv: readonly string[]
  /** The command's source text, used in safety reasons. */
  readonly raw: string
  /** Redirections attached to the statement this command ends. */
  readonly redirects: readonly Redirect[]
  /** Identity of the enclosing pipeline; distinct for every standalone command. */
  readonly pipeline: number
  /**
   * Enclosing subshell and pipeline-element identities, outer first and
   * `/`-joined (bash only). A `cd` in a subshell or pipeline element applies
   * to the rest of that scope and never moves the parent shell, so consumers
   * that track a working directory keep one state per scope.
   */
  readonly scope: string
  /**
   * Whether the shell reaches this statement: `maybe` for a conditional
   * operand or loop/branch body, `never` when a literal `true`/`false`
   * decides against it. A conditional `cd` must not be trusted.
   */
  readonly run: "always" | "maybe" | "never"
}

const resolveWasm = (asset: string) => {
  if (asset.startsWith("file://")) return fileURLToPath(asset)
  if (asset.startsWith("/") || /^[a-z]:/i.test(asset)) return asset
  const url = new URL(asset, import.meta.url)
  return fileURLToPath(url)
}

export function parts(node: Node): Part[] {
  const out: Part[] = []
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (!child) continue
    if (child.type === "command_elements") {
      for (let j = 0; j < child.childCount; j++) {
        const item = child.child(j)
        if (!item || item.type === "command_argument_sep" || item.type === "redirection") continue
        out.push({ type: item.type, text: item.text })
      }
      continue
    }
    if (
      child.type !== "command_name" &&
      child.type !== "command_name_expr" &&
      child.type !== "word" &&
      child.type !== "string" &&
      child.type !== "raw_string" &&
      child.type !== "concatenation"
    ) {
      continue
    }
    out.push({ type: child.type, text: child.text })
  }
  return out
}

/**
 * Every word of one simple command, including numbers and expansions. `parts`
 * keeps the bash tool's historical shape (it skips both); the safety guard
 * needs them: `chmod 777`, `kill -9 -1` and `tee $OUTPUT` are only decidable
 * with the complete token list.
 */
export function tokens(node: Node): string[] {
  const out: string[] = []
  for (let index = 0; index < node.childCount; index++) {
    const child = node.child(index)
    if (!child) continue
    if (child.type === "command_elements") {
      for (let inner = 0; inner < child.childCount; inner++) {
        const item = child.child(inner)
        if (!item || item.type === "command_argument_sep" || item.type === "redirection") continue
        out.push(item.text)
      }
      continue
    }
    if (child.type === "command_argument_sep" || child.type === "redirection") continue
    out.push(child.text)
  }
  return out
}

export function source(node: Node) {
  return (node.parent?.type === "redirected_statement" ? node.parent.text : node.text).trim()
}

export function commands(node: Node) {
  return node.descendantsOfType("command").filter((child): child is Node => Boolean(child))
}

export function unquote(text: string) {
  if (text.length < 2) return text
  const first = text[0]
  const last = text[text.length - 1]
  if ((first === '"' || first === "'") && first === last) return text.slice(1, -1)
  return text
}

const parser = lazy(async () => {
  const { Parser } = await import("web-tree-sitter")
  const { default: treeWasm } = await import("web-tree-sitter/tree-sitter.wasm" as string, {
    with: { type: "wasm" },
  })
  const treePath = resolveWasm(treeWasm)
  await Parser.init({
    locateFile() {
      return treePath
    },
  })
  const { default: bashWasm } = await import("tree-sitter-bash/tree-sitter-bash.wasm" as string, {
    with: { type: "wasm" },
  })
  const { default: psWasm } = await import("tree-sitter-powershell/tree-sitter-powershell.wasm" as string, {
    with: { type: "wasm" },
  })
  const bashPath = resolveWasm(bashWasm)
  const psPath = resolveWasm(psWasm)
  const [bashLanguage, psLanguage] = await Promise.all([Language.load(bashPath), Language.load(psPath)])
  const bash = new Parser()
  bash.setLanguage(bashLanguage)
  const ps = new Parser()
  ps.setLanguage(psLanguage)
  return { bash, ps }
})

export const parse = Effect.fn("ShellParse.parse")(function* (command: string, ps: boolean) {
  const engines = yield* Effect.promise(() => parser())
  const tree = engines[ps ? "ps" : "bash"].parse(command)
  if (!tree) throw new Error("Failed to parse command")
  return tree
})

function identity(node: Node) {
  return `${node.type}:${node.startIndex}:${node.endIndex}`
}

const SCOPES = new Set(["subshell", "command_substitution", "process_substitution"])

/** The direct child of `pipeline` containing `node`: one pipeline element. */
function pipelineElement(node: Node, pipeline: Node) {
  let element = node
  while (element.parent && identity(element.parent) !== identity(pipeline)) element = element.parent
  return element
}

/**
 * Scope of one command (bash only): its enclosing subshells and its pipeline
 * element. A pipeline element runs in its own subshell, so a `cd` there
 * applies to the rest of that element and never to the parent shell.
 */
function shellScope(node: Node, ps: boolean) {
  if (ps) return { scope: "" }
  const ancestors: string[] = []
  let current: Node | null = node.parent
  while (current) {
    if (SCOPES.has(current.type)) ancestors.push(identity(current))
    else if (current.type === "pipeline") ancestors.push(identity(pipelineElement(node, current)))
    current = current.parent
  }
  return { scope: ancestors.reverse().join("/") }
}

/** Compound statements that open their redirects before running the body. */
const entryRedirect = (type: string) =>
  type === "subshell" || type === "compound_statement" || type === "function_definition" || type.endsWith("_statement")

const CONDITIONAL_CONTAINERS = new Set([
  "if_statement",
  "while_statement",
  "for_statement",
  "c_style_for_statement",
  "case_statement",
  "do_group",
  "elif_clause",
  "else_clause",
])

function directChild(parent: Node, node: Node) {
  let current = node
  while (current.parent && identity(current.parent) !== identity(parent)) current = current.parent
  return current
}

/** Literal verdict of a one-word `true`/`:`/`false` operand, when it has one. */
function literalTruth(node: Node | undefined): boolean | undefined {
  if (!node || node.type !== "command") return undefined
  const argv = tokens(node)
  if (argv.length !== 1) return undefined
  const name = unquote(argv[0] ?? "")
  if (name === "true" || name === ":") return true
  if (name === "false") return false
  return undefined
}

/** Literal truth of the `&&`/`||` chain before an operand at `last`. */
function chainTruth(children: readonly Node[], last: number): boolean | undefined {
  let value = literalTruth(children[0])
  for (let index = 1; index + 1 <= last; index += 2) {
    const operator = children[index]
    if (!operator || (operator.type !== "&&" && operator.type !== "||")) return undefined
    const truth = literalTruth(children[index + 1])
    if (value === undefined || truth === undefined) return undefined
    value = operator.type === "&&" ? value && truth : value || truth
  }
  return value
}

/** Whether the shell reaches this operand of an `&&`/`||` list. */
function listVerdict(list: Node, node: Node): "always" | "maybe" | "never" {
  const branch = directChild(list, node)
  const children: Node[] = []
  for (let index = 0; index < list.childCount; index++) {
    const child = list.child(index)
    if (child) children.push(child)
  }
  const index = children.findIndex((child) => identity(child) === identity(branch))
  if (index < 2) return "always"
  const operator = children[index - 1]
  if (!operator || (operator.type !== "&&" && operator.type !== "||")) return "always"
  const truth = chainTruth(children, index - 2)
  if (truth === undefined) return "maybe"
  if (operator.type === "&&") return truth ? "always" : "never"
  return truth ? "never" : "always"
}

/**
 * Whether the shell reaches a statement (bash only). Conditional operands,
 * loop bodies and if/case branches may not run; a literal `true`/`false`
 * condition resolves the common cases exactly.
 */
function executionOf(node: Node, ps: boolean): "always" | "maybe" | "never" {
  if (ps) return "always"
  let verdict: "always" | "maybe" | "never" = "always"
  let current: Node = node
  while (current.parent) {
    const parent = current.parent
    if (parent.type === "list") {
      const next = listVerdict(parent, node)
      if (next === "never") return "never"
      if (next === "maybe") verdict = "maybe"
    } else if (CONDITIONAL_CONTAINERS.has(parent.type)) {
      verdict = "maybe"
    }
    current = parent
  }
  return verdict
}

function nearest(node: Node | null, type: string) {
  let current: Node | null = node
  while (current) {
    if (current.type === type) return current
    current = current.parent
  }
  return undefined
}

function redirectTarget(node: Node) {
  // Adjacent quoted and unquoted fragments form one word (`..'/'victim`);
  // re-join them so the guard decodes the same file name bash opens.
  const parts: string[] = []
  for (let index = 0; index < node.childCount; index++) {
    const child = node.child(index)
    if (!child) continue
    if (
      child.type === "word" ||
      child.type === "string" ||
      child.type === "raw_string" ||
      child.type === "concatenation"
    )
      parts.push(child.text)
    else if (child.type === "redirected_file_name") parts.push(child.text.trim())
  }
  return parts.length > 0 ? parts.join("") : undefined
}

function redirectsOf(statement: Node, ps: boolean): Redirect[] {
  const out: Redirect[] = []
  if (ps) {
    for (const node of statement.descendantsOfType("redirection")) {
      if (!node) continue
      const operator = node.child(0)
      const target = redirectTarget(node)
      if (operator && target !== undefined) out.push({ op: operator.text.trim(), target })
    }
    return out
  }
  for (let index = 0; index < statement.childCount; index++) {
    const child = statement.child(index)
    if (!child || child.type !== "file_redirect") continue
    // A file descriptor (`2>`/`0<`) precedes the operator; the operator is the
    // first remaining punctuation child.
    let operator: Node | undefined
    for (let inner = 0; inner < child.childCount; inner++) {
      const item = child.child(inner)
      if (!item || item.type === "file_descriptor") continue
      if (item.type === "redirected_file_name" || item.type === "word" || item.type === "string") continue
      if (item.type === "raw_string" || item.type === "concatenation") continue
      operator = item
      break
    }
    const target = redirectTarget(child)
    // tree-sitter parses `<>` as `<` plus an error token; keep the raw form
    // because it writes (and creates) as well as reads.
    const op = /^(?:\d+)?<>/.test(child.text.trim()) ? "<>" : operator?.text.trim()
    if (op && target !== undefined) out.push({ op, target })
  }
  return out
}

/**
 * Simple commands with the redirections their statement carries. A redirect on
 * a `&&`/`;` list belongs to the list's last command, matching shell
 * evaluation; nested command substitutions contribute their own commands.
 */
export const segments = Effect.fn("ShellParse.segments")(function* (command: string, ps: boolean) {
  const tree = yield* parse(command, ps)
  try {
    const redirects = new Map<string, Redirect[]>()
    // A redirect with no command still writes (`> file`): keep it as its own
    // commandless segment so consumers can evaluate the target.
    const commandless: { start: number; end: number; segment: Segment }[] = []
    let nextPipeline = 0
    for (const statement of tree.rootNode.descendantsOfType("redirected_statement")) {
      if (!statement) continue
      const owned = redirectsOf(statement, ps)
      if (owned.length === 0) continue
      const inner = commands(statement)
      const last = inner.at(-1)
      if (!last) {
        commandless.push({
          start: statement.startIndex,
          end: statement.endIndex,
          segment: {
            argv: [],
            raw: statement.text.trim(),
            redirects: owned,
            pipeline: nextPipeline++,
            ...shellScope(statement, ps),
            run: executionOf(statement, ps),
          },
        })
        continue
      }
      // A compound statement opens its redirect before running the body, so
      // the target resolves against the entry cwd, not the last inner `cd`.
      let branch: Node = last
      while (branch.parent && identity(branch.parent) !== identity(statement)) branch = branch.parent
      if (entryRedirect(branch.type)) {
        commandless.push({
          start: statement.startIndex,
          end: statement.endIndex,
          segment: {
            argv: [],
            raw: statement.text.trim(),
            redirects: owned,
            pipeline: nextPipeline++,
            ...shellScope(statement, ps),
            run: executionOf(statement, ps),
          },
        })
        continue
      }
      redirects.set(identity(last), owned)
    }
    if (ps) {
      for (const redirect of tree.rootNode.descendantsOfType("redirection")) {
        if (!redirect) continue
        const owner = redirect.parent
        if (!owner) continue
        const cmd = owner.type === "command" ? owner : nearest(owner, "command")
        if (!cmd) continue
        if (redirects.has(identity(cmd))) continue
        const operator = redirect.child(0)
        const target = redirectTarget(redirect)
        if (operator && target !== undefined) redirects.set(identity(cmd), [{ op: operator.text.trim(), target }])
      }
    }

    const pipelines = new Map<string, number>()
    const entries = commands(tree.rootNode)
      .map((node) => ({ node, start: node.startIndex, end: node.endIndex }))
      .toSorted((left, right) => left.start - right.start || left.end - right.end)
      .map(({ node, start, end }) => {
        const pipeline = nearest(node.parent, "pipeline")
        let group: number
        if (pipeline) {
          const key = identity(pipeline)
          const found = pipelines.get(key)
          group = found ?? nextPipeline++
          pipelines.set(key, group)
        } else {
          group = nextPipeline++
        }
        return {
          start,
          end,
          segment: {
            argv: tokens(node),
            raw: source(node),
            redirects: redirects.get(identity(node)) ?? [],
            pipeline: group,
            ...shellScope(node, ps),
            run: executionOf(node, ps),
          } satisfies Segment,
        }
      })
    return [...entries, ...commandless]
      .toSorted((left, right) => left.start - right.start || left.end - right.end)
      .map((entry) => entry.segment)
  } finally {
    tree.delete()
  }
})