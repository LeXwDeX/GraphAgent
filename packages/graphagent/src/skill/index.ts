import { LayerNode } from "@graphagent/core/effect/layer-node"
import path from "path"
import { Effect, Layer, Context, Schema } from "effect"
import { NamedError } from "@graphagent/core/util/error"
import type { Agent } from "@/agent/agent"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceState } from "@/effect/instance-state"
import { Global } from "@graphagent/core/global"
import { FSUtil } from "@graphagent/core/fs-util"
import { Injection } from "@graphagent/core/system-context/injection"
import { Config } from "@/config/config"
import { Flag } from "@graphagent/core/flag/flag"
import { skillsSource, type SkillsSourceLayer } from "@/config/skills-source"
import { FrontmatterError } from "@graphagent/core/v1/config/error"
import { ConfigMarkdown } from "@/config/markdown"
import { Glob } from "@graphagent/core/util/glob"
import { Discovery } from "./discovery"
import { isRecord } from "@/util/record"
import { hasProjectLayer } from "@/project/project-root"
import { watchTrustChanges } from "@/project/trust/subscribe"
import { ToolError } from "@/tool/tool-error"
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
  // The name is the model's own text and the list holds every skill there is. Both are bounded like the names an
  // unknown-tool error echoes: the name to 64 code points, the list to 30 names of at most 64 code points (#1573).
  override get message() {
    const available = this.available.length === 0 ? "none" : ToolError.nameList(this.available)
    return `Skill "${ToolError.clipName(this.name)}" not found. Available skills: ${available}`
  }
}

export type State = {
  skills: Record<string, Info>
  dirs: Set<string>
}

export type DiscoveryState = {
  matches: string[]
  dirs: string[]
  /** Absolute path -> declaring config layer, for `skills.paths`/`skills.urls` matches only (#1040). */
  declaredBy: Map<string, SkillsSourceLayer>
}

