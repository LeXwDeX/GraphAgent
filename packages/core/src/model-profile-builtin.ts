// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { BuiltinRule, ModelProfile, RuleInput } from "./model-profile"

/** Ids of the Mistral family; a model of the provider `mistral` belongs to it whatever its id says. */
const MISTRAL_FAMILIES = ["mistral", "devstral", "codestral", "pixtral", "mixtral"]

/** Packages through which a MiniMax-M3 endpoint takes a thinking switch in the request body. */
const MINIMAX_M3_NPMS = ["@ai-sdk/anthropic", "@ai-sdk/openai-compatible"]

/** Providers that host MiniMax-M3 behind a chat template, which takes the switch as a template argument. */
const CHAT_TEMPLATE_PROVIDERS = ["nvidia", "lilac"]

/** Gemini models that keep the sampling defaults; later ones deprecated them. */
const GEMINI_MODELS_WITH_SAMPLING_DEFAULTS = [
  /gemini-2[.-]5(?:[.-]|$)/,
  /gemini-3-(?:flash|pro)(?:[.-]|$)/,
  /gemini-3[.-]1(?:[.-]|$)/,
  /gemini-3[.-]5-flash(?!-lite)(?:[.-]|$)/,
]

function temperatureOf(input: RuleInput): number | undefined {
  const id = input.apiID.toLowerCase()
  if (id.includes("north-mini-code")) return 1.0
  if (id.includes("claude")) return undefined
  if (id.includes("gemini"))
    return GEMINI_MODELS_WITH_SAMPLING_DEFAULTS.some((pattern) => pattern.test(id)) ? 1.0 : undefined
  if (id.includes("glm-4.6")) return 1.0
  if (id.includes("glm-4.7")) return 1.0
  if (id.includes("minimax-m2")) return 1.0
  if (id.includes("kimi-k2")) {
    // kimi-k2-thinking & kimi-k2.5 && kimi-k2p5 && kimi-k2-5
    if (["thinking", "k2.", "k2p", "k2-5"].some((s) => id.includes(s))) {
      return 1.0
    }
    return 0.6
  }
  return undefined
}

function topPOf(input: RuleInput): number | undefined {
  const id = input.apiID.toLowerCase()
  if (id.includes("gemini"))
    return GEMINI_MODELS_WITH_SAMPLING_DEFAULTS.some((pattern) => pattern.test(id)) ? 0.95 : undefined
  if (["minimax-m2", "kimi-k2.5", "kimi-k2p5", "kimi-k2-5"].some((s) => id.includes(s))) {
    return 0.95
  }
  if (
    ["deepseek-v4-flash-0731", "deepseek-v4-flash:0731"].some((name) => id.includes(name)) ||
    (id.includes("deepseek-v4-flash") && input.providerID === "deepseek")
  ) {
    return 0.95
  }
  return undefined
}

function topKOf(input: RuleInput): number | undefined {
  const id = input.apiID.toLowerCase()
  if (id.includes("minimax-m2")) {
    if (["m2.", "m25", "m21"].some((s) => id.includes(s))) return 40
    return 20
  }
  if (id.includes("gemini"))
    return GEMINI_MODELS_WITH_SAMPLING_DEFAULTS.some((pattern) => pattern.test(id)) ? 64 : undefined
  return undefined
}

/** The three sampling defaults of the model, or undefined when none of them has a default. */
function samplingOf(input: RuleInput): ModelProfile["sampling"] | undefined {
  const temperature = temperatureOf(input)
  const topP = topPOf(input)
  const topK = topKOf(input)
  if (temperature === undefined && topP === undefined && topK === undefined) return undefined
  return {
    ...(temperature === undefined ? {} : { temperature }),
    ...(topP === undefined ? {} : { topP }),
    ...(topK === undefined ? {} : { topK }),
  }
}

/** Where tool result media goes for this npm package; undefined when none of it is sent inside the tool result. */
function toolResultMediaOf(input: RuleInput): ModelProfile["toolResultMedia"] | undefined {
  if (input.npm === "@ai-sdk/anthropic") return "all"
  if (input.npm === "@ai-sdk/openai") return "all"
  if (input.npm === "@ai-sdk/amazon-bedrock/mantle") return "all"
  if (input.npm === "@ai-sdk/amazon-bedrock") return "image"
  if (input.npm === "@ai-sdk/xai") return "image"
  if (input.npm === "@ai-sdk/google-vertex/anthropic") return "all"
  if (input.npm === "@ai-sdk/google") {
    const id = input.apiID.toLowerCase()
    return id.includes("gemini-3") && !id.includes("gemini-2") ? "all" : undefined
  }
  return undefined
}

/**
 * Built-in profile rules, the last source before the defaults.
 *
 * - Rules run in declaration order. When `match(input)` is true, `set(input)` only fills the fields that
 *   no earlier source (config, an existing entry, a catalog alias, an earlier rule) has declared; the fields
 *   it fills record `builtin:<name>` in `ModelProfile.sources`.
 * - `source` is required: a documentation link, or `<commit>:<file>:<line>` of the code the rule replaces.
 * - `name` is unique across the table.
 * - `match` must tolerate a missing `npm`, `releaseDate` and `vendor`.
 *
 * A rule is added with the Issue that migrates the reader that needs it.
 */
