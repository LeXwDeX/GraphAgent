// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * Project-trust entry enumeration (T1 PR1).
 *
 * This module is a pure function over file contents: callers read the project
 * layer (`<root>/.agents/`) and pass the raw text. It never touches the disk
 * itself, never composes an Effect layer and does not decide trust; it only
 * lists what the project layer could execute.
 *
 * Local files (`hooks.local.json`, `settings.local.json`) are project entries
 * only when git tracks them, so a repository cannot smuggle executable
 * configuration in by committing a file that is normally local. An untracked
 * local file is the user's own configuration and is left out of the trust flow.
 */
import path from "path"
import {
  findNodeAtLocation,
  parse as parseJsonc,
  parseTree,
  type JSONPath,
  type Node,
  type ParseError,
} from "jsonc-parser"
import { ConfigMarkdown } from "@graphagent/core/config/markdown"
import { configEntryNameFromPath } from "@/config/entry-name"
import { shell as shellSegments } from "@/config/markdown"
import { HookCommandSchema } from "@/hook/schema"
import type { HookCommand } from "@/hook/types"
import { VALID_HOOK_EVENTS } from "@/hook/types"
import { isRecord } from "@/util/record"
import { entryLocation } from "./location"
import { canonicalize } from "./normalize"
import { shellTokens } from "./shell"
import type { EntryDisplay, TrustEntry } from "./types"

/** Files whose entries are trusted by default unless git tracks the file. */
export const LOCAL_PROJECT_FILES: readonly string[] = ["hooks.local.json", "settings.local.json"]

/** One project-layer file supplied by the caller. */
export interface ProjectLayerFile {
  /** Path relative to `<root>/.agents`, POSIX separators. */
  file: string
  /** Raw file text. Callers only pass files that exist. */
  text: string
}

export interface EnumerationInput {
  files: readonly ProjectLayerFile[]
  /**
   * Git tracking probe for a path relative to `<root>/.agents`. Non-git
   * directories report every path as untracked, matching the Issue rule.
   */
  isTracked: (file: string) => boolean
}

export interface EnumerationResult {
  /** Project entries that need a trust decision, in deterministic file order. */
  entries: TrustEntry[]
  /** Local files skipped because git does not track them (user configuration). */
  ignoredLocalFiles: string[]
  /** Files with unreadable JSON/shape; they yielded no entries. */
  invalidFiles: string[]
}

/** Enumerate every trust-relevant entry declared by the project layer. */
export function enumerateProjectEntries(input: EnumerationInput): EnumerationResult {
  const drafts: EntryDraft[] = []
  const invalidFiles: string[] = []
  const ignoredLocalFiles: string[] = []
  const files = [...input.files]
    .map((file) => ({ ...file, file: normalizeFile(file.file) }))
    .toSorted((a, b) => a.file.localeCompare(b.file))

  for (const file of files) {
    if (LOCAL_PROJECT_FILES.includes(file.file) && !input.isTracked(file.file)) {
      ignoredLocalFiles.push(file.file)
      continue
    }
    if (file.file === "hooks.json" || file.file === "hooks.local.json") {
      collectHookFile(drafts, invalidFiles, file.file, file.text)
    } else if (file.file === "mcp.json") {
      collectMcpFile(drafts, invalidFiles, file.file, file.text)
    } else if (file.file === "settings.json" || file.file === "settings.local.json") {
      collectSettingsFile(drafts, invalidFiles, file.file, file.text)
    } else if (isSkillFile(file.file)) {
      collectSkillFile(drafts, invalidFiles, file.file, file.text)
    } else if (isAgentFile(file.file)) {
      collectAgentFile(drafts, invalidFiles, file.file, file.text)
    } else if (isCommandFile(file.file)) {
      collectCommandFile(drafts, invalidFiles, file.file, file.text)
    }
  }

  return { entries: assignLocations(drafts), ignoredLocalFiles, invalidFiles }
}

type EntryDraft = Omit<TrustEntry, "id" | "index">

