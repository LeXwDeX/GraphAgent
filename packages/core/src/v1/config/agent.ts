export * as ConfigAgentV1 from "./agent"

import { Schema, SchemaGetter } from "effect"
import { PositiveInt } from "../../schema"
import { ConfigExecutionV1 } from "./execution"
import { ConfigPermissionV1 } from "./permission"

// Agent contract (#1158): what an agent is for and who may compose it. Every
// field is optional here: a declaration is merged onto the agent it overrides,
// and the defaults (worker, private, failure derived from the write profile,
// an artifact owed to task calls) are filled by `AgentContract.effective` in
// the runtime.
const ContractCompose = Schema.Struct({
  pattern: Schema.Literals(["fan_out", "recursive_split"]).annotate({
    description: "How the composer expands a plan: fan_out (one layer of parallel workers) or recursive_split.",
  }),
  dispatch: Schema.mutable(Schema.Array(Schema.String)).annotate({
    description:
      "Agents this composer may expand into. Only agents that exist, are public and are read-only when the plan is made are used.",
  }),
  fallback: Schema.String.annotate({
    description: "Worker that takes the whole task when a plan cannot be expanded. Must be listed in dispatch.",
  }),
}).check(
  Schema.makeFilter((compose) =>
    compose.dispatch.includes(compose.fallback)
      ? undefined
      : { path: ["fallback"], issue: `fallback "${compose.fallback}" must be one of the agents listed in dispatch` },
  ),
)

export const Contract = Schema.Struct({
  role: Schema.optional(Schema.Literals(["worker", "composer"])).annotate({
    description:
      "worker (default) does the work itself and is a valid task subagent. composer only plans how a DAG expands work and runs only inside a DAG, never through the task tool.",
  }),
  visibility: Schema.optional(Schema.Literals(["public", "private"])).annotate({
    description:
      "private (default): only the main agent, the user or a template places the agent in a graph. public: a composer may dispatch it. A public agent must be read-only; one whose permission rules allow writing is treated as private.",
  }),
  output: Schema.optional(
    Schema.Struct({
      artifact: Schema.String.annotate({ description: "The artifact type name." }),
      task: Schema.optional(Schema.Boolean).annotate({
        description:
          "Whether a task call to this agent owes the artifact: the worker is asked for it and its answer is checked and corrected once. Defaults to true. false keeps task calls free text; the artifact still serves composed runs.",
      }),
    }),
  ).annotate({
    description:
      "The artifact type this agent produces, and whether task calls owe it. Replaced as a whole when overridden.",
  }),
  failure: Schema.optional(Schema.Literals(["skip", "fail"])).annotate({
    description:
      "skip: the work may be skipped when it fails. fail: its failure is the workflow's failure. Defaults to fail for agents that can write files and skip for read-only agents.",
  }),
  compose: Schema.optional(ContractCompose).annotate({
    description: "Composer only: what the composer may expand into. Replaced as a whole when overridden.",
  }),
}).annotate({
  identifier: "AgentContract",
  description:
    "Declares an agent's role, visibility, artifact and failure semantics. Permissions stay in `permission`; whether an agent is read-only is derived from it.",
})
export type Contract = Schema.Schema.Type<typeof Contract>

const Color = Schema.Union([
  Schema.String.check(Schema.isPattern(/^#[0-9a-fA-F]{6}$/u)),
  Schema.Literals(["primary", "secondary", "accent", "success", "warning", "error", "info"]),
])

const AgentSchema = Schema.StructWithRest(
  Schema.Struct({
    model: Schema.optional(Schema.String),
    variant: Schema.optional(Schema.String).annotate({
      description: "Default model variant for this agent (applies only when using the agent's configured model).",
    }),
    temperature: Schema.optional(Schema.Finite),
    top_p: Schema.optional(Schema.Finite),
    prompt: Schema.optional(Schema.String),
    hooks: Schema.optional(Schema.Record(Schema.String, Schema.Any)),
    tools: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)).annotate({
      description: "@deprecated Use 'permission' field instead",
    }),
    disable: Schema.optional(Schema.Boolean),
    description: Schema.optional(Schema.String).annotate({ description: "Description of when to use the agent" }),
    mode: Schema.optional(Schema.Literals(["subagent", "primary", "all"])),
    hidden: Schema.optional(Schema.Boolean).annotate({
      description: "Hide this subagent from the @ autocomplete menu (default: false, only applies to mode: subagent)",
    }),
    options: Schema.optional(Schema.Record(Schema.String, Schema.Any)),
    color: Schema.optional(Color).annotate({
      description: "Hex color code (e.g., #FF5733) or theme color (e.g., primary)",
    }),
    steps: Schema.optional(PositiveInt).annotate({
      description: "Maximum number of agentic iterations before forcing text-only response",
    }),
    maxSteps: Schema.optional(PositiveInt).annotate({ description: "@deprecated Use 'steps' field instead." }),
    permission: Schema.optional(ConfigPermissionV1.Info),
    contract: Schema.optional(Contract),
    execution: Schema.optional(ConfigExecutionV1.Mode).annotate({
      description:
        'How a task call to this agent runs by default: "foreground" waits for the result, "background" detaches the run and delivers the result later, "auto" (default) leaves it to the call. The call\'s own background argument and a command\'s execution take precedence over it. An interactive agent (its own rules name and allow question or plan_exit) always runs in the foreground, and so does every call in a non-interactive turn (opencode run, a hook follow-up).',
    }),
  }),
  [Schema.Record(Schema.String, Schema.Any)],
)

const KNOWN_KEYS = new Set([
  "name",
  "model",
  "variant",
  "prompt",
  "hooks",
  "hookOrigin",
  "hookSource",
  "description",
  "temperature",
  "top_p",
  "mode",
  "hidden",
  "color",
  "steps",
  "maxSteps",
  "options",
  "permission",
  "contract",
  "execution",
  "disable",
  "tools",
])

const normalize = (agent: Schema.Schema.Type<typeof AgentSchema>): Schema.Schema.Type<typeof AgentSchema> => {
  const options: Record<string, unknown> = { ...agent.options }
  delete options.hooks
  delete options.hookOrigin
  delete options.hookSource
  for (const [key, value] of Object.entries(agent)) {
    if (!KNOWN_KEYS.has(key)) options[key] = value
  }

  const permission: ConfigPermissionV1.Info = {}
  for (const [tool, enabled] of Object.entries(agent.tools ?? {})) {
    const action = enabled ? "allow" : "deny"
    if (tool === "write" || tool === "edit" || tool === "patch") {
      permission.edit = action
      continue
    }
    permission[tool] = action
  }
  globalThis.Object.assign(permission, agent.permission)

  const steps = agent.steps ?? agent.maxSteps
  return { ...agent, options, permission, ...(steps !== undefined ? { steps } : {}) }
}

export const Info = AgentSchema.pipe(
  Schema.decodeTo(AgentSchema, {
    decode: SchemaGetter.transform(normalize),
    encode: SchemaGetter.passthrough({ strict: false }),
  }),
).annotate({ identifier: "AgentConfig" })
export type Info = Schema.Schema.Type<typeof Info>
