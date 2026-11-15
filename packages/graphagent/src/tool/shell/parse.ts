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

function nearest(node: Node | null, type: string) {
  let current: Node | null = node
  while (current) {
    if (current.type === type) return current
    current = current.parent
  }
  return undefined
}

function redirectTarget(node: Node) {
  for (let index = 0; index < node.childCount; index++) {
    const child = node.child(index)
    if (!child) continue
    if (child.type === "word" || child.type === "string" || child.type === "raw_string" || child.type === "concatenation")
      return child.text
    if (child.type === "redirected_file_name") return child.text.trim()
  }
  return undefined
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
    const operator = child.child(0)
    const target = redirectTarget(child)
    if (operator && target !== undefined) out.push({ op: operator.text.trim(), target })
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
    for (const statement of tree.rootNode.descendantsOfType("redirected_statement")) {
      if (!statement) continue
      const owned = redirectsOf(statement, ps)
      if (owned.length === 0) continue
      const inner = commands(statement)
      const last = inner.at(-1)
      if (!last) continue
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
    let nextPipeline = 0
    const out = commands(tree.rootNode)
      .map((node) => ({ node, start: node.startIndex, end: node.endIndex }))
      .toSorted((left, right) => left.start - right.start || left.end - right.end)
      .map(({ node }) => {
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
          argv: tokens(node),
          raw: source(node),
          redirects: redirects.get(identity(node)) ?? [],
          pipeline: group,
        } satisfies Segment
      })
    return out
  } finally {
    tree.delete()
  }
})