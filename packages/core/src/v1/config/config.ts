export * as ConfigV1 from "./config"

import { Schema } from "effect"
import { Permission } from "@graphagent/schema/permission"
import { NonNegativeInt, PositiveInt, type DeepMutable } from "../../schema"
import { ConfigExperimental } from "../../config/experimental"
import { ConfigReasoningDistillation } from "../../config/reasoning-distillation"
import { ConfigReference } from "../../config/reference"
import { ConfigAgentV1 } from "./agent"
import { ConfigAttachmentV1 } from "./attachment"
import { ConfigCommandV1 } from "./command"
import { ConfigFormatterV1 } from "./formatter"
import { ConfigLayoutV1 } from "./layout"
import { ConfigLSPV1 } from "./lsp"
import { ConfigPermissionV1 } from "./permission"
import { ConfigProviderV1 } from "./provider"
import { ConfigSkillsV1 } from "./skills"
import { ToolBudget } from "../../session/tool-budget"

export type Layout = ConfigLayoutV1.Layout

export const WellKnown = Schema.Struct({
  config: Schema.optional(Schema.Json),
  remote_config: Schema.optional(Schema.Json),
})

const LogLevelRef = Schema.Literals(["DEBUG", "INFO", "WARN", "ERROR"]).annotate({
  identifier: "LogLevel",
  description: "Log level",
})

/**
 * DAG workflow settings declared by #884. `model` and `thinking_depth` resolve
 * per directory with project over user precedence
 * (`packages/graphagent/src/config/dag-section.ts`); every other key is global
 * policy, so `packages/graphagent/src/config/config.ts` strips those keys from
 * project-level sources before merging and warns once per file and key.
 */
export const Dag = Schema.Struct({
  model: Schema.optional(
    Schema.Struct({
      advanced: Schema.optional(Schema.String).annotate({
        description:
          'Model ("provider/model") for critical nodes: required: true and review/arbiter workers. A project setting overrides the user-level value.',
      }),
      standard: Schema.optional(Schema.String).annotate({
        description:
          'Model ("provider/model") for every other worker node. With only one tier configured, it serves as the unified default. A project setting overrides the user-level value.',
      }),
    }),
  ).annotate({
    description:
      "DAG model tiers. Project configuration (<root>/.agents/settings.json) overrides the user-level configuration; nodes do not pin models.",
  }),
  thinking_depth: Schema.optional(Schema.Literals(["low", "medium", "high", "max"])).annotate({
    description:
      "Reasoning variant for DAG child sessions; applied only when the resolved model defines a variant with this name. A project setting overrides the user-level value.",
  }),
  mode: Schema.optional(Schema.Literals(["on", "off"])).annotate({
    description:
      "Default DAG mode for new sessions. Global config only: values from project-level configuration are ignored.",
  }),
  concurrency: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 64 }))).annotate({
    description:
      "Maximum number of workflow nodes running at the same time across all workflows in this process (1-64). Global config only: values from project-level configuration are ignored.",
  }),
  max_total_nodes: Schema.optional(PositiveInt).annotate({
    description:
      "User hard cap on the number of nodes in a single workflow; the model can only choose a smaller number. Global config only: values from project-level configuration are ignored.",
  }),
  budget: Schema.optional(
    Schema.Struct({
      tokens: Schema.optional(Schema.NullOr(PositiveInt)).annotate({
        description:
          "Token limit across all DAG nodes under one main session; null means unlimited. Global config only: values from project-level configuration are ignored.",
      }),
      warn_ratio: Schema.optional(Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }))).annotate({
        description:
          "Usage ratio (0-1) at which a budget warning is shown. Global config only: values from project-level configuration are ignored.",
      }),
    }),
  ).annotate({
    description: "DAG token budget. Global config only: values from project-level configuration are ignored.",
  }),
  safety: Schema.optional(
    Schema.Struct({
      extra: Schema.optional(
        Schema.mutable(
          Schema.Array(
            Schema.Struct({
              permission: Schema.String.annotate({ description: "Permission name the rule matches" }),
              pattern: Schema.String.annotate({ description: "Pattern the permission applies to" }),
              reason: Schema.optional(Schema.String).annotate({
                description: "Optional reason shown when the rule denies an action",
              }),
            }),
          ),
        ),
      ).annotate({
        description:
          "Additional safety rules. They can only deny, never allow. Global config only: values from project-level configuration are ignored.",
      }),
    }),
  ).annotate({
    description: "DAG safety rules. Global config only: values from project-level configuration are ignored.",
  }),
}).annotate({
  description:
    "DAG workflow settings. model and thinking_depth merge per directory: a project's <root>/.agents/settings.json overrides the user-level config directory (graphagent.json/graphagent.jsonc). Every other key is read from the global layer only — the global config directory, managed configuration, and GRAPHAGENT_CONFIG, GRAPHAGENT_CONFIG_CONTENT and GRAPHAGENT_CONFIG_DIR; values from project-level configuration are ignored with a warning.",
})

