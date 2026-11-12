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

/** hooks.json is read with strict `JSON.parse`; settings/mcp.json are JSONC. */
function parseJson(text: string, mode: "strict" | "jsonc"): JsonDocument | undefined {
  const options =
    mode === "strict" ? { allowTrailingComma: false, disallowComments: true } : { allowTrailingComma: true }
  const treeErrors: ParseError[] = []
  const tree = parseTree(text, treeErrors, options)
  const valueErrors: ParseError[] = []
  const value = parseJsonc(text, valueErrors, options)
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
  const document = parseJson(text, "strict")
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
  const document = parseJson(text, "jsonc")
  if (!document || !isRecord(document.value) || !isRecord(document.value.mcpServers)) {
    invalidFiles.push(file)
    return
  }
  collectMcpValue(drafts, file, document.value.mcpServers, (location) => lineOf(document, location))
}

/**
 * Enumerate one project `mcp.json` document's servers. Exported so the MCP
 * service can build the same entries from the raw project-layer value and let
 * `ProjectTrust.gate` decide before a server is created. Input is the whole
 * document (with `mcpServers`), matching what the caller parsed from disk.
 */
export function mcpEntries(file: string, value: unknown): TrustEntry[] {
  const drafts: EntryDraft[] = []
  if (isRecord(value) && isRecord(value.mcpServers))
    collectMcpValue(drafts, file, value.mcpServers, () => undefined)
  return assignLocations(drafts)
}