function assignLocations(drafts: readonly EntryDraft[]): TrustEntry[] {
  const counts = new Map<string, number>()
  return drafts.map((draft) => {
    const key = [draft.source.file, draft.category, draft.label, draft.matcher ?? ""].join("\u0000")
    const index = (counts.get(key) ?? 0) + 1
    counts.set(key, index)
    return {
      ...draft,
      index,
      id: entryLocation({
        file: draft.source.file,
        category: draft.category,
        label: draft.label,
        matcher: draft.matcher,
        index,
      }),
    }
  })
}

function isSkillFile(file: string) {
  return file.startsWith("skills/") && file.endsWith("/SKILL.md")
}

function isAgentFile(file: string) {
  return file.startsWith("agents/") && file.endsWith(".md")
}

function isCommandFile(file: string) {
  return file.startsWith("commands/") && file.endsWith(".md")
}

// ── JSON sources ───────────────────────────────────────────────

interface JsonDocument {
  value: unknown
  tree: Node
  text: string
}

function parseJson(text: string): JsonDocument | undefined {
  const treeErrors: ParseError[] = []
  const tree = parseTree(text, treeErrors, { allowTrailingComma: true })
  const valueErrors: ParseError[] = []
  const value = parseJsonc(text, valueErrors, { allowTrailingComma: true })
  if (!tree || treeErrors.length || valueErrors.length) return undefined
  return { value, tree, text }
}

function lineAt(text: string, offset: number): number {
  let line = 1
  for (let index = 0; index < offset; index++) if (text.charCodeAt(index) === 10) line++
  return line
}

function lineOf(document: JsonDocument, location: JSONPath): number | undefined {
  const node = findNodeAtLocation(document.tree, location)
  return node ? lineAt(document.text, node.offset) : undefined
}

function collectHookFile(drafts: EntryDraft[], invalidFiles: string[], file: string, text: string) {
  const document = parseJson(text)
  if (!document || !isRecord(document.value)) {
    invalidFiles.push(file)
    return
  }
  // A legacy `{"hooks": {...}}` wrapper is ignored by the runtime loader; a
  // trust list that read it would show hooks that never run.
  if (isRecord(document.value.hooks)) return
  collectHookValue(drafts, "hook", file, document.value, {
    line: (event, group, hook) => lineOf(document, [event, group, "hooks", hook]),
  })
}

function collectMcpFile(drafts: EntryDraft[], invalidFiles: string[], file: string, text: string) {
  const document = parseJson(text)
  if (!document || !isRecord(document.value) || !isRecord(document.value.mcpServers)) {
    invalidFiles.push(file)
    return
  }
  for (const [name, candidate] of Object.entries(document.value.mcpServers)) {
    if (!isRecord(candidate)) continue
    const type = candidate.type
    if (type !== "local" && type !== "remote") continue
    const command = stringArray(candidate.command)
    if (type === "local" && command.length === 0) continue
    if (type === "remote" && typeof candidate.url !== "string") continue

    const url = type === "remote" && typeof candidate.url === "string" ? candidate.url : undefined
    const environment = type === "local" && isRecord(candidate.environment) ? candidate.environment : undefined
    const cwd = type === "local" && typeof candidate.cwd === "string" ? candidate.cwd : undefined
    const line = lineOf(document, ["mcpServers", name])
    drafts.push({
      category: "mcp",
      label: name,
      source: { file, ...(line === undefined ? {} : { line }) },
      canonical: canonicalize("mcp", candidate),
      references: type === "local" ? unique(command.flatMap(referenceToken)) : [],
      ...(cwd === undefined ? {} : { cwd }),
      display: {
        text: url ?? command.join(" "),
        commands: type === "local" && command.length ? [command.join(" ")] : [],
        urls: url === undefined ? [] : [url],
        envKeys: environment ? Object.keys(environment) : [],
      },
      mcpType: type,
    })
  }
}

