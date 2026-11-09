// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { createSignal, type Accessor } from "solid-js"
import { t, type MessageKey } from "../i18n"
import { TuiLog } from "../util/log"
import { SERVER_COMMAND_ARGS } from "./server-args"

export type CommandScope = "home" | "session" | "subagent"
export type CommandCategory = "session" | "model" | "view" | "workflow" | "config" | "system" | "debug"
export type CommandSource = "builtin" | "server"
export type CommandOrigin = "slash" | "palette" | "key"

export const COMMAND_CATEGORY_ORDER: readonly CommandCategory[] = [
  "session",
  "model",
  "view",
  "workflow",
  "config",
  "system",
  "debug",
]

export const COMMAND_CATEGORY_KEYS: Record<CommandCategory, MessageKey> = {
  session: "command.category.session",
  model: "command.category.model",
  view: "command.category.view",
  workflow: "command.category.workflow",
  config: "command.category.config",
  system: "command.category.system",
  debug: "command.category.debug",
}

export interface CommandRunContext {
  args: string
  origin: CommandOrigin
}

export type CommandHandler = (ctx: CommandRunContext) => void | Promise<void>

export interface CommandSlash {
  name: string
  aliases?: readonly string[]
  args?: "none" | "optional" | "required"
}

export interface CommandSpec {
  /** Stable key used by keymap bindings and `registry.run`. */
  id: string
  /** Builtin commands carry both keys so every visible label is translated. */
  titleKey?: MessageKey
  title?: string
  descriptionKey?: MessageKey
  description?: string
  category: CommandCategory
  scope: readonly CommandScope[]
  slash?: CommandSlash
  enabled?: () => boolean
  /** Reachable through keymap only; omitted from completion and the palette. */
  hidden?: boolean
  source: CommandSource
  /** Preserves the server command source so MCP commands keep their suffix. */
  serverSource?: "command" | "mcp"
  /** Server commands bind their submission path directly; builtins use handlers. */
  run?: CommandHandler
}

export interface CommandRegistry {
  register(spec: CommandSpec): () => void
  setHandler(id: string, handler: CommandHandler): () => void
  run(id: string, ctx: CommandRunContext): Promise<boolean>
  /** Filtered by scope, visibility and enabled state; cached until the command set changes. */
  list(scope: CommandScope): readonly CommandSpec[]
  /** Look up by slash name or alias, with or without the leading slash. */
  find(name: string): CommandSpec | undefined
  /** Increments only when the command set changes, not when handlers are attached. */
  readonly version: Accessor<number>
}

export interface CommandRegistryOptions {
  log?: (message: string) => void
}

export function commandTitle(spec: CommandSpec): string {
  if (spec.titleKey) return t(spec.titleKey)
  return spec.title ?? spec.slash?.name ?? spec.id
}

export function commandDescription(spec: CommandSpec): string | undefined {
  if (spec.descriptionKey) return t(spec.descriptionKey)
  return spec.description
}

export function commandCategoryTitle(category: CommandCategory): string {
  return t(COMMAND_CATEGORY_KEYS[category])
}

function normalizeName(name: string) {
  return name.startsWith("/") ? name.slice(1) : name
}

export function createCommandRegistry(options: CommandRegistryOptions = {}): CommandRegistry {
  const log = options.log ?? ((message: string) => TuiLog.write("warn", message))
  const [version, setVersion] = createSignal(0)

  const specs: CommandSpec[] = []
  const byId = new Map<string, CommandSpec>()
  const byName = new Map<string, CommandSpec>()
  const handlers = new Map<string, CommandHandler>()
  const cache = new Map<CommandScope, readonly CommandSpec[]>()

  function invalidate() {
    cache.clear()
    setVersion((current) => current + 1)
  }

  function indexNames(spec: CommandSpec) {
    if (!spec.slash) return
    byName.set(spec.slash.name, spec)
    for (const alias of spec.slash.aliases ?? []) byName.set(alias, spec)
  }

  function unindexNames(spec: CommandSpec) {
    if (!spec.slash) return
    for (const [name, owner] of byName) {
      if (owner === spec) byName.delete(name)
    }
  }

  function remove(spec: CommandSpec) {
    const index = specs.indexOf(spec)
    if (index !== -1) specs.splice(index, 1)
    byId.delete(spec.id)
    unindexNames(spec)
  }

  function find(name: string) {
    return byName.get(normalizeName(name))
  }

  function register(spec: CommandSpec): () => void {
    if (byId.has(spec.id)) {
      log(`command registry: duplicate id "${spec.id}" ignored`)
      return () => {}
    }

    const names = spec.slash ? [spec.slash.name, ...(spec.slash.aliases ?? [])] : []
    const conflicts = [...new Set(names.map(find).filter((item): item is CommandSpec => !!item))]
    let logged = false
    for (const conflict of conflicts) {
      if (spec.source === "builtin" && conflict.source === "server") {
        remove(conflict)
        if (!logged) {
          log(
            `command registry: duplicate "/${spec.slash?.name}" — builtin "${spec.id}" wins over server "${conflict.id}"`,
          )
          logged = true
        }
        continue
      }
      if (!logged) {
        log(
          `command registry: duplicate "/${spec.slash?.name ?? spec.id}" — keeping "${conflict.id}", ignoring "${spec.id}"`,
        )
        logged = true
      }
      return () => {}
    }

    specs.push(spec)
    byId.set(spec.id, spec)
    indexNames(spec)
    invalidate()

    let active = true
    return () => {
      if (!active) return
      active = false
      remove(spec)
      invalidate()
    }
  }

  function setHandler(id: string, handler: CommandHandler): () => void {
    handlers.set(id, handler)
    return () => {
      if (handlers.get(id) === handler) handlers.delete(id)
    }
  }

  async function run(id: string, ctx: CommandRunContext): Promise<boolean> {
    const spec = byId.get(id)
    if (!spec) return false
    if (spec.hidden && ctx.origin !== "key") return false
    if (spec.enabled && !spec.enabled()) return false
    const handler = handlers.get(id) ?? spec.run
    if (!handler) return false
    await handler(ctx)
    return true
  }

  function list(scope: CommandScope): readonly CommandSpec[] {
    const cached = cache.get(scope)
    if (cached) return cached
    const items = specs
      .filter((spec) => {
        if (spec.hidden) return false
        if (!spec.scope.includes(scope)) return false
        if (spec.enabled && !spec.enabled()) return false
        return true
      })
      .sort((a, b) => {
        const category = COMMAND_CATEGORY_ORDER.indexOf(a.category) - COMMAND_CATEGORY_ORDER.indexOf(b.category)
        return category !== 0 ? category : a.id.localeCompare(b.id)
      })
    cache.set(scope, items)
    return items
  }

  return { register, setHandler, run, list, find, version }
}

