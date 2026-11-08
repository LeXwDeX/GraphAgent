/**
 * `type: "agent"` hook handler.
 *
 * Pure-move extraction from the former `hook/settings.ts` (D1 PR1).
 */
import { Effect, Option } from "effect"
import { generateText, type ModelMessage } from "ai"
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import { FSUtil } from "@graphagent/core/fs-util"
import * as Log from "@/util/log"
import { Auth } from "@/auth"
import { Provider } from "@/provider/provider"
import { buildAgentTools } from "../agent-tools"
import type { HookEvaluatorOutput } from "../schema"
import { commandText, timeoutFor } from "../exec/command"
import { evaluatorDecision, evaluatorModel, evaluatorPrompt } from "./prompt"
import type { HookHandler } from "./shared"

const log = Log.create({ service: "hook.settings" })

/**
 * `type: "agent"` handler — multi-turn LLM with a tool palette (CC v1 protocol).
 *
 * `entry.command` is the system prompt; the stdin envelope is JSON-stringified
 * into the user message. The model is given 5 read-only tools from `agent-tools.ts`
 * (read_file / list_dir / grep / bash / synthetic_output) and runs up to
 * MAX_AGENT_TURNS turns. The hook decision is emitted by calling synthetic_output;
 * the loop polls the captured slot after each turn.
 *
 * Failure policy is **silent allow** — same contract as makePromptHandler. Three
 * distinct failure log strings differentiate setup defects (provider/auth/getLanguage),
 * timeout/abort, and generateText reject so operators can grep them apart.
 *
 * Structure mirrors WP-4C-fix's prompt handler (outer Effect.exit on the setup
 * gen) plus an inner tryPromise+exit on the loop Promise so AbortError and
 * generateText rejects don't escape as defects.
 */
export const agentHandler: HookHandler = {
  type: "agent",
  run: Effect.fn("SettingsHook.handler.agent")(function* (entry, envelope, cwd, _inHook) {
    const provider = Option.getOrUndefined(yield* Effect.serviceOption(Provider.Service))
    const auth = Option.getOrUndefined(yield* Effect.serviceOption(Auth.Service))
    const spawner = Option.getOrUndefined(yield* Effect.serviceOption(ChildProcessSpawner))
    const fs = Option.getOrUndefined(yield* Effect.serviceOption(FSUtil.Service))
    if (!provider || !auth || !spawner || !fs) {
      log.warn("agent hook skipped: Provider/Auth/Spawner/FS not in context", { command: commandText(entry) })
      return { json: undefined, exitBlock: undefined }
    }
    const exit = yield* Effect.gen(function* () {
      const prompt = evaluatorPrompt(entry, envelope)
      const m = yield* evaluatorModel(provider, entry)
      const resolved = yield* provider.getModel(m.providerID, m.modelID)
      const language = yield* provider.getLanguage(resolved)
      const authInfo = yield* auth.get(m.providerID).pipe(Effect.orDie)

      if (m.providerID === "openai" && authInfo?.type === "oauth") {
        log.warn("agent hook: OpenAI OAuth provider not supported in v1", {
          command: prompt.slice(0, 80),
        })
        return { json: undefined, exitBlock: undefined }
      }

      const captured: { value: HookEvaluatorOutput | null } = { value: null }
      const timeoutMs = timeoutFor(entry, envelope.hook_event_name)

      const loopExit = yield* Effect.tryPromise({
        try: async (signal) => {
          const tools = buildAgentTools({ spawner, fs, signal, cwd, captured })
          const messages: ModelMessage[] = [
            {
              role: "system",
              content:
                "Investigate the hook condition using read-only tools. End by calling synthetic_output with ok and a reason when false.",
            },
            { role: "user", content: prompt },
          ]
          for (let turn = 0; turn < MAX_AGENT_TURNS; turn++) {
            signal.throwIfAborted()
            const result = await generateText({
              model: language,
              messages,
              tools,
              toolChoice: "auto",
              abortSignal: signal,
              maxOutputTokens: 4096,
              allowSystemInMessages: true,
            })
            if (captured.value) return captured.value
            messages.push(...result.response.messages)
            if (
              result.finishReason === "stop" ||
              result.finishReason === "length" ||
              result.finishReason === "content-filter"
            )
              break
            if (result.toolCalls.length === 0) break
          }
          return null
        },
        catch: (e) => e,
      }).pipe(Effect.timeout(timeoutMs), Effect.exit)

      if (loopExit._tag === "Failure") {
        const cause = String(loopExit.cause)
        const isAbort = cause.includes("AbortError") || cause.includes("aborted")
        if (isAbort) {
          log.warn("agent hook timeout / aborted (non-blocking)", {
            error: cause,
            command: prompt.slice(0, 80),
            hint: "deep-investigation hooks must also raise entry.timeout — the 60s default aborts well before MAX_AGENT_TURNS (50) is reached",
          })
        } else {
          log.warn("agent hook generateText failed (non-blocking)", {
            error: cause,
            command: prompt.slice(0, 80),
          })
        }
        return { json: undefined, exitBlock: undefined }
      }

      if (!loopExit.value) {
        log.warn("agent hook reached max turns or no synthetic_output (non-blocking)", {
          command: prompt.slice(0, 80),
        })
        return { json: undefined, exitBlock: undefined }
      }
      return {
        json: evaluatorDecision(entry, envelope.hook_event_name, loopExit.value),
        exitBlock: undefined,
        succeeded: true,
      }
    }).pipe(Effect.exit)

    if (exit._tag === "Failure") {
      log.warn("agent hook setup failed (non-blocking)", { error: String(exit.cause) })
      return { json: undefined, exitBlock: undefined }
    }
    return exit.value
  }),
}

// The agent loop has a bounded turn count and a separate 60-second default timeout.
const MAX_AGENT_TURNS = 50
