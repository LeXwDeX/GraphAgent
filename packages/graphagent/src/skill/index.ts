import { LayerNode } from "@graphagent/core/effect/layer-node"
import path from "path"
import { pathToFileURL } from "url"
import { Effect, Layer, Context, Schema } from "effect"
import { NamedError } from "@graphagent/core/util/error"
import type { Agent } from "@/agent/agent"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceState } from "@/effect/instance-state"
import { Global } from "@graphagent/core/global"
import { FSUtil } from "@graphagent/core/fs-util"
import { Config } from "@/config/config"
import { Flag } from "@graphagent/core/flag/flag"
import { FrontmatterError } from "@graphagent/core/v1/config/error"
import { ConfigMarkdown } from "@/config/markdown"
import { Glob } from "@graphagent/core/util/glob"
import { Discovery } from "./discovery"
import { isRecord } from "@/util/record"
import { hasProjectLayer } from "@/project/project-root"
import { BUILTIN_SKILLS } from "./builtin"

// Directory sources only match this exact layout. The singular `skill/`
// directory is no longer read.
const SKILLS_PATTERN = "skills/**/SKILL.md"
// Configured paths and downloaded URL sources keep the broad pattern.
const SKILL_PATTERN = "**/SKILL.md"

export const Info = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  location: Schema.String,
  content: Schema.String,
  /** Reference-only skill: the model can load it, but it gets no slash command. */
  hidden: Schema.optional(Schema.Boolean),
  hooks: Schema.optional(Schema.Unknown),
  hookOrigin: Schema.optional(Schema.String),
  hookSource: Schema.optional(Schema.Literals(["project", "user", "builtin"])),
})
export type Info = Schema.Schema.Type<typeof Info>