function collectSettingsFile(drafts: EntryDraft[], invalidFiles: string[], file: string, text: string) {
  const document = parseJson(text)
  if (!document || !isRecord(document.value)) {
    invalidFiles.push(file)
    return
  }
  const value = document.value

  if (isRecord(value.formatter)) {
    for (const [name, candidate] of Object.entries(value.formatter)) {
      if (!isRecord(candidate)) continue
      const command = stringArray(candidate.command)
      if (command.length === 0) continue
      const line = lineOf(document, ["formatter", name])
      const environment = isRecord(candidate.environment) ? candidate.environment : undefined
      drafts.push({
        category: "formatter",
        label: name,
        source: { file, ...(line === undefined ? {} : { line }) },
        canonical: canonicalize("formatter", candidate),
        references: unique(command.flatMap(referenceToken)),
        display: {
          text: command.join(" "),
          commands: [command.join(" ")],
          urls: [],
          envKeys: environment ? Object.keys(environment) : [],
        },
      })
    }
  }

  if (isRecord(value.lsp)) {
    for (const [name, candidate] of Object.entries(value.lsp)) {
      if (!isRecord(candidate)) continue
      const command = stringArray(candidate.command)
      if (command.length === 0) continue
      const line = lineOf(document, ["lsp", name])
      const env = isRecord(candidate.env) ? candidate.env : undefined
      drafts.push({
        category: "lsp",
        label: name,
        source: { file, ...(line === undefined ? {} : { line }) },
        canonical: canonicalize("lsp", candidate),
        references: unique(command.flatMap(referenceToken)),
        display: {
          text: command.join(" "),
          commands: [command.join(" ")],
          urls: [],
          envKeys: env ? Object.keys(env) : [],
        },
      })
    }
  }

  if (isRecord(value.agent)) {
    for (const [agent, candidate] of Object.entries(value.agent)) {
      if (!isRecord(candidate) || candidate.hooks === undefined) continue
      collectHookValue(drafts, "agent-hook", file, candidate.hooks, {
        agent,
        line: (event, group, hook) => lineOf(document, ["agent", agent, "hooks", event, group, "hooks", hook]),
      })
    }
  }
}

// ── Markdown sources ───────────────────────────────────────────

function collectSkillFile(drafts: EntryDraft[], invalidFiles: string[], file: string, text: string) {
  const frontmatter = parseFrontmatter(text, file, invalidFiles)
  if (!frontmatter || frontmatter.data.hooks === undefined) return
  collectHookValue(drafts, "skill-hook", file, frontmatter.data.hooks)
}

function collectAgentFile(drafts: EntryDraft[], invalidFiles: string[], file: string, text: string) {
  const frontmatter = parseFrontmatter(text, file, invalidFiles)
  if (!frontmatter || frontmatter.data.hooks === undefined) return
  collectHookValue(drafts, "agent-hook", file, frontmatter.data.hooks)
}

function collectCommandFile(drafts: EntryDraft[], invalidFiles: string[], file: string, text: string) {
  const frontmatter = parseFrontmatter(text, file, invalidFiles)
  if (!frontmatter) return
  const template = frontmatter.content.trim()
  const contentStart = text.indexOf(frontmatter.content)
  const leading = frontmatter.content.length - frontmatter.content.trimStart().length
  const name = configEntryNameFromPath(file, ["commands/"])
  for (const match of shellSegments(template)) {
    const command = match[1]?.trim()
    if (!command) continue
    const offset = contentStart >= 0 ? contentStart + leading + (match.index ?? 0) : undefined
    drafts.push({
      category: "command-shell",
      label: name,
      source: { file, ...(offset === undefined ? {} : { line: lineAt(text, offset) }) },
      canonical: canonicalize("command-shell", { command }),
      references: unique(shellTokens(command).flatMap(referenceToken)),
      display: { text: command, commands: [command], urls: [], envKeys: [] },
    })
  }
}

function parseFrontmatter(text: string, file: string, invalidFiles: string[]) {
  try {
    return ConfigMarkdown.parse(text)
  } catch {
    invalidFiles.push(file)
    return undefined
  }
}

// ── Hook groups ────────────────────────────────────────────────

interface HookValueOptions {
  agent?: string
  line?: (event: string, group: number, hook: number) => number | undefined
}