export interface SlashCommandEntry {
  spec: CommandSpec
  display: string
  aliases?: readonly string[]
  description?: string
  requiresArgs: boolean
}

const slashCache = new WeakMap<
  CommandRegistry,
  Map<CommandScope, { version: number; entries: readonly SlashCommandEntry[] }>
>()

/**
 * Slash completion rows derived from the registry. The result is reused until
 * the command set changes, so opening completion and typing filters never
 * rebuild the command list.
 */
export function slashCommandEntries(registry: CommandRegistry, scope: CommandScope): readonly SlashCommandEntry[] {
  let scoped = slashCache.get(registry)
  if (!scoped) {
    scoped = new Map()
    slashCache.set(registry, scoped)
  }
  const current = registry.version()
  const cached = scoped.get(scope)
  if (cached?.version === current) return cached.entries

  const entries = registry.list(scope).flatMap((spec): SlashCommandEntry[] => {
    if (!spec.slash) return []
    const suffix = spec.serverSource === "mcp" ? ":mcp" : ""
    return [
      {
        spec,
        display: `/${spec.slash.name}${suffix}`,
        aliases: spec.slash.aliases?.map((alias) => `/${alias}`),
        description: commandDescription(spec),
        requiresArgs: spec.slash.args === "required",
      },
    ]
  })
  scoped.set(scope, { version: current, entries })
  return entries
}

export interface ServerCommandLike {
  name: string
  description?: string
  source?: "command" | "mcp" | "skill"
}

/** Server commands are session-only; skill-sourced entries are excluded upstream. */
export function serverCommandSpec(command: ServerCommandLike, run: CommandHandler): CommandSpec | undefined {
  if (command.source === "skill") return undefined
  const mcp = command.source === "mcp"
  return {
    id: `server.${command.name}`,
    title: `/${command.name}${mcp ? ":mcp" : ""}`,
    description: command.description,
    category: "session",
    scope: ["session"],
    slash: {
      name: command.name,
      args: SERVER_COMMAND_ARGS[command.name] ? "optional" : "none",
    },
    source: "server",
    serverSource: mcp ? "mcp" : "command",
    run,
  }
}

export type SlashResolution =
  | { kind: "builtin"; spec: CommandSpec; args: string }
  | { kind: "server"; spec: CommandSpec; name: string; args: string }
  | { kind: "message" }

/**
 * Resolve the first word of a prompt submission against the registry. A slash
 * command outside the current scope, hidden, disabled or unknown falls through
 * to a normal message.
 */
export function resolveSlashInput(
  registry: Pick<CommandRegistry, "find">,
  scope: CommandScope,
  input: string,
): SlashResolution {
  if (!input.startsWith("/")) return { kind: "message" }
  const firstLineEnd = input.indexOf("\n")
  const firstLine = firstLineEnd === -1 ? input : input.slice(0, firstLineEnd)
  const [token, ...firstLineArgs] = firstLine.split(" ")
  const name = token.slice(1)
  if (!name) return { kind: "message" }
  const spec = registry.find(name)
  if (!spec || spec.hidden) return { kind: "message" }
  if (!spec.scope.includes(scope)) return { kind: "message" }
  if (spec.enabled && !spec.enabled()) return { kind: "message" }
  const restOfInput = firstLineEnd === -1 ? "" : input.slice(firstLineEnd + 1)
  const args = firstLineArgs.join(" ") + (restOfInput ? "\n" + restOfInput : "")
  if (spec.source === "server") {
    return { kind: "server", spec, name: spec.slash?.name ?? name, args }
  }
  return { kind: "builtin", spec, args }
}
