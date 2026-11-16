import { LayerNode } from "@graphagent/core/effect/layer-node"
import { ConfigAgentV1 } from "@graphagent/core/v1/config/agent"
import { PermissionV1 } from "@graphagent/core/v1/permission"
import { Config } from "@/config/config"
import { watchTrustState } from "@/project/trust/subscribe"
import { EventV2Bridge } from "@/event-v2-bridge"
import { agentHookProvenance } from "@/config/agent-hooks"
import { serviceUse } from "@graphagent/core/effect/service-use"
import { Provider } from "@/provider/provider"

import { generateObject, streamObject, type ModelMessage } from "ai"
import { Truncate } from "@/tool/truncate"
import { Auth } from "../auth"
import { ProviderTransform } from "@/provider/transform"

import PROMPT_GENERATE from "./generate.txt"
import PROMPT_ARCHITECT from "./prompt/architect.txt"
import PROMPT_AUDITOR from "./prompt/auditor.txt"
import PROMPT_COMPACTION from "./prompt/compaction.txt"
import PROMPT_EXPLORE from "./prompt/explore.txt"
import PROMPT_PROTOTYPER from "./prompt/prototyper.txt"
import PROMPT_RESEARCHER from "./prompt/researcher.txt"
import PROMPT_REVIEW from "./prompt/review.txt"
import PROMPT_SUMMARY from "./prompt/summary.txt"
import PROMPT_TITLE from "./prompt/title.txt"
import { Permission } from "@/permission"
import { AgentContract } from "./contract"
import { mergeDeep, pipe, sortBy, values } from "remeda"
import { Global } from "@graphagent/core/global"
import { PROJECT_DIR } from "@graphagent/core/brand"
import path from "path"
import { Skill } from "../skill"
import { Effect, Context, Layer, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import * as Option from "effect/Option"
import * as OtelTracer from "@effect/opentelemetry/OtelTracer"
import { AbsolutePath, type DeepMutable } from "@graphagent/core/schema"
import { ProviderV2 } from "@graphagent/core/provider"
import { ModelV2 } from "@graphagent/core/model"
import { LocationServiceMap } from "@graphagent/core/location-layer"
import { Reference } from "@graphagent/core/reference"
import { Location } from "@graphagent/core/location"
import { PluginV2 } from "@graphagent/core/plugin"

export const Info = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  hooks: Schema.optional(Schema.Unknown),
  hookOrigin: Schema.optional(Schema.String),
  hookSource: Schema.optional(Schema.Literals(["project", "user", "builtin"])),
  mode: Schema.Literals(["subagent", "primary", "all"]),
  native: Schema.optional(Schema.Boolean),
  hidden: Schema.optional(Schema.Boolean),
  topP: Schema.optional(Schema.Finite),
  temperature: Schema.optional(Schema.Finite),
  color: Schema.optional(Schema.String),
  permission: PermissionV1.Ruleset,
  model: Schema.optional(
    Schema.Struct({
      modelID: ModelV2.ID,
      providerID: ProviderV2.ID,
    }),
  ),
  variant: Schema.optional(Schema.String),
  prompt: Schema.optional(Schema.String),
  options: Schema.Record(Schema.String, Schema.Unknown),
  steps: Schema.optional(Schema.Finite),
  /**
   * What the agent declares about its role, visibility, artifact and failure
   * semantics (#1158). Declared form: fields it omits take the defaults that
   * `AgentContract.effective` fills in.
   */
  contract: Schema.optional(ConfigAgentV1.Contract),
}).annotate({ identifier: "Agent" })
export type Info = DeepMutable<Schema.Schema.Type<typeof Info>>

const GeneratedAgent = Schema.Struct({
  identifier: Schema.String,
  whenToUse: Schema.String,
  systemPrompt: Schema.String,
})

export interface PermissionPolicy {
  native: PermissionV1.Rule[]
  rules: PermissionV1.Rule[]
  /**
   * Indices into `rules` whose content the user wrote (global `permissions`,
   * `permission`, or `agent.<name>.permission`). Native role defaults and the
   * always-appended truncation allow are not listed: the DAG safety guard
   * treats only these as an explicit allow (#1031 M7).
   */
  userRuleIndices?: readonly number[]
}