const Issue = Schema.StructWithRest(
  Schema.Struct({
    message: Schema.String,
    path: Schema.Array(Schema.String),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
)

function isSkillFrontmatter(data: unknown): data is {
  name: string
  description?: string
  hooks?: unknown
  hidden?: boolean
} {
  return (
    isRecord(data) &&
    typeof data.name === "string" &&
    (data.description === undefined || typeof data.description === "string") &&
    (data.hidden === undefined || typeof data.hidden === "boolean")
  )
}

export class InvalidError extends Schema.TaggedError<InvalidError>()("SkillInvalidError", {
  path: Schema.String,
  message: Schema.optional(Schema.String),
  issues: Schema.optional(Schema.Array(Issue)),
}) {}

export class NameMismatchError extends Schema.TaggedError<NameMismatchError>()("SkillNameMismatchError", {
  path: Schema.String,
  expected: Schema.String,
  actual: Schema.String,
}) {}

export class NotFoundError extends Schema.TaggedError<NotFoundError>()("Skill.NotFoundError", {
  name: Schema.String,
  available: Schema.Array(Schema.String),
}) {
  override get message() {
    return `Skill "${this.name}" not found. Available skills: ${this.available.join(", ") || "none"}`
  }
}

export type State = {
  skills: Record<string, Info>
  dirs: Set<string>
}

export type DiscoveryState = {
  matches: string[]
  dirs: string[]
}

type ScanState = {
  matches: string[]
  seen: Set<string>
  dirs: Set<string>
}

export interface Interface {
  readonly get: (name: string) => Effect.Effect<Info | undefined>
  readonly require: (name: string) => Effect.Effect<Info, NotFoundError>
  readonly all: () => Effect.Effect<Info[]>
  readonly reload: () => Effect.Effect<void>
  readonly dirs: () => Effect.Effect<string[]>
  readonly available: (agent?: Agent.Info) => Effect.Effect<Info[]>
}

/**
 * Roots owned by the operator rather than by the workspace being opened. Keep
 * that provenance on scoped hooks for policy evaluation; all sources can
 * register hooks without a workspace trust list.
 */
const userSkillRoots = () => [
  Global.Path.config,
  path.join(Global.Path.home, ".agents"),
  ...(Flag.GRAPHAGENT_CONFIG_DIR ? [Flag.GRAPHAGENT_CONFIG_DIR] : []),
]

const skillHookSource = (match: string) => {
  const absolute = path.resolve(match)
  const userOwned = userSkillRoots().some((root) => {
    const resolved = path.resolve(root)
    return absolute === resolved || absolute.startsWith(resolved + path.sep)
  })
  return userOwned ? ("user" as const) : ("project" as const)
}

const scan = Effect.fnUntraced(function* (
  state: ScanState,
  root: string,
  pattern: string,
  opts?: { dot?: boolean; scope?: string },
) {
  const matches = yield* Effect.tryPromise({
    try: () =>
      Glob.scan(pattern, {
        cwd: root,
        absolute: true,
        include: "file",
        symlink: true,
        dot: opts?.dot,
      }),
    catch: (error) => error,
  }).pipe(
    Effect.catch((error) => {
      if (!opts?.scope) return Effect.die(error)
      return Effect.logError(`failed to scan ${opts.scope} skills`, { dir: root, error: error }).pipe(
        Effect.as([] as string[]),
      )
    }),
  )

  // Within one source, apply matches in path order. `seen` keeps a path that
  // several sources share from being applied twice; the earliest source wins.
  for (const match of matches.toSorted()) {
    state.dirs.add(path.dirname(match))
    const key = path.resolve(match)
    if (state.seen.has(key)) continue
    state.seen.add(key)
    state.matches.push(match)
  }
})

const discoverSkills = Effect.fnUntraced(function* (
  config: Config.Interface,
  discovery: Discovery.Interface,
  fsys: FSUtil.Interface,
  global: Global.Interface,
  /** Project root; project-level scans never escape it. */
  root: string,
) {
  const state: ScanState = { matches: [], seen: new Set(), dirs: new Set() }
  // `$HOME` carries no project layer: `~/.agents/skills` is already scanned as
  // the user-level directory above, so the project scan is skipped entirely.
  const projectLayer = hasProjectLayer(root, Global.Path.home)

  // User-level shared conventions: only `skills/` under `~/.agents`.
  const userAgents = path.join(Global.Path.home, ".agents")
  if (yield* fsys.isDir(userAgents)) {
    yield* scan(state, userAgents, SKILLS_PATTERN, { dot: true, scope: "user" })
  }

  // User-level own configuration. GRAPHAGENT_CONFIG_DIR replaces or shadows
  // Global.Path.config just as it does for configuration files.
  const configRoots = [
    ...new Set([Global.Path.config, ...(Flag.GRAPHAGENT_CONFIG_DIR ? [Flag.GRAPHAGENT_CONFIG_DIR] : [])]),
  ]
  for (const dir of configRoots) {
    if (!(yield* fsys.isDir(dir))) continue
    yield* scan(state, dir, SKILLS_PATTERN, { dot: true, scope: "user" })
  }

  // Project layer: exactly `<root>/.agents/skills`; never walk above the root.
  if (projectLayer) {
    const projectAgents = path.join(root, ".agents")
    if (yield* fsys.isDir(projectAgents)) {
      yield* scan(state, projectAgents, SKILLS_PATTERN, { dot: true, scope: "project" })
    }
  }

  const cfg = yield* config.get()
  // Configured paths: relative entries resolve against the project root.
  for (const item of cfg.skills?.paths ?? []) {
    const expanded = item.startsWith("~/") ? path.join(global.home, item.slice(2)) : item
    const dir = path.isAbsolute(expanded) ? expanded : path.join(root, expanded)
    // A configured path must not reintroduce what the runtime stopped reading:
    // `~/.claude/...`, a project `.claude/...`, or any absolute path with a
    // `.claude` segment is skipped with a warning.
    if (dir.split(/[\\/]/).includes(".claude")) {
      yield* Effect.logWarning("`.claude` skill paths are no longer scanned", { path: dir })
      continue
    }
    if (!(yield* fsys.isDir(dir))) {
      yield* Effect.logWarning("skill path not found", { path: dir })
      continue
    }

    yield* scan(state, dir, SKILL_PATTERN)
  }

  for (const url of cfg.skills?.urls ?? []) {
    const pulledDirs = yield* discovery.pull(url)
    for (const dir of pulledDirs) {
      yield* scan(state, dir, SKILL_PATTERN)
    }
  }

  return {
    matches: state.matches,
    dirs: Array.from(state.dirs),
  }
})

export type ParsedSkill = {
  readonly match: string
  readonly name: string
  readonly description?: string
  readonly hooks?: unknown
  readonly hidden?: boolean
  readonly content: string
}

const parseSkill = Effect.fnUntraced(function* (match: string, events: EventV2Bridge.Service["Service"]) {
  const md = yield* Effect.tryPromise({
    try: () => ConfigMarkdown.parse(match),
    catch: (err) => err,
  }).pipe(
    Effect.catch(
      Effect.fnUntraced(function* (err) {
        const message = FrontmatterError.isInstance(err) ? err.data.message : `Failed to parse skill ${match}`
        const { Session } = yield* Effect.promise(() => import("@/session/session"))
        yield* events.publish(Session.Event.Error, { error: new NamedError.Unknown({ message }).toObject() })
        yield* Effect.logError("failed to load skill", { skill: match, error: err })
        return undefined
      }),
    ),
  )

  if (!md) return undefined
  if (!isSkillFrontmatter(md.data)) return undefined

  return {
    match,
    name: md.data.name,
    description: md.data.description,
    hooks: md.data.hooks,
    hidden: md.data.hidden,
    content: md.content,
  } satisfies ParsedSkill
})

/**
 * Parse every discovered file concurrently, then apply the results in
 * discovery order (source priority, then path order). Applying sequentially is
 * what makes same-name overrides deterministic: completion order of the parse
 * step cannot change the winner.
 *
 * `parse` is a test seam for injecting completion delays into the concurrent
 * step; production callers omit it.
 */
export const loadSkills = Effect.fnUntraced(function* (
  state: State,
  discovered: DiscoveryState,
  events: EventV2Bridge.Service["Service"],
  parse?: (match: string) => Effect.Effect<ParsedSkill | undefined>,
) {
  const parsed = yield* Effect.forEach(
    discovered.matches,
    (match) => (parse ? parse(match) : parseSkill(match, events)),
    { concurrency: "unbounded" },
  )

  for (const item of parsed) {
    if (!item) continue
    const existing = state.skills[item.name]
    if (existing) {
      yield* Effect.logWarning("duplicate skill name", {
        name: item.name,
        existing: existing.location,
        duplicate: item.match,
      })
    }

    state.skills[item.name] = {
      name: item.name,
      description: item.description,
      location: item.match,
      content: item.content,
      ...(item.hidden === undefined ? {} : { hidden: item.hidden }),
      ...(item.hooks === undefined
        ? {}
        : { hooks: item.hooks, hookOrigin: `skill:${item.match}`, hookSource: skillHookSource(item.match) }),
    }
  }

  yield* Effect.logInfo("init", { count: Object.keys(state.skills).length })
})

export class Service extends Context.Service<Service, Interface>()("@graphagent/Skill") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const discovery = yield* Discovery.Service
    const config = yield* Config.Service
    const events = yield* EventV2Bridge.Service
    const fsys = yield* FSUtil.Service
    const global = yield* Global.Service
    const discovered = yield* InstanceState.make(
      Effect.fn("Skill.discovery")(function* (ctx) {
        return yield* discoverSkills(config, discovery, fsys, global, ctx.root)
      }),
    )
    const state = yield* InstanceState.make(
      Effect.fn("Skill.state")(function* () {
        const s: State = { skills: {}, dirs: new Set() }
        // Seed built-ins BEFORE disk discovery so a disk skill with the same
        // name can override the built-in.
        for (const item of BUILTIN_SKILLS) {
          s.skills[item.name] = {
            name: item.name,
            description: item.description,
            location: `/builtin/${item.name}.md`,
            content: item.content,
            hookSource: "builtin",
            ...(item.hidden === undefined ? {} : { hidden: item.hidden }),
          }
        }
        yield* loadSkills(s, yield* InstanceState.get(discovered), events)
        return s
      }),
    )

    const get = Effect.fn("Skill.get")(function* (name: string) {
      const s = yield* InstanceState.get(state)
      return s.skills[name]
    })

    const require = Effect.fn("Skill.require")(function* (name: string) {
      const s = yield* InstanceState.get(state)
      const info = s.skills[name]
      if (info) return info
      return yield* new NotFoundError({ name, available: Object.keys(s.skills).toSorted() })
    })

    const all = Effect.fn("Skill.all")(function* () {
      const s = yield* InstanceState.get(state)
      return Object.values(s.skills)
    })

    const dirs = Effect.fn("Skill.dirs")(function* () {
      return (yield* InstanceState.get(discovered)).dirs
    })

    const available = Effect.fn("Skill.available")(function* (agent?: Agent.Info) {
      const s = yield* InstanceState.get(state)
      const list = Object.values(s.skills).toSorted((a, b) => a.name.localeCompare(b.name))
      if (!agent) return list
      // Keep Skill loadable by Session without closing Session → Skill → Permission → Settings → Plugin → Session.
      const { Permission } = yield* Effect.promise(() => import("@/permission"))
      return list.filter((skill) => Permission.evaluate("skill", skill.name, agent.permission).action !== "deny")
    })

    const reload = Effect.fn("Skill.reload")(function* () {
      yield* InstanceState.invalidate(state)
      yield* InstanceState.invalidate(discovered)
      yield* InstanceState.get(state)
    })
    return Service.of({ get, require, all, dirs, available, reload })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Discovery.defaultLayer),
  Layer.provide(Config.defaultLayer),
  Layer.provide(EventV2Bridge.defaultLayer),
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(Global.layer),
)

export function fmt(list: Info[], opts: { verbose: boolean }) {
  const described = list.filter((skill) => skill.description !== undefined)
  if (described.length === 0) return "No skills are currently available."
  if (opts.verbose) {
    return [
      "<available_skills>",
      ...described
        .toSorted((a, b) => a.name.localeCompare(b.name))
        .flatMap((skill) => [
          "  <skill>",
          `    <name>${skill.name}</name>`,
          `    <description>${skill.description}</description>`,
          `    <location>${pathToFileURL(skill.location).href}</location>`,
          "  </skill>",
        ]),
      "</available_skills>",
    ].join("\n")
  }

  return [
    "## Available Skills",
    ...described
      .toSorted((a, b) => a.name.localeCompare(b.name))
      .map((skill) => `- **${skill.name}**: ${skill.description}`),
  ].join("\n")
}

export const node = LayerNode.make(layer, [Discovery.node, Config.node, EventV2Bridge.node, FSUtil.node, Global.node])

export * as Skill from "."