/** Message used when an unrecognized key appears under `engine`. */
export const ENGINE_UNEXPECTED_KEY_MESSAGE = 'Unknown "engine" configuration key:'

// `engine` is a closed draft surface. The shared config decoders ignore excess
// properties, so a misspelled limit would be dropped silently; the loaders call
// `ConfigEngine.rejectUnknownKeys` to report the full key path instead, and the
// published schema marks these objects with `additionalProperties: false`.
const closedEngine = {
  additionalProperties: false,
  messageUnexpectedKey: ENGINE_UNEXPECTED_KEY_MESSAGE,
} as const

export const Engine = Schema.Struct({
  concurrency: Schema.optional(
    Schema.Struct({
      global: Schema.optional(PositiveInt).annotate({
        description: "Maximum concurrent model streams in this process (draft default: 24, subject to measurement).",
      }),
      perProvider: Schema.optional(PositiveInt).annotate({
        description: "Maximum concurrent model streams per provider (draft default: 12, subject to measurement).",
      }),
      childGlobal: Schema.optional(PositiveInt).annotate({
        description: "Maximum concurrent child runs in this process (draft default: 16, subject to measurement).",
      }),
      taskReserve: Schema.optional(PositiveInt).annotate({
        description:
          "Child-run slots reserved for the task tool inside childGlobal (draft default: 2, subject to measurement).",
      }),
    }).annotate({
      description: "Draft concurrency limits for the session engine; values are provisional.",
      ...closedEngine,
    }),
  ),
  cache: Schema.optional(
    Schema.Struct({
      staggerSiblings: Schema.optional(Schema.Boolean).annotate({
        description:
          "Release sibling child runs sharing a cache group one at a time until the first reports a token (default: true).",
      }),
    }).annotate({ description: "Draft prompt-cache scheduling options; defaults are provisional.", ...closedEngine }),
  ),
  memory: Schema.optional(
    Schema.Struct({
      selectTimeoutMs: Schema.optional(PositiveInt).annotate({
        description: "Deadline for selecting project memory before a request (draft default: 3000 ms).",
      }),
    }).annotate({ description: "Draft memory selection options; defaults are provisional.", ...closedEngine }),
  ),
}).annotate(closedEngine)