export interface Interface {
  readonly permissionPolicy: (agent: string) => Effect.Effect<PermissionPolicy>
  readonly get: (agent: string) => Effect.Effect<Info | undefined>
  readonly list: () => Effect.Effect<Info[]>
  readonly defaultInfo: () => Effect.Effect<Info>
  readonly defaultAgent: () => Effect.Effect<string>
  readonly generate: (input: {
    description: string
    model?: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
  }) => Effect.Effect<
    {
      identifier: string
      whenToUse: string
      systemPrompt: string
    },
    Provider.DefaultModelError
  >
}

type State = Omit<Interface, "generate">

export class Service extends Context.Service<Service, Interface>()("@graphagent/Agent") {}

export const use = serviceUse(Service)

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const auth = yield* Auth.Service
    const skill = yield* Skill.Service
    const provider = yield* Provider.Service
    const locations = yield* LocationServiceMap

    const state = yield* InstanceState.make<State>(
      Effect.fn("Agent.state")(function* (ctx) {
        const cfg = yield* config.get()
        const skillDirs = yield* skill.dirs()
        const referenceDirs = Object.keys(cfg.references ?? cfg.reference ?? {}).length
          ? yield* Effect.gen(function* () {
              yield* (yield* PluginV2.Service).wait(PluginV2.ID.make("core/config-reference"))
              return (yield* (yield* Reference.Service).list()).map((reference) => reference.path)
            }).pipe(Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(ctx.directory) }))))
          : []
        const whitelistedDirs = [
          Truncate.GLOB,
          path.join(Global.Path.tmp, "*"),
          ...skillDirs.map((dir) => path.join(dir, "*")),
          ...referenceDirs.map((dir) => path.join(dir, "*")),
        ]
        const readonlyExternalDirectory = {
          "*": "ask",
          ...Object.fromEntries(whitelistedDirs.map((dir) => [dir, "allow"])),
        } satisfies Record<string, "allow" | "ask" | "deny">

        // The read-only inspection profile `explore` and `architect` share (#1158): read, search and fetch, a shell
        // for inspection, and the session bootstrap path every read-only worker needs. Shell access is not a
        // read-only sandbox; this is a behavioral restriction, not command-level enforcement.
        const inspection = {
          "*": "deny",
          grep: "allow",
          glob: "allow",
          bash: "allow",
          webfetch: "allow",
          websearch: "allow",
          read: "allow",
          // Read-only workers still need the session bootstrap path.
          skill: "allow",
          "*_initial_instructions": "allow",
          external_directory: readonlyExternalDirectory,
        } as const

        const defaults = Permission.fromConfig({
          "*": "allow",
          doom_loop: "ask",
          external_directory: {
            "*": "ask",
            ...Object.fromEntries(whitelistedDirs.map((dir) => [dir, "allow"])),
          },
          question: "deny",
          plan_exit: "deny",
          // mirrors github.com/github/gitignore Node.gitignore pattern for .env files
          read: {
            "*": "allow",
            "*.env": "ask",
            "*.env.*": "ask",
            "*.env.example": "allow",
          },
        })

        // Configuration is resolved on every permission check, not captured in this cache.
        const user: PermissionV1.Ruleset = []

        const agents: Record<string, Info> = {
          build: {
            name: "build",
            description: "The default agent. Executes tools based on configured permissions.",
            options: {},
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                question: "allow",
              }),
              user,
            ),
            mode: "primary",
            native: true,
          },
          plan: {
            name: "plan",
            description: "Plan mode. Allows edits to the plan file and denies other edits by default.",
            options: {},
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                question: "allow",
                plan_exit: "allow",
                // Plan mode starts no writer: general can edit anywhere, prototyper under prototypes/.
                task: {
                  general: "deny",
                  prototyper: "deny",
                },
                external_directory: {
                  [path.join(Global.Path.data, "plans", "*")]: "allow",
                },
                edit: {
                  "*": "deny",
                  [path.join(PROJECT_DIR, "plans", "*.md")]: "allow",
                  [path.relative(ctx.worktree, path.join(Global.Path.data, path.join("plans", "*.md")))]: "allow",
                },
              }),
              user,
            ),
            mode: "primary",
            native: true,
          },
          general: {
            name: "general",
            description: `General-purpose agent for researching complex questions and executing multi-step tasks.`,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                todowrite: "deny",
              }),
              user,
            ),
            options: {},
            mode: "subagent",
            native: true,
          },
          explore: {
            name: "explore",
            permission: Permission.merge(defaults, Permission.fromConfig(inspection), user),
            description: `Fast agent specialized for exploring codebases. Use this when you need to quickly find files by patterns (eg. "src/components/**/*.tsx"), search code for keywords (eg. "API endpoints"), or answer questions about the codebase (eg. "how do API endpoints work?"). When calling this agent, specify the desired thoroughness level: "quick" for basic searches, "medium" for moderate exploration, or "very thorough" for comprehensive analysis across multiple locations and naming conventions.`,
            prompt: PROMPT_EXPLORE,
            options: {},
            mode: "subagent",
            native: true,
            // `task: false`: a task call to explore stays free text and is not checked; the artifact is what a
            // composed run (a composer's expanded child) is held to.
            contract: { role: "worker", visibility: "public", output: { artifact: "code_findings", task: false } },
          },
          researcher: {
            name: "researcher",
            // Reads, searches and fetches; no shell and no file tool at all.
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
                grep: "allow",
                glob: "allow",
                webfetch: "allow",
                websearch: "allow",
                read: "allow",
                // Read-only workers still need the session bootstrap path.
                skill: "allow",
                "*_initial_instructions": "allow",
                external_directory: readonlyExternalDirectory,
              }),
              user,
            ),
            description:
              "Web research agent. Use it to answer a question from external sources such as documentation, release notes and issue trackers. It cites a source for every claim and reports where sources disagree. No shell; it cannot change files. Returns a research_findings artifact.",
            prompt: PROMPT_RESEARCHER,
            options: {},
            mode: "subagent",
            native: true,
            contract: { role: "worker", visibility: "public", output: { artifact: "research_findings" } },
          },
          architect: {
            name: "architect",
            // The explore profile plus the language server.
            permission: Permission.merge(defaults, Permission.fromConfig({ ...inspection, lsp: "allow" }), user),
            description:
              "Architecture design agent. Use it to weigh design options for a change against the existing code and recommend one, with the trade-offs. It does not split work into packages or write code. Read-only. Returns an architecture_proposal artifact.",
            prompt: PROMPT_ARCHITECT,
            options: {},
            mode: "subagent",
            native: true,
            contract: { role: "worker", visibility: "public", output: { artifact: "architecture_proposal" } },
          },
          prototyper: {
            name: "prototyper",
            // The explore profile, with one window to write in: prototypes/ in the node workspace. A pattern-scoped
            // allow keeps the file tools advertised, so this agent is a writer to the DAG (and `private`).
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({ ...inspection, edit: { "*": "deny", "prototypes/**": "allow" } }),
              user,
            ),
            description:
              "Prototype agent. Use it to answer one falsifiable technical question with the smallest disposable experiment: it states a hypothesis, writes the experiment only under prototypes/, runs it, and reports what it observed and how to run it again. Never changes product code. Returns a prototype artifact.",
            prompt: PROMPT_PROTOTYPER,
            options: {},
            mode: "subagent",
            native: true,
            // A writer: `public` would be dropped anyway, and its failure derives to `fail`.
            contract: { role: "worker", visibility: "private", output: { artifact: "prototype" } },
          },
          review: {
            name: "review",
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
                read: "allow",
                grep: "allow",
                glob: "allow",
                lsp: "allow",
                // Read-only workers still need the session bootstrap path.
                skill: "allow",
                "*_initial_instructions": "allow",
                external_directory: readonlyExternalDirectory,
              }),
              // The bash allowlist below (`*` deny, then the read-only git/gh
              // commands, then the `--output` denies that must follow them to
              // win) is shared with the `readonly` tier of `dag.permission`
              // (#1324 §4, Q6): `Permission.READONLY_BASH`.
              Permission.READONLY_BASH,
              user,
            ),
            description:
              "Reviews finished changes (uncommitted work, a commit, a branch, or a PR) and reports findings. Read-only.",
            prompt: PROMPT_REVIEW,
            options: {},
            mode: "subagent",
            native: true,
            // Serves background review; multi-lens review runs through the DAG's
            // review lanes, so it is never a composer's dispatch target.
            contract: { role: "worker", visibility: "private" },
          },
          auditor: {
            name: "auditor",
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
                read: "allow",
                grep: "allow",
                glob: "allow",
                // Shell access is not a read-only sandbox; this is a behavioral
                // restriction, not command-level enforcement.
                bash: "allow",
                webfetch: "allow",
                websearch: "allow",
                // Read-only workers still need the session bootstrap path.
                skill: "allow",
                "*_initial_instructions": "allow",
                // One rule covers edit, write, and apply_patch.
                edit: "deny",
                task: "deny",
                todowrite: "deny",
                question: "deny",
                plan_exit: "deny",
                external_directory: readonlyExternalDirectory,
              }),
              user,
            ),
            description:
              "Read-only auditor. Verifies completed work and claimed evidence against primary sources and reports what the evidence supports.",
            prompt: PROMPT_AUDITOR,
            options: {},
            mode: "subagent",
            native: true,
            // A review lane that is missing cannot be treated as if it never ran.
            contract: { role: "worker", visibility: "public", failure: "fail" },
          },
          compaction: {
            name: "compaction",
            mode: "primary",
            native: true,
            hidden: true,
            prompt: PROMPT_COMPACTION,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
              }),
              user,
            ),
            options: {},
          },
          title: {
            name: "title",
            mode: "primary",
            options: {},
            native: true,
            hidden: true,
            temperature: 0.5,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
              }),
              user,
            ),
            prompt: PROMPT_TITLE,
          },
          summary: {
            name: "summary",
            mode: "primary",
            options: {},
            native: true,
            hidden: true,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
              }),
              user,
            ),
            prompt: PROMPT_SUMMARY,
          },
        }

        const nativePermissions = Object.fromEntries(
          Object.entries(agents).map(([name, agent]) => [name, structuredClone(agent.permission)]),
        )

        for (const [key, value] of Object.entries(cfg.agent ?? {})) {
          if (value.disable) {
            delete agents[key]
            continue
          }
          let item = agents[key]
          if (!item)
            item = agents[key] = {
              name: key,
              mode: "all",
              permission: Permission.merge(defaults, user),
              options: {},
              native: false,
            }
          if (value.model) item.model = Provider.parseModel(value.model)
          item.hooks = value.hooks ?? item.hooks
          const hookProvenance = agentHookProvenance(cfg, key)
          item.hookOrigin = hookProvenance?.origin
          item.hookSource = hookProvenance?.source ?? "project"
          item.variant = value.variant ?? item.variant
          item.prompt = value.prompt ?? item.prompt
          item.description = value.description ?? item.description
          item.temperature = value.temperature ?? item.temperature
          item.topP = value.top_p ?? item.topP
          item.mode = value.mode ?? item.mode
          item.color = value.color ?? item.color
          item.hidden = value.hidden ?? item.hidden
          item.name = value.name ?? item.name
          item.steps = value.steps ?? item.steps
          item.options = mergeDeep(item.options, value.options ?? {})
          item.permission = Permission.merge(item.permission, Permission.fromConfig(value.permission ?? {}))
          item.contract = AgentContract.merge(item.contract, value.contract)
        }

        // Ensure Truncate.GLOB is allowed unless explicitly configured
        for (const name in agents) {
          const agent = agents[name]
          const explicit = agent.permission.some((r) => {
            if (r.permission !== "external_directory") return false
            if (r.action !== "deny") return false
            return r.pattern === Truncate.GLOB
          })
          if (explicit) continue

          agents[name].permission = Permission.merge(
            agents[name].permission,
            Permission.fromConfig({ external_directory: { [Truncate.GLOB]: "allow" } }),
          )
        }

        const permissionPolicy = Effect.fnUntraced(function* (agent: string): Effect.fn.Return<PermissionPolicy> {
          const latest = yield* config.get()
          const key = agents[agent]
            ? agent
            : (Object.entries(agents).find(([, item]) => item.name === agent)?.[0] ?? agent)
          const native = nativePermissions[key] ?? defaults
          const userRules = [
            ...(latest.permissions?.map((rule) => ({
              permission: rule.action,
              pattern: rule.resource,
              action: rule.effect,
            })) ?? Permission.fromConfig(latest.permission ?? {})),
            ...Permission.fromConfig(latest.agent?.[key]?.permission ?? {}),
          ]
          let rules = Permission.merge(native, userRules)
          const explicit = rules.some(
            (rule) =>
              rule.permission === "external_directory" && rule.action === "deny" && rule.pattern === Truncate.GLOB,
          )
          if (!explicit)
            rules = Permission.merge(rules, Permission.fromConfig({ external_directory: { [Truncate.GLOB]: "allow" } }))
          const userRuleIndices = userRules.map((_, index) => native.length + index)
          return { native, rules, userRuleIndices }
        })
        const hydrate = Effect.fnUntraced(function* (info: Info, agent = info.name) {
          const latest = yield* config.get()
          const key = Object.entries(agents).find(([, item]) => item === info)?.[0] ?? agent
          const provenance = agentHookProvenance(latest, key)
          return {
            ...info,
            hooks: latest.agent?.[key]?.hooks,
            hookOrigin: provenance?.origin,
            hookSource: provenance?.source ?? "project",
            permission: (yield* permissionPolicy(agent)).rules,
          }
        })
        const get = Effect.fnUntraced(function* (agent: string) {
          const info = agents[agent] ?? Object.values(agents).find((item) => item.name === agent)
          return info ? yield* hydrate(info, agent) : undefined
        })

        const list = Effect.fnUntraced(function* () {
          const cfg = yield* config.get()
          const sorted = pipe(
            agents,
            values(),
            sortBy(
              [(x) => (cfg.default_agent ? x.name === cfg.default_agent : x.name === "build"), "desc"],
              [(x) => x.name, "asc"],
            ),
          )
          return yield* Effect.forEach(sorted, (agent) => hydrate(agent))
        })

        const defaultInfo = Effect.fnUntraced(function* () {
          const c = yield* config.get()
          if (c.default_agent) {
            const agent = agents[c.default_agent]
            if (!agent) throw new Error(`default agent "${c.default_agent}" not found`)
            if (agent.mode === "subagent") throw new Error(`default agent "${c.default_agent}" is a subagent`)
            if (agent.hidden === true) throw new Error(`default agent "${c.default_agent}" is hidden`)
            return yield* hydrate(agent)
          }
          const visible = Object.values(agents).find((a) => a.mode !== "subagent" && a.hidden !== true)
          if (!visible) throw new Error("no primary visible agent found")
          return yield* hydrate(visible)
        })

        const defaultAgent = Effect.fnUntraced(function* () {
          return (yield* defaultInfo()).name
        })

        // Contract diagnostics (#1158), judged on the effective rules `get` and
        // `list` return: a public agent that can write, a composer that cannot
        // be used. The log is the catalog's diagnostic channel (as for skills);
        // `AgentContract.diagnose` and `composerAvailability` answer the same
        // question for callers that validate against the current catalog.
        const catalog = yield* Effect.forEach(Object.values(agents), (agent) => hydrate(agent))
        for (const diagnostic of AgentContract.diagnose(catalog)) {
          yield* Effect.logWarning(diagnostic.message, { agent: diagnostic.agent, code: diagnostic.code })
        }

        return {
          get,
          permissionPolicy,
          list,
          defaultInfo,
          defaultAgent,
        } satisfies State
      }),
    )
    // Agents and their hooks come from gated project settings; re-read the
    // cached agent set when a trust decision changes what is visible.
    const trustWatch = yield* watchTrustState(state)
    const ready = Effect.fnUntraced(function* () {
      yield* InstanceState.get(trustWatch)
    })

    return Service.of({
      permissionPolicy: Effect.fn("Agent.permissionPolicy")((agent: string) =>
        Effect.gen(function* () {
          yield* ready()
          return yield* InstanceState.useEffect(state, (s) => s.permissionPolicy(agent))
        }),
      ),
      get: Effect.fn("Agent.get")(function* (agent: string) {
        yield* ready()
        return yield* InstanceState.useEffect(state, (s) => s.get(agent))
      }),
      list: Effect.fn("Agent.list")(function* () {
        yield* ready()
        return yield* InstanceState.useEffect(state, (s) => s.list())
      }),
      defaultInfo: Effect.fn("Agent.defaultInfo")(function* () {
        yield* ready()
        return yield* InstanceState.useEffect(state, (s) => s.defaultInfo())
      }),
      defaultAgent: Effect.fn("Agent.defaultAgent")(function* () {
        yield* ready()
        return yield* InstanceState.useEffect(state, (s) => s.defaultAgent())
      }),
      generate: Effect.fn("Agent.generate")(function* (input: {
        description: string
        model?: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
      }) {
        const cfg = yield* config.get()
        const model = input.model ?? (yield* provider.defaultModel())
        const resolved = yield* provider.getModel(model.providerID, model.modelID)
        const language = yield* provider.getLanguage(resolved)
        const tracer = cfg.experimental?.openTelemetry
          ? Option.getOrUndefined(yield* Effect.serviceOption(OtelTracer.OtelTracer))
          : undefined

        const system = [PROMPT_GENERATE]
        yield* ready()
        const existing = yield* InstanceState.useEffect(state, (s) => s.list())

        // TODO: clean this up so provider specific logic doesnt bleed over
        const authInfo = yield* auth.get(model.providerID).pipe(Effect.orDie)
        const isOpenaiOauth = model.providerID === "openai" && authInfo?.type === "oauth"

        const params = {
          experimental_telemetry: {
            isEnabled: cfg.experimental?.openTelemetry,
            tracer,
            metadata: {
              userId: cfg.username ?? "unknown",
            },
          },
          temperature: 0.3,
          messages: [
            ...(isOpenaiOauth
              ? []
              : system.map((item): ModelMessage => ({
                  role: "system",
                  content: item,
                }))),
            {
              role: "user",
              content: `Create an agent configuration based on this request: "${input.description}".\n\nIMPORTANT: The following identifiers already exist and must NOT be used: ${existing.map((i) => i.name).join(", ")}\n  Return ONLY the JSON object, no other text, do not wrap in backticks`,
            },
          ],
          model: language,
          schema: Object.assign(
            Schema.toStandardSchemaV1(GeneratedAgent),
            Schema.toStandardJSONSchemaV1(GeneratedAgent),
          ),
        } satisfies Parameters<typeof generateObject>[0]

        if (isOpenaiOauth) {
          return yield* Effect.promise(async () => {
            const result = streamObject({
              ...params,
              providerOptions: ProviderTransform.providerOptions(resolved, {
                instructions: system.join("\n"),
                store: false,
              }),
              onError: () => {},
            })
            for await (const part of result.fullStream) {
              if (part.type === "error") throw part.error
            }
            return result.object
          })
        }

        return yield* Effect.promise(() => generateObject(params).then((r) => r.object))
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Provider.defaultLayer),
  Layer.provide(Auth.defaultLayer),
  Layer.provide(Config.defaultLayer),
  Layer.provide(Skill.defaultLayer),
  Layer.provide(LocationServiceMap.layer),
  Layer.provide(EventV2Bridge.defaultLayer),
)

const locationServiceMapNode = LayerNode.make(LocationServiceMap.layer, [])

export const node = LayerNode.make(layer, [
  Config.node,
  Auth.node,
  Skill.node,
  Provider.node,
  locationServiceMapNode,
  EventV2Bridge.node,
])

export * as Agent from "./agent"
