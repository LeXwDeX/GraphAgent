import { createHash } from "node:crypto"
import { LLM, type StreamInput } from "@/session/llm"
import { LLMEvent } from "@opencode-ai/llm"
import { Effect, Layer, Stream } from "effect"
import { touch } from "./engine-probe"

/**
 * Scripted in-process LLM provider for the H0 performance scenarios.
 *
 * It replaces `LLM.Service` instead of speaking HTTP so scenarios stay
 * deterministic and free of sockets. Every request is fingerprinted from the
 * exact `StreamInput` the production engine built: tool schemas, system
 * prompt, conversation prefix and tool choice.
 */
export interface RequestFingerprint {
  readonly step: number
  readonly purpose: string
  readonly small: boolean
  readonly messageCount: number
  readonly toolsHash: string
  readonly systemHash: string
  readonly prefixHash: string
  readonly toolChoice: string
}

export interface FakeProviderOptions {
  /** Build the event script for one request. Defaults to a single text reply. */
  readonly script?: (input: StreamInput, request: RequestFingerprint) => LLMEvent[]
  /** Reply used for auxiliary requests such as title generation. */
  readonly title?: string
  /** Reply used for conversation requests. */
  readonly reply?: string
}

export function textScript(text: string, reason: "stop" | "unknown" = "stop"): LLMEvent[] {
  return [
    LLMEvent.stepStart({ index: 0 }),
    LLMEvent.textStart({ id: "text-1" }),
    LLMEvent.textDelta({ id: "text-1", text }),
    LLMEvent.textEnd({ id: "text-1" }),
    LLMEvent.stepFinish({ index: 0, reason }),
    LLMEvent.finish({ reason }),
  ]
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 16)
}

function toolShape(tools: StreamInput["tools"]) {
  return Object.keys(tools)
    .sort()
    .map((name) => {
      const tool = tools[name] as { description?: unknown; inputSchema?: unknown }
      return `${name}:${JSON.stringify(tool?.description ?? "")}:${JSON.stringify(tool?.inputSchema ?? "")}`
    })
    .join("\n")
}

function fingerprint(input: StreamInput, step: number): RequestFingerprint {
  const purpose = input.purpose ?? (input.small ? "auxiliary" : "conversation")
  return {
    step,
    purpose,
    small: input.small === true,
    messageCount: input.messages.length,
    toolsHash: hash(toolShape(input.tools)),
    systemHash: hash(input.system.join("\n")),
    prefixHash: hash(JSON.stringify(input.messages.slice(0, 8))),
    toolChoice: input.toolChoice ?? "auto",
  }
}

export interface FakeProvider {
  readonly layer: Layer.Layer<LLM.Service>
  readonly requests: RequestFingerprint[]
  /** Request count; feeds `settle()` activity so in-flight replies are awaited. */
  readonly activity: () => number
  reset(): void
}

export function makeFakeProvider(options?: FakeProviderOptions): FakeProvider {
  const requests: RequestFingerprint[] = []
  const layer = Layer.succeed(
    LLM.Service,
    LLM.Service.of({
      organizer: () => Effect.succeed(undefined),
      stream: (input) => {
        const request = fingerprint(input, requests.length)
        requests.push(request)
        touch()
        const auxiliary = request.purpose === "auxiliary" || request.small
        const events = auxiliary
          ? textScript(options?.title ?? "E2E Title")
          : (options?.script?.(input, request) ?? textScript(options?.reply ?? "ok"))
        return Stream.fromIterable(events)
      },
    }),
  )
  return {
    layer,
    requests,
    activity: () => requests.length,
    reset: () => {
      requests.length = 0
    },
  }
}