export const Info = Schema.Struct({
  $schema: Schema.optional(Schema.String).annotate({
    description: "JSON schema reference for configuration validation",
  }),
  maxToolCalls: Schema.optional(ToolBudget.MaxToolCalls),
  shell: Schema.optional(Schema.String).annotate({ description: "Default shell to use for terminal and bash tool" }),
  logLevel: Schema.optional(LogLevelRef).annotate({ description: "Log level" }),
  command: Schema.optional(Schema.Record(Schema.String, ConfigCommandV1.Info)).annotate({
    description: "Command configuration, see https://opencode.ai/docs/commands",
  }),
  skills: Schema.optional(ConfigSkillsV1.Info).annotate({ description: "Additional skill folder paths" }),
  references: Schema.optional(ConfigReference.Info).annotate({
    description: "Named git or local directory references",
  }),
  reference: Schema.optional(ConfigReference.Info).annotate({
    description: "@deprecated Use 'references' field instead. Named git or local directory references",
  }),
  watcher: Schema.optional(Schema.Struct({ ignore: Schema.optional(Schema.mutable(Schema.Array(Schema.String))) })),
  snapshot: Schema.optional(Schema.Boolean).annotate({
    description:
      "Enable or disable snapshot tracking. When false, filesystem snapshots are not recorded and undoing or reverting will not undo/redo file changes. Defaults to true.",
  }),
  autoupdate: Schema.optional(Schema.Union([Schema.Boolean, Schema.Literal("notify")])).annotate({
    description:
      "Deprecated compatibility setting; built-in application updates are disabled and this value is ignored",
  }),
  disabled_providers: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
    description: "Disable providers that are loaded automatically",
  }),
  enabled_providers: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
    description: "When set, ONLY these providers will be enabled. All other providers will be ignored",
  }),
  model: Schema.optional(Schema.String).annotate({
    description: "Model to use in the format of provider/model, eg anthropic/claude-2",
  }),
  small_model: Schema.optional(Schema.String).annotate({
    description: "Small model to use for tasks like title generation in the format of provider/model",
  }),
  default_agent: Schema.optional(Schema.String).annotate({
    description:
      "Default agent to use when none is specified. Must be a primary agent. Falls back to 'build' if not set or if the specified agent is invalid.",
  }),
  question_timeout: Schema.optional(PositiveInt).annotate({
    description: "Seconds to wait for a question response before the agent continues independently (default: 60)",
  }),
  username: Schema.optional(Schema.String).annotate({
    description: "Custom username to display in conversations instead of system username",
  }),
  language: Schema.optional(Schema.Literals(["zh-CN", "en"])).annotate({
    description:
      "Interface language and default assistant reply language. When unset, inferred from the system locale.",
  }),
  engine: Schema.optional(Engine).annotate({
    description:
      "Draft session-engine limits. Defaults are provisional and subject to measurement. Unknown keys under engine are rejected when the configuration loads.",
  }),
  mode: Schema.optional(
    Schema.StructWithRest(
      Schema.Struct({ build: Schema.optional(ConfigAgentV1.Info), plan: Schema.optional(ConfigAgentV1.Info) }),
      [Schema.Record(Schema.String, ConfigAgentV1.Info)],
    ),
  ).annotate({ description: "@deprecated Use `agent` field instead." }),
  agent: Schema.optional(
    Schema.StructWithRest(
      Schema.Struct({
        plan: Schema.optional(ConfigAgentV1.Info),
        build: Schema.optional(ConfigAgentV1.Info),
        general: Schema.optional(ConfigAgentV1.Info),
        explore: Schema.optional(ConfigAgentV1.Info),
        title: Schema.optional(ConfigAgentV1.Info),
        summary: Schema.optional(ConfigAgentV1.Info),
        compaction: Schema.optional(ConfigAgentV1.Info),
      }),
      [Schema.Record(Schema.String, ConfigAgentV1.Info)],
    ),
  ).annotate({ description: "Agent configuration, see https://opencode.ai/docs/agents" }),
  provider: Schema.optional(Schema.Record(Schema.String, ConfigProviderV1.Info)).annotate({
    description: "Custom provider configurations and model overrides",
  }),
  formatter: Schema.optional(ConfigFormatterV1.Info).annotate({
    description:
      "Enable or configure formatters. Omit or set to false to disable, true to enable built-ins, or an object to enable built-ins with overrides.",
  }),
  lsp: Schema.optional(ConfigLSPV1.Info).annotate({
    description:
      "Enable or configure LSP servers. Omit or set to false to disable, true to enable built-ins, or an object to enable built-ins with overrides.",
  }),
  instructions: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
    description: "Additional instruction files or patterns to include",
  }),
  layout: Schema.optional(ConfigLayoutV1.Layout).annotate({ description: "@deprecated Always uses stretch layout." }),
  permission: Schema.optional(ConfigPermissionV1.Info),
  permissions: Schema.optional(Permission.Ruleset).annotate({
    description: "Ordered permission rules; supersedes the legacy permission map within this document",
  }),
  hookPermissions: Schema.optional(
    Schema.Struct({
      mode: Schema.optional(Schema.Literals(["default", "manual", "acceptEdits", "dontAsk", "plan"])),
      directories: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
    }),
  ).annotate({ description: "OpenCode-owned permission hook mode and additional directory grants" }),
  tools: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)),
  attachment: Schema.optional(ConfigAttachmentV1.Info).annotate({
    description: "Attachment processing configuration, including image size limits and resizing behavior",
  }),
  enterprise: Schema.optional(
    Schema.Struct({ url: Schema.optional(Schema.String).annotate({ description: "Enterprise URL" }) }),
  ),
  tool_output: Schema.optional(
    Schema.Struct({
      max_lines: Schema.optional(PositiveInt).annotate({
        description:
          "Maximum lines of generic tool output before it is truncated and saved to disk (default: 2000); read, grep, glob and shell use their own line budgets",
      }),
      max_bytes: Schema.optional(PositiveInt).annotate({
        description:
          "Maximum bytes of generic tool output before it is truncated and saved to disk (default: 51200); shell's inline tail and saved-file threshold also use this byte budget",
      }),
    }),
  ).annotate({
    description:
      "Thresholds for truncating generic tool output. When output exceeds either limit, the full text is written to the truncation directory and a preview is returned. read, grep and glob use fixed per-tool budgets instead, while shell shares max_bytes and keeps its own 20-line tail.",
  }),
  compaction: Schema.optional(
    Schema.Struct({
      auto: Schema.optional(Schema.Boolean).annotate({
        description: "Enable automatic compaction when context is full (default: true)",
      }),
      dynamic: Schema.optional(Schema.Boolean).annotate({
        description:
          "@deprecated Legacy context folding, off by default. When explicitly enabled, folds strictly duplicate older tool outputs only in prepared model requests. Stored history is unchanged; this is independent from automatic or manual full compaction.",
      }),
      prune: Schema.optional(Schema.Boolean).annotate({
        description:
          "@deprecated Ignored. Context folding is off by default; set 'dynamic' to true to enable the legacy behavior.",
      }),
      tail_turns: Schema.optional(NonNegativeInt).annotate({
        description:
          "Number of recent user turns, including their following assistant/tool responses, to keep verbatim during compaction (default: 2)",
      }),
      preserve_recent_tokens: Schema.optional(NonNegativeInt).annotate({
        description: "Maximum number of tokens from recent turns to preserve verbatim after compaction",
      }),
      reserved: Schema.optional(NonNegativeInt).annotate({
        description: "Token buffer for compaction. Leaves enough window to avoid overflow during compaction.",
      }),
      mode: Schema.optional(Schema.Literals(["small", "shared", "auto"])).annotate({
        description:
          "Compaction request shape: 'small' sends a stripped request, 'shared' reuses the main request's cached system+tools prefix, and 'auto' picks the cheaper shape from model prices (default: small)",
      }),
    }),
  ),
  btw: Schema.optional(
    Schema.Struct({
      model: Schema.optional(Schema.String).annotate({
        description: "Model for side questions in the format provider/model; defaults to the session's current model",
      }),
      maxContextTokens: Schema.optional(PositiveInt).annotate({
        description: "Maximum context tokens for a side question (default: 48000)",
      }),
      maxOutputTokens: Schema.optional(PositiveInt).annotate({
        description: "Maximum output tokens for a side question answer (default: 2000)",
      }),
    }),
  ).annotate({ description: "Side question (btw) settings" }),
  reasoningDistillation: Schema.optional(ConfigReasoningDistillation.Info),
  experimental: Schema.optional(
    Schema.Struct({
      disable_paste_summary: Schema.optional(Schema.Boolean),
      batch_tool: Schema.optional(Schema.Boolean).annotate({ description: "Enable the batch tool" }),
      openTelemetry: Schema.optional(Schema.Boolean).annotate({
        description: "Enable OpenTelemetry spans for AI SDK calls (using the 'experimental_telemetry' flag)",
      }),
      primary_tools: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
        description: "Tools that should only be available to primary agents.",
      }),
      continue_loop_on_deny: Schema.optional(Schema.Boolean).annotate({
        description: "Continue the agent loop when a tool call is denied",
      }),
      policies: Schema.optional(Schema.mutable(Schema.Array(ConfigExperimental.Policy))).annotate({
        description: "Policy statements applied to supported resources, such as provider access",
      }),
    }),
  ),
  dag: Schema.optional(Dag),
}).annotate({ identifier: "Config" })

export type Info = DeepMutable<Schema.Schema.Type<typeof Info>>