type ScanState = {
  matches: string[]
  seen: Set<string>
  dirs: Set<string>
  declaredBy: Map<string, SkillsSourceLayer>
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
 * Provenance kept on every skill for policy evaluation, independent of
 * whether it declares hooks: skills sourced from `Global.operatorRoots()`
 * are the operator's own, not the workspace being opened; everything else is
 * project layer. Project-layer frontmatter hooks are still filtered by
 * ProjectTrust before execution, and a project-owned skill the trust panel
 * cannot enumerate (outside `<root>/.agents`) can never be trusted at all —
 * its hooks and command-shell segments fail closed (#1040).
 */
const skillHookSource = (match: string) => {
  const absolute = path.resolve(match)
  const userOwned = Global.operatorRoots().some((root) => {
    const resolved = path.resolve(root)
    return absolute === resolved || absolute.startsWith(resolved + path.sep)
  })
  return userOwned ? ("user" as const) : ("project" as const)
}

/**
 * The declaring layer of a `skills.paths`/`skills.urls` entry takes
 * precedence over the resulting SKILL.md's own location: a user-level
 * declaration stays user-owned even when it happens to point somewhere
 * outside `Global.operatorRoots()` (for example a personal directory inside
 * a cloned repo), and a project-level declaration is project-owned even when
 * it points somewhere that would otherwise look user-owned. `.agents/skills`
 * and the user-root scans never pass `declaredBy`, so they keep the existing
 * purely location-based classification (#1040).
 */
const skillSource = (match: string, declaredBy: SkillsSourceLayer | undefined) => declaredBy ?? skillHookSource(match)

const scan = Effect.fnUntraced(function* (
  state: ScanState,
  root: string,
  pattern: string,
  opts?: { dot?: boolean; scope?: string; declaredBy?: SkillsSourceLayer },
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
    if (opts?.declaredBy) state.declaredBy.set(key, opts.declaredBy)
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
  const state: ScanState = { matches: [], seen: new Set(), dirs: new Set(), declaredBy: new Map() }
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
  // Which config layer declared `skills.paths`/`skills.urls` (#1040): absent
  // when no layer set that key, which `scan` treats the same as not passing
  // `declaredBy` at all (falls back to location-based classification).
  const source = skillsSource(cfg)
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

    yield* scan(state, dir, SKILL_PATTERN, { declaredBy: source?.paths })
  }

  for (const url of cfg.skills?.urls ?? []) {
    const pulledDirs = yield* discovery.pull(url)
    for (const dir of pulledDirs) {
      yield* scan(state, dir, SKILL_PATTERN, { declaredBy: source?.urls })
    }
  }

  return {
    matches: state.matches,
    dirs: Array.from(state.dirs),
    declaredBy: state.declaredBy,
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

    // #1040: hookSource is recorded for every skill, not only ones that
    // declare hooks -- the command-shell trust gate reads it off any
    // skill-promoted command, hooks or not (packages/command/index.ts), so a
    // hookless project-owned skill must not be left with an undefined
    // classification that reads as "not project".
    state.skills[item.name] = {
      name: item.name,
      description: item.description,
      location: item.match,
      content: item.content,
      hookSource: skillSource(item.match, discovered.declaredBy.get(path.resolve(item.match))),
      ...(item.hidden === undefined ? {} : { hidden: item.hidden }),
      ...(item.hooks === undefined ? {} : { hooks: item.hooks, hookOrigin: `skill:${item.match}` }),
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
    // A trust decision revokes or restores project skill hooks. Rebuild the
    // skill set lazily so later prompts see the new registration state; the
    // hook engine also reconciles its live scoped registrations on the event.
    const trustWatch = yield* InstanceState.make(
      Effect.fn("Skill.trustWatch")(function* (ctx) {
        yield* watchTrustChanges(
          ctx,
          Effect.gen(function* () {
            yield* InstanceState.invalidate(state)
            yield* InstanceState.invalidate(discovered)
          }),
        )
        return true as const
      }),
    )
    const ready = Effect.fnUntraced(function* () {
      yield* InstanceState.get(trustWatch)
    })

    return Service.of({
      get: Effect.fn("Skill.get")(function* (name: string) {
        yield* ready()
        const s = yield* InstanceState.get(state)
        return s.skills[name]
      }),
      require: Effect.fn("Skill.require")(function* (name: string) {
        yield* ready()
        const s = yield* InstanceState.get(state)
        const info = s.skills[name]
        if (info) return info
        return yield* new NotFoundError({ name, available: Object.keys(s.skills).toSorted() })
      }),
      all: Effect.fn("Skill.all")(function* () {
        yield* ready()
        const s = yield* InstanceState.get(state)
        return Object.values(s.skills)
      }),
      dirs: Effect.fn("Skill.dirs")(function* () {
        yield* ready()
        return (yield* InstanceState.get(discovered)).dirs
      }),
      available: Effect.fn("Skill.available")(function* (agent?: Agent.Info) {
        yield* ready()
        const s = yield* InstanceState.get(state)
        const list = Object.values(s.skills).toSorted((a, b) => a.name.localeCompare(b.name))
        if (!agent) return list
        // Keep Skill loadable by Session without closing Session → Skill → Permission → Settings → Plugin → Session.
        const { Permission } = yield* Effect.promise(() => import("@/permission"))
        return list.filter((skill) => Permission.evaluate("skill", skill.name, agent.permission).action !== "deny")
      }),
      reload,
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Discovery.defaultLayer),
  Layer.provide(Config.defaultLayer),
  Layer.provide(EventV2Bridge.defaultLayer),
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(Global.layer),
)

/** One listed skill line, prefix included, never longer than this many code points. */
export const SKILL_LINE_MAX = 160
/** The whole `<available_skills>` block, tags and the not-listed line included, in UTF-8 bytes. */
export const SKILL_LIST_MAX_BYTES = 4096
// Room kept for the not-listed line and the closing tag when deciding whether
// one more skill line still fits.
const SKILL_LIST_RESERVE_BYTES = 200

/**
 * The always-on list carries "when to use", not the manual: the first line of
 * the description, up to and including the first `。` or the first `.` that is
 * followed by whitespace or ends the line.
 */
export function firstSentence(description: string) {
  const line = description.trim().split(/\r?\n/, 1)[0] ?? ""
  const end = /。|\.(?=\s|$)/.exec(line)
  return end === null ? line : line.slice(0, end.index + 1)
}

/**
 * The only place a skill's description enters the list: `- <name>: <first sentence>`, escaped (a description can come
 * from a repository the user does not control), then cut at SKILL_LINE_MAX code points.
 */
export function skillLine(skill: Info) {
  const line = `- ${skill.name}: ${Injection.escape(firstSentence(skill.description ?? ""))}`
  const points = Array.from(line)
  return points.length > SKILL_LINE_MAX ? `${points.slice(0, SKILL_LINE_MAX - 1).join("")}…` : line
}

function notListedLine(count: number) {
  return `... and ${count} more skills are not listed. Load a skill by name with the skill tool; an unknown name returns the available skill names.`
}

// Lines are taken in name order until the next one, plus the reserve, would
// pass SKILL_LIST_MAX_BYTES; the rest is only counted.
function skillList(skills: readonly Info[]) {
  const head = "<available_skills>"
  const sorted = skills.toSorted((a, b) => a.name.localeCompare(b.name))
  const lines: string[] = []
  let used = Buffer.byteLength(`${head}\n`)
  for (const skill of sorted) {
    const line = skillLine(skill)
    const next = used + Buffer.byteLength(`${line}\n`)
    if (next + SKILL_LIST_RESERVE_BYTES > SKILL_LIST_MAX_BYTES) break
    lines.push(line)
    used = next
  }
  const omitted = sorted.length - lines.length
  return [head, ...lines, ...(omitted > 0 ? [notListedLine(omitted)] : []), "</available_skills>"].join("\n")
}

export function fmt(list: Info[], opts: { verbose: boolean }) {
  const described = list.filter((skill) => skill.description !== undefined)
  if (described.length === 0) return "No skills are currently available."
  if (opts.verbose) return skillList(described)

  return [
    "## Available Skills",
    ...described
      .toSorted((a, b) => a.name.localeCompare(b.name))
      .map((skill) => `- **${skill.name}**: ${skill.description}`),
  ].join("\n")
}

export const node = LayerNode.make(layer, [Discovery.node, Config.node, EventV2Bridge.node, FSUtil.node, Global.node])

export * as Skill from "."