function collectHookValue(
  drafts: EntryDraft[],
  category: "hook" | "skill-hook" | "agent-hook",
  file: string,
  value: unknown,
  options: HookValueOptions = {},
) {
  if (!isRecord(value)) return
  for (const [event, groups] of Object.entries(value)) {
    if (!VALID_HOOK_EVENTS.has(event) || !Array.isArray(groups)) continue
    groups.forEach((group, groupIndex) => {
      if (!isRecord(group) || !Array.isArray(group.hooks)) return
      const matcher = typeof group.matcher === "string" ? group.matcher : undefined
      group.hooks.forEach((candidate, hookIndex) => {
        const parsed = HookCommandSchema.safeParse(candidate)
        if (!parsed.success) return
        const hook = parsed.data
        const line = options.line?.(event, groupIndex, hookIndex)
        drafts.push({
          category,
          label: event,
          ...(matcher === undefined ? {} : { matcher }),
          source: { file, ...(line === undefined ? {} : { line }) },
          canonical: canonicalize(category, hookRaw(hook, event, matcher, options.agent)),
          references: hookReferences(hook),
          display: hookDisplay(hook),
          kind: hook.type,
        })
      })
    })
  }
}

function hookRaw(hook: HookCommand, event: string, matcher: string | undefined, agent: string | undefined) {
  return {
    ...hook,
    event,
    ...(matcher === undefined ? {} : { matcher }),
    ...(agent === undefined ? {} : { agent }),
  }
}

function hookDisplay(hook: HookCommand): EntryDisplay {
  switch (hook.type) {
    case "command": {
      const args = hook.args ?? []
      const text = args.length ? [hook.command ?? "", ...args].join(" ").trim() : (hook.command ?? "")
      return { text, commands: text ? [text] : [], urls: [], envKeys: [] }
    }
    case "http":
      return { text: hook.url ?? "", commands: [], urls: hook.url ? [hook.url] : [], envKeys: [] }
    case "mcp_tool":
      return { text: `${hook.server ?? ""}/${hook.tool ?? ""}`, commands: [], urls: [], envKeys: [] }
    case "prompt":
    case "agent":
      return { text: hook.prompt ?? "", commands: [], urls: [], envKeys: [] }
    default:
      return { text: "", commands: [], urls: [], envKeys: [] }
  }
}

function hookReferences(hook: HookCommand): string[] {
  if (hook.type !== "command") return []
  const command = hook.command ?? ""
  const args = hook.args
  const tokens = args === undefined ? shellTokens(command) : [command, ...args]
  return unique(tokens.flatMap(referenceToken))
}

// ── File reference tokens ──────────────────────────────────────

/** Extensions that make a bare token worth resolving as a project file. */
const REFERENCE_EXTENSIONS = new Set([
  ".sh",
  ".bash",
  ".zsh",
  ".fish",
  ".ps1",
  ".bat",
  ".cmd",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".rb",
  ".pl",
  ".php",
  ".lua",
  ".go",
  ".rs",
  ".env",
  ".json",
  ".jsonc",
  ".toml",
  ".yaml",
  ".yml",
  ".ini",
  ".conf",
])

/**
 * Return a path-shaped token, or undefined for flags, URLs, expansions and
 * plain words. `@file` (curl data syntax) and `--flag=value` are unwrapped.
 */
function referenceToken(word: string): string | undefined {
  let token = word
  if (token.startsWith("-") && token.includes("=")) token = token.slice(token.indexOf("=") + 1)
  if (token.startsWith("@")) token = token.slice(1)
  if (!token || token.startsWith("-")) return undefined
  if (token.includes("://") || token.includes("$") || token.includes("{") || token.includes("}")) return undefined
  if (token === "~" || token.startsWith("~/")) return undefined
  const looksLikePath =
    token.startsWith(".") || token.includes("/") || REFERENCE_EXTENSIONS.has(path.extname(token).toLowerCase())
  return looksLikePath ? token.replaceAll("\\", "/") : undefined
}

// ── Small helpers ──────────────────────────────────────────────

function normalizeFile(file: string) {
  return file.replaceAll("\\", "/").replace(/^\.\//, "")
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === "string")
}

function unique(values: readonly (string | undefined)[]): string[] {
  return Array.from(new Set(values.filter((value): value is string => value !== undefined && value.length > 0)))
}
