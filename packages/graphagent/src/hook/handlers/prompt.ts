/**
 * `type: "prompt"` hook handler and evaluator helpers shared with `agent`.
 *
 * Pure-move extraction from the former `hook/settings.ts` (D1 PR1).
 */
import { Effect, Option } from "effect"
import { generateObject, type ModelMessage } from "ai"
import * as Log from "@/util/log"
import { Auth } from "@/auth"
import { Provider } from "@/provider/provider"
import { HookEvaluatorOutputSchema, type HookEvaluatorOutput } from "../schema"
import type { HookCommand, HookEvent, HookJSONOutput } from "../types"
import { commandText, promptText, timeoutFor } from "../exec/command"
import type { HookHandler } from "./shared"

const log = Log.create({ service: "hook.settings" })

/**
 * `$ARGUMENTS` becomes the hook input JSON and `\$` is a literal dollar sign. Without an
 * unescaped placeholder the input is appended (reference 599, 3908).
 */
export function evaluatorPrompt(entry: HookCommand, envelope: Record<string, unknown>): string {
  const template = promptText(entry)
  const input = JSON.stringify(envelope)
  let placed = false
  const text = template.replace(/\\\$|\$ARGUMENTS/g, (match) => {
    if (match === "\\$") return "$"
    placed = true
    return input
  })
  return placed ? text : `${text}\n\n${input}`
}

/**
 * An explicit model is used as configured. Otherwise the evaluator uses the small
 * model the host picks for background work, then the default model.
 */
export const evaluatorModel = Effect.fnUntraced(function* (provider: Provider.Interface, entry: HookCommand) {
  const fallback = yield* provider.defaultModel()
  if (entry.model)
    return Provider.parseModel(entry.model.includes("/") ? entry.model : `${fallback.providerID}/${entry.model}`)
  const small = yield* Effect.suspend(() => provider.getSmallModel(fallback.providerID)).pipe(
    Effect.catchCause(() => Effect.succeed(undefined)),
  )
  return small ? { providerID: small.providerID, modelID: small.id } : fallback
})

export function evaluatorDecision(
  entry: HookCommand,
  event: HookEvent,
  answer: HookEvaluatorOutput,
): HookJSONOutput | undefined {
  if (answer.ok) return undefined
  if (!answer.reason) return undefined
  if (event === "PermissionRequest" || event === "PermissionDenied") return undefined
  if ((event === "Stop" || event === "SubagentStop") && entry.type === "prompt" && answer.impossible) return undefined
  const continueOnBlock = entry.type === "agent" || entry.continueOnBlock === true
  if (event === "PreToolUse")
    return {
      ...(continueOnBlock ? {} : { continue: false, stopReason: answer.reason, systemMessage: answer.reason }),
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: answer.reason,
      },
    }
  if (event === "PostToolUse" || event === "TeammateIdle")
    return continueOnBlock
      ? { hookSpecificOutput: { hookEventName: event, additionalContext: answer.reason } }
      : { continue: false, stopReason: answer.reason, systemMessage: answer.reason }
  if (event === "PostToolUseFailure")
    return { hookSpecificOutput: { hookEventName: event, additionalContext: answer.reason } }
  // The reference returns this reason as a tool error: the todo write is refused
  // with the reason as feedback, while the turn keeps running (no continue:false).
  // systemMessage keeps the human-visible notification from the previous behavior.
  if (event === "TaskCreated" || event === "TaskCompleted")
    return { decision: "block", reason: answer.reason, systemMessage: answer.reason }
  return { decision: "block", reason: answer.reason, systemMessage: answer.reason }
}

/**
 * `type: "prompt"` handler — single-turn LLM call (CC v1 protocol).
 *
 * `entry.command` is interpreted as the system prompt template; the stdin envelope
 * (already shaped by buildStdinEnvelope) is JSON-stringified into the user message.
 * The model returns structured output matching HookOutputSchema (loose flat
 * shape; see definition near HookJSONOutput).
 *
 * Failure policy is **silent allow** — mirrors httpHandler's network-error path:
 *   - OpenAI OAuth provider: not supported in v1 (no API key for generateObject).
 *     log.warn + return undefined json. v2 may switch to small-fast model w/ OAuth path.
 *   - generateObject reject (auth missing, rate-limit, schema mismatch, …): log.warn +
 *     return undefined json. Hooks must never crash or block the host on infra errors.
 *
 * MUST use `Effect.tryPromise + Effect.exit` (not `Effect.promise`): the latter
 * turns a reject into a defect, which would propagate as a die and violate the
 * non-blocking hook contract. The agent.ts:397 pattern is intentionally NOT copied
 * here for that exact reason.
 */
export const promptHandler: HookHandler = {
  type: "prompt",
  run: Effect.fn("SettingsHook.handler.prompt")(function* (entry, envelope, _cwd, _inHook) {
    const provider = Option.getOrUndefined(yield* Effect.serviceOption(Provider.Service))
    const auth = Option.getOrUndefined(yield* Effect.serviceOption(Auth.Service))
    if (!provider || !auth) {
      log.warn("prompt hook skipped: Provider/Auth not in context", { command: commandText(entry) })
      return { json: undefined, exitBlock: undefined }
    }
    const exit = yield* Effect.gen(function* () {
      const prompt = evaluatorPrompt(entry, envelope)
      const m = yield* evaluatorModel(provider, entry)
      const resolved = yield* provider.getModel(m.providerID, m.modelID)
      const language = yield* provider.getLanguage(resolved)

      const authInfo = yield* auth.get(m.providerID).pipe(Effect.orDie)
      if (m.providerID === "openai" && authInfo?.type === "oauth") {
        log.warn("prompt hook: OpenAI OAuth provider not supported in v1", {
          command: prompt.slice(0, 80),
        })
        return { json: undefined, exitBlock: undefined }
      }

      const params = {
        temperature: 0.3,
        model: language,
        messages: [
          {
            role: "system",
            content: "Evaluate the hook condition and return JSON with ok, and reason when ok is false.",
          } as ModelMessage,
          { role: "user", content: prompt } as ModelMessage,
        ],
        schema: HookEvaluatorOutputSchema,
      } satisfies Parameters<typeof generateObject>[0]

      // issue #286 — the header doc promises `timeout` for every hook type,
      // but promptHandler was the only executor never applying it. Honor it
      // with the same idiom as command/mcp/http; on expiry the TimeoutException
      // is captured by Effect.exit below and degrades to the non-blocking warn.
      const timeoutMs = timeoutFor(entry, envelope.hook_event_name)

      const llmExit = yield* Effect.tryPromise({
        try: (abortSignal) => generateObject({ ...params, abortSignal }).then((r) => r.object),
        catch: (e) => e,
      }).pipe(Effect.timeout(timeoutMs), Effect.exit)

      if (llmExit._tag === "Failure") {
        log.warn("prompt hook failed (non-blocking)", { error: String(llmExit.cause) })
        return { json: undefined, exitBlock: undefined }
      }
      return {
        json: evaluatorDecision(entry, envelope.hook_event_name, llmExit.value),
        exitBlock: undefined,
        succeeded: true,
      }
    }).pipe(Effect.exit)

    if (exit._tag === "Failure") {
      log.warn("prompt hook setup failed (non-blocking)", { error: String(exit.cause) })
      return { json: undefined, exitBlock: undefined }
    }
    return exit.value
  }),
}