export const BUILTIN_RULES: ReadonlyArray<BuiltinRule> = [
  {
    // The gpt- family edits through apply_patch; gpt-4 and the open-weight gpt-oss keep edit and write.
    name: "edit-tools-apply-patch",
    source: "296a1a5d0:packages/graphagent/src/tool/editing-tools.ts:6",
    match(input) {
      const id = input.apiID.toLowerCase()
      return id.includes("gpt-") && !id.includes("oss") && !id.includes("gpt-4")
    },
    set: () => ({ editTools: "apply_patch" }),
  },
  {
    // Anthropic-compatible endpoints reject a tool call id outside [A-Za-z0-9_-].
    name: "tool-call-id-claude",
    source: "296a1a5d0:packages/graphagent/src/provider/transform.ts:101,238",
    match(input) {
      const id = input.apiID.toLowerCase()
      return id.includes("claude")
    },
    set: () => ({ toolCallId: { charset: "alnum_dash" } }),
  },
  {
    // Mistral wants nine alphanumeric characters and rejects a user message directly after a tool result.
    name: "tool-call-id-mistral",
    source: "296a1a5d0:packages/graphagent/src/provider/transform.ts:95,105,269",
    match(input) {
      const id = input.apiID.toLowerCase()
      return input.providerID === "mistral" || MISTRAL_FAMILIES.some((family) => id.includes(family))
    },
    set: () => ({ toolCallId: { charset: "alnum", length: 9 }, userAfterToolResult: "bridge" }),
  },
  {
    // The Anthropic and Alibaba protocols, and every model that names Claude or Anthropic, take cache breakpoints.
    name: "cache-marker-anthropic",
    source: "296a1a5d0:packages/graphagent/src/provider/transform.ts:748-751,754-755",
    match(input) {
      const id = input.apiID.toLowerCase()
      return (
        input.providerID === "anthropic" ||
        input.providerID === "google-vertex-anthropic" ||
        id.includes("anthropic") ||
        id.includes("claude") ||
        input.npm === "@ai-sdk/anthropic" ||
        input.npm === "@ai-sdk/alibaba"
      )
    },
    set: () => ({ cacheMarker: "explicit" }),
  },
  {
    // The sampling values the vendors recommend; a model none of the three names is left to the endpoint.
    name: "sampling-defaults",
    source: "296a1a5d0:packages/graphagent/src/provider/transform.ts:794-845",
    match: (input) => samplingOf(input) !== undefined,
    set: (input) => ({ sampling: samplingOf(input) }),
  },
  {
    // Tool results carry media inline only where the SDK and the endpoint take it there.
    name: "tool-result-media",
    source: "296a1a5d0:packages/graphagent/src/session/message-v2.ts:206-218",
    match: (input) => toolResultMediaOf(input) !== undefined,
    set: (input) => ({ toolResultMedia: toolResultMediaOf(input) }),
  },
  {
    // DeepSeek wants reasoning on every assistant message of the history, so each one without it gets an empty string.
    name: "reasoning-placeholder-deepseek",
    source: "296a1a5d0:packages/graphagent/src/provider/transform.ts:310-326",
    match(input) {
      const id = input.apiID.toLowerCase()
      return id.includes("deepseek")
    },
    set: () => ({ reasoningMode: { placeholder: true } }),
  },
  {
    // MiniMax-M3 behind a chat template turns thinking on and off through a template argument.
    name: "minimax-m3-toggle-chat-template",
    source: "296a1a5d0:packages/graphagent/src/provider/transform.ts:1038-1052",
    match(input) {
      const id = input.apiID.toLowerCase()
      return (
        id.includes("minimax-m3") &&
        input.npm !== undefined &&
        MINIMAX_M3_NPMS.includes(input.npm) &&
        CHAT_TEMPLATE_PROVIDERS.includes(input.providerID)
      )
    },
    set: () => ({
      reasoningMode: {
        controls: [{ type: "toggle" }],
        toggle: {
          on: { chat_template_kwargs: { thinking_mode: "enabled" } },
          off: { chat_template_kwargs: { thinking_mode: "disabled" } },
        },
      },
    }),
  },
  {
    // Every other MiniMax-M3 endpoint takes the Anthropic style thinking switch in the request body.
    name: "minimax-m3-toggle",
    source: "296a1a5d0:packages/graphagent/src/provider/transform.ts:1038-1052",
    match(input) {
      const id = input.apiID.toLowerCase()
      return id.includes("minimax-m3") && input.npm !== undefined && MINIMAX_M3_NPMS.includes(input.npm)
    },
    set: () => ({
      reasoningMode: {
        controls: [{ type: "toggle" }],
        toggle: { on: { thinking: { type: "adaptive" } }, off: { thinking: { type: "disabled" } } },
      },
    }),
  },
]