function collectMcpValue(
  drafts: EntryDraft[],
  file: string,
  servers: Record<string, unknown>,
  lineFor: (location: JSONPath) => number | undefined,
) {
  for (const [name, candidate] of Object.entries(servers)) {
    if (!isRecord(candidate)) continue
    const type = candidate.type
    if (type !== "local" && type !== "remote") continue
    const command = stringArray(candidate.command)
    if (type === "local" && command.length === 0) continue
    if (type === "remote" && typeof candidate.url !== "string") continue

    const url = type === "remote" && typeof candidate.url === "string" ? candidate.url : undefined
    const environment = type === "local" && isRecord(candidate.environment) ? candidate.environment : undefined
    const cwd = type === "local" && typeof candidate.cwd === "string" ? candidate.cwd : undefined
    const line = lineFor(["mcpServers", name])
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
  const document = parseJson(text, "jsonc")
  if (!document || !isRecord(document.value)) {
    invalidFiles.push(file)
    return
  }
  collectSettingsValue(drafts, file, document.value, (location) => lineOf(document, location))
}

/**
 * Enumerate the trust-relevant entries of a project settings object. Exported
 * so the Config loader can build the same entries from its decoded value and
 * let `ProjectTrust.gate` decide before the project layer merges.
 */
export function settingsEntries(file: string, value: unknown): TrustEntry[] {
  const drafts: EntryDraft[] = []
  if (isRecord(value)) collectSettingsValue(drafts, file, value, () => undefined)
  return assignLocations(drafts)
}

/**
 * Strip every settings entry `keep` refuses from a parsed settings object. The
 * input is cloned and the caller decodes the result as usual. Entries are
 * enumerated with the same traversal and index assignment as the trust list,
 * so `keep` sees the exact `TrustEntry` the gate checked. A refused formatter
 * loses `command`/`environment` but keeps `extensions`/`disabled`; a refused
 * LSP server is removed whole; a refused setting-level hook is removed from
 * its group. Inline command shells are not removed — they are refused when the
 * command runs, because the template itself is inert text.
 */
export function filterSettingsValue(file: string, input: unknown, keep: (entry: TrustEntry) => boolean): unknown {
  if (!isRecord(input)) return input
  const value = structuredClone(input)
  const drafts: EntryDraft[] = []
  const removals: Array<() => void> = []
  collectSettingsValue(drafts, file, value, () => undefined, removals)
  const entries = assignLocations(drafts)
  entries.forEach((entry, index) => {
    if (keep(entry)) return
    removals[index]?.()
  })
  return value
}

/** Whether a parsed project settings object sets a top-level `shell`. */
export function hasProjectShell(value: unknown): boolean {
  return isRecord(value) && value.shell !== undefined
}

/**
 * Strip a project-layer `shell` from a parsed settings object, falling back
 * to the built-in default shell.
 *
 * `shell` names the interpreter for every bash-tool and command-shell
 * invocation -- including ones already trusted -- and a relative value
 * containing a path separator resolves against the running process's cwd
 * rather than `$PATH` (see `Shell.preferred` / the `which` package), so a
 * project can point it at a script it ships. Unlike formatter/lsp commands
 * or hooks it is not enumerated as a `TrustEntry` here: there is no
 * per-occurrence declaration to show in the trust panel or ever record a
 * decision for. The gate call this backs always refuses it (the project
 * layer's `entry: undefined` fails closed), so the removal is unconditional
 * rather than driven by a `keep` callback like `filterSettingsValue` (#1040).
 */
export function stripProjectShell(value: unknown): unknown {
  if (!isRecord(value) || value.shell === undefined) return value
  const clone = structuredClone(value)
  delete clone.shell
  return clone
}

function collectSettingsValue(
  drafts: EntryDraft[],
  file: string,
  value: Record<string, unknown>,
  lineFor: (location: JSONPath) => number | undefined,
  /** Parallel to `drafts`: strips the entry's execution fields from `value`. */
  removals?: Array<() => void>,
) {
  if (isRecord(value.formatter)) {
    for (const [name, candidate] of Object.entries(value.formatter)) {
      if (!isRecord(candidate)) continue
      const command = stringArray(candidate.command)
      const environment = isRecord(candidate.environment) ? candidate.environment : undefined
      const envKeys = environment ? Object.keys(environment) : []
      // An environment-only entry still reaches the built-in formatter of the
      // same name as process environment, so it needs trust like a command.
      if (command.length === 0 && envKeys.length === 0) continue
      const line = lineFor(["formatter", name])
      removals?.push(() => {
        // `extensions` and `disabled` stay: they only decide when the
        // formatter runs, not what it runs.
        delete candidate.command
        delete candidate.environment
      })
      drafts.push({
        category: "formatter",
        label: name,
        source: { file, ...(line === undefined ? {} : { line }) },
        canonical: canonicalize("formatter", candidate),
        references: unique(command.flatMap(referenceToken)),
        display: {
          text: command.length > 0 ? command.join(" ") : `environment: ${envKeys.join(", ")}`,
          commands: command.length > 0 ? [command.join(" ")] : [],
          urls: [],
          envKeys,
        },
      })
    }
  }

  if (isRecord(value.lsp)) {
    for (const [name, candidate] of Object.entries(value.lsp)) {
      if (!isRecord(candidate)) continue
      const command = stringArray(candidate.command)
      if (command.length === 0) continue
      const line = lineFor(["lsp", name])
      const env = isRecord(candidate.env) ? candidate.env : undefined
      // A custom LSP entry requires `command`, so a refused server is removed
      // whole rather than left with a missing required field.
      removals?.push(() => {
        delete (value.lsp as Record<string, unknown>)[name]
      })
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

  // Inline `command.<name>` entries run `!`shell`` segments exactly like
  // command files, so each segment is its own trust entry.
  if (isRecord(value.command)) {
    for (const [name, candidate] of Object.entries(value.command)) {
      if (!isRecord(candidate) || typeof candidate.template !== "string") continue
      const template = candidate.template
      const base = lineFor(["command", name])
      for (const match of shellSegments(template)) {
        const command = match[1]?.trim()
        if (!command) continue
        // Shell segments are refused at execution time (the command template
        // stays registered as a prompt); the gate check needs a parallel entry.
        removals?.push(() => {})
        drafts.push({
          category: "command-shell",
          label: name,
          source: { file, ...(base === undefined ? {} : { line: base }) },
          canonical: canonicalize("command-shell", { command }),
          references: unique(shellTokens(command).flatMap(referenceToken)),
          display: { text: command, commands: [command], urls: [], envKeys: [] },
        })
      }
    }
  }

  if (isRecord(value.agent)) {
    for (const [agent, candidate] of Object.entries(value.agent)) {
      if (!isRecord(candidate) || candidate.hooks === undefined) continue
      collectHookValue(
        drafts,
        "agent-hook",
        file,
        candidate.hooks,
        {
          agent,
          line: (event, group, hook) => lineFor(["agent", agent, "hooks", event, group, "hooks", hook]),
          removals,
        },
      )
    }
  }

  if (isRecord(value.mode)) {
    for (const [mode, candidate] of Object.entries(value.mode)) {
      if (!isRecord(candidate) || candidate.hooks === undefined) continue
      collectHookValue(
        drafts,
        "agent-hook",
        file,
        candidate.hooks,
        {
          agent: mode,
          line: (event, group, hook) => lineFor(["mode", mode, "hooks", event, group, "hooks", hook]),
          removals,
        },
      )
    }
  }
}

// ── Markdown sources ───────────────────────────────────────────

function collectSkillFile(drafts: EntryDraft[], invalidFiles: string[], file: string, text: string) {
  const frontmatter = parseFrontmatter(text, file, invalidFiles)
  if (!frontmatter) return
  if (frontmatter.data.hooks !== undefined) collectHookValue(drafts, "skill-hook", file, frontmatter.data.hooks)
  // A skill body runs its inline `!`shell`` segments when invoked as a slash
  // command, so it declares command-shell entries under the skill name.
  if (typeof frontmatter.data.name === "string") {
    collectTemplateShells(drafts, file, frontmatter.data.name, text, frontmatter.content)
  }
}

function collectAgentFile(drafts: EntryDraft[], invalidFiles: string[], file: string, text: string) {
  const frontmatter = parseFrontmatter(text, file, invalidFiles)
  if (!frontmatter || frontmatter.data.hooks === undefined) return
  collectHookValue(drafts, "agent-hook", file, frontmatter.data.hooks)
}

function collectCommandFile(drafts: EntryDraft[], invalidFiles: string[], file: string, text: string) {
  const frontmatter = parseFrontmatter(text, file, invalidFiles)
  if (!frontmatter) return
  collectTemplateShells(drafts, file, configEntryNameFromPath(file, ["commands/"]), text, frontmatter.content)
}

function collectTemplateShells(
  drafts: EntryDraft[],
  file: string,
  label: string,
  text: string,
  content: string,
) {
  const template = content.trim()
  const contentStart = text.indexOf(content)
  const leading = content.length - content.trimStart().length
  for (const match of shellSegments(template)) {
    const command = match[1]?.trim()
    if (!command) continue
    const offset = contentStart >= 0 ? contentStart + leading + (match.index ?? 0) : undefined
    drafts.push({
      category: "command-shell",
      label,
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

/**
 * Enumerate one command file's inline-shell entries. The command runner builds
 * its command list from the same file in the same order, so index i here is the
 * TrustEntry of the i-th declared shell segment. Exported for the execution
 * gate in `command-shell.ts`.
 */
export function commandFileEntries(file: string, text: string): TrustEntry[] {
  const drafts: EntryDraft[] = []
  collectCommandFile(drafts, [], file, text)
  return assignLocations(drafts)
}

/** The same entries for a project skill's body, labelled by its frontmatter name. */
export function skillBodyEntries(file: string, text: string): TrustEntry[] {
  const drafts: EntryDraft[] = []
  const frontmatter = parseFrontmatter(text, file, [])
  if (frontmatter && typeof frontmatter.data.name === "string") {
    collectTemplateShells(drafts, file, frontmatter.data.name, text, frontmatter.content)
  }
  return assignLocations(drafts)
}

/**
 * Enumerate one hooks.json object's entries. The loader builds its command list
 * in the same insertion order, so index i here is the TrustEntry of the i-th
 * loaded command. Exported for the hooks.json loader.
 */
export function hookEntries(file: string, value: unknown): TrustEntry[] {
  const drafts: EntryDraft[] = []
  collectHookValue(drafts, "hook", file, value)
  return assignLocations(drafts)
}

/** Same alignment for a skill/agent frontmatter `hooks` map. */
export function frontmatterHookEntries(
  file: string,
  value: unknown,
  category: "skill-hook" | "agent-hook",
): TrustEntry[] {
  const drafts: EntryDraft[] = []
  collectHookValue(drafts, category, file, value)
  return assignLocations(drafts)
}

/**
 * Strip every frontmatter hook `keep` refuses from a skill/agent `hooks` map.
 * Mirrors `filterSettingsValue` for the scoped-hook registration path: the
 * caller registers the returned value, and enumeration uses the same traversal
 * and index assignment as the trust list.
 */
export function filterFrontmatterHooks(
  file: string,
  input: unknown,
  category: "skill-hook" | "agent-hook",
  keep: (entry: TrustEntry) => boolean,
): unknown {
  if (!isRecord(input)) return input
  const value = structuredClone(input)
  const drafts: EntryDraft[] = []
  const removals: Array<() => void> = []
  collectHookValue(drafts, category, file, value, { removals })
  const entries = assignLocations(drafts)
  entries.forEach((entry, index) => {
    if (keep(entry)) return
    removals[index]?.()
  })
  return value
}

// ── Hook groups ────────────────────────────────────────────────

interface HookValueOptions {
  agent?: string
  line?: (event: string, group: number, hook: number) => number | undefined
  /** Parallel to the drafts this call pushes: removes the hook from its group. */
  removals?: Array<() => void>
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
      const hooks: unknown[] = group.hooks
      // The hooks.json loader rejects a whole group whose matcher is not a
      // string; enumeration must not count entries the loader never runs.
      if (group.matcher !== undefined && typeof group.matcher !== "string") return
      const matcher = typeof group.matcher === "string" ? group.matcher : undefined
      hooks.forEach((candidate, hookIndex) => {
        const parsed = HookCommandSchema.safeParse(candidate)
        if (!parsed.success) return
        const hook = parsed.data
        const line = options.line?.(event, groupIndex, hookIndex)
        options.removals?.push(() => {
          // Removals run in enumeration order and earlier splices shift later
          // indices; locate the original element by identity instead.
          const at = hooks.indexOf(candidate)
          if (at >= 0) hooks.splice(at, 1)
        })
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
