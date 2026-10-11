import { LLM, LLMResponse, Model, type LLMClientShape, type LLMRequest } from "@opencode-ai/llm"
import { RequestExecutor } from "@opencode-ai/llm/route"
import { Duration, Effect, Stream } from "effect"
import type { OrganizeCall } from "./organize"
import { ReasoningDistillationPolicy } from "./policy"

/** `default` keeps the model's own reasoning settings; `none`/`low` are translated for the routed protocol. */
export type OrganizerEffort = "default" | "none" | "low"

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** Whether a resolved engine model already disables reasoning through its declared request defaults. */
export const declaresNoReasoning = (model: LLMRequest["model"]) =>
  [model.route.defaults.http?.body, model.defaults?.http?.body].some(
    (body) =>
      isRecord(body) &&
      (body.reasoning_effort === "none" ||
        body.reasoningEffort === "none" ||
        (isRecord(body.reasoning) && body.reasoning.effort === "none") ||
        (isRecord(body.thinking) && body.thinking.type === "disabled")),
  )

/** The organizer's output cap, lowered to the model's declared output limit so capped providers accept the call. */
export const organizerMaxTokens = (model: LLMRequest["model"]) => {
  const limit = model.defaults?.limits?.output ?? model.route.defaults.limits?.output
  const cap = ReasoningDistillationPolicy.tokens.maxOutputTokens
  return limit !== undefined && Number.isFinite(limit) && limit > 0 ? Math.min(limit, cap) : cap
}

const effortBody = (protocol: string, effort: "none" | "low") =>
  protocol === "openai-responses"
    ? { reasoning: { effort } }
    : protocol === "openai-chat" || protocol === "openai-compatible-chat"
      ? { reasoning_effort: effort }
      : undefined

/**
 * Organizer transport over the `@opencode-ai/llm` engine: one request, no tools, temperature 0, no automatic retries.
 * Provider SDKs are not involved; the routed protocol lowers the request.
 */
export const engineOrganizerCall = (input: {
  llm: LLMClientShape
  model: LLMRequest["model"]
  effort: OrganizerEffort
  timeoutMs: number
  signal?: AbortSignal
  onResponseStarted?: () => void
}): OrganizeCall => {
  const effort = input.effort === "default" ? undefined : input.effort
  return async ({ prompt }) => {
    let started = false
    const transport = input.model.route.transport
    const route = input.model.route.with({
      transport: {
        ...transport,
        frames: (prepared, request, runtime) =>
          transport.frames(prepared, request, runtime).pipe(
            Stream.tap(() =>
              Effect.sync(() => {
                if (started) return
                started = true
                input.onResponseStarted?.()
              }),
            ),
          ),
      },
    })
    const request = LLM.request({
      model: Model.update(input.model, { route }),
      prompt,
      tools: [],
      toolChoice: "none",
      generation: { temperature: 0, maxTokens: organizerMaxTokens(input.model) },
      ...(effort ? { providerOptions: { openai: { reasoningEffort: effort } } } : {}),
      http: {
        timeout: Duration.millis(input.timeoutMs),
        body: effort ? effortBody(input.model.route.protocol, effort) : undefined,
      },
      metadata: { purpose: "auxiliary", feature: "reasoning-distillation" },
    })
    const events = await Effect.runPromise(
      input.llm.stream(request).pipe(Stream.runCollect, Effect.provideService(RequestExecutor.MaxRetries, 0)),
      input.signal ? { signal: input.signal } : undefined,
    )
    const response = LLMResponse.fromEvents(events)
    if (!response) throw new Error("Organizer stream ended without a complete response")
    return {
      text: LLMResponse.text(response),
      usageTokens: LLMResponse.usage(response)?.totalTokens,
      finishReason: response.finishReason,
    }
  }
}
