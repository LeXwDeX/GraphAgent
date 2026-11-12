// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { ConfigReasoningDistillation } from "@graphagent/core/config/reasoning-distillation"
import { Database } from "@graphagent/core/database/database"
import { Flag } from "@graphagent/core/flag/flag"
import {
  assessCanonicalReasoning,
  ReasoningDistillationPolicy,
  rewriteLogFields,
  runReasoningRewrite,
} from "@graphagent/core/session/reasoning-distillation"
import type { SessionV1 } from "@graphagent/core/v1/session"
import { Effect, Option } from "effect"
import type { Context } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { EventV2Bridge } from "@/event-v2-bridge"
import type { Config } from "@/config/config"
import type { Provider } from "@/provider/provider"
import { Token } from "@/util/token"
import type { AgentScheduler } from "./agent-scheduler"
import type { LLM } from "./llm"
import { adoptReasoning } from "./reasoning-adoption"
import type { SessionRuntimes } from "./runtime"
import type { SessionID } from "./schema"
import { Session } from "./session"

export interface ReasoningRewriteDeps {
  readonly config: Config.Interface
  readonly sessions: Session.Interface
  readonly llm: LLM.Interface
  readonly scheduler: AgentScheduler.Interface
  readonly events: Context.Service.Shape<typeof EventV2Bridge.Service>
  readonly database: Database.Interface
  readonly runtimes: SessionRuntimes
}

/**
 * Background reasoning-distillation glue of the prompt service (Issue #1019,
 * PR-b). Moved verbatim out of `prompt.ts`: the processor calls `queueReasoning`
 * for each settled reasoning part and the loop commits the queued candidate
 * before it reads history.
 */
export function makeReasoningRewrite(deps: ReasoningRewriteDeps) {
  const { config, sessions, llm, scheduler, events, database, runtimes } = deps

  const reasoningDistillationEnabled = (model: Provider.Model) =>
    config.get().pipe(
      Effect.map(
        (cfg) =>
          ConfigReasoningDistillation.resolveEnabled({
            disabledByEnvironment: Flag.GRAPHAGENT_DISABLE_REASONING_DISTILLATION,
            enabled: cfg.reasoningDistillation?.enabled,
            modelEnabled: cfg.provider?.[model.providerID]?.models?.[model.id]?.reasoningDistillation?.enabled,
          }).enabled,
      ),
    )
  const queueReasoning = (input: { sessionID: SessionID; part: SessionV1.ReasoningPart; model: Provider.Model }) =>
    Effect.gen(function* () {
      const directory = yield* InstanceState.directory
      const rewrite = runtimes.directory(directory)
      runtimes.own(input.sessionID, directory)
      return yield* rewrite.queue.enqueue(
        input.sessionID,
        input.part.id,
        Effect.gen(function* () {
          if (!(yield* reasoningDistillationEnabled(input.model))) return undefined
          const part = yield* sessions.getPart({
            sessionID: input.sessionID,
            messageID: input.part.messageID,
            partID: input.part.id,
          })
          if (part?.type !== "reasoning") return undefined
          const editability = assessCanonicalReasoning({
            text: part.text,
            metadata: part.metadata,
            settled: part.time.end !== undefined,
            distilled: part.distillation !== undefined,
          })
          if (
            !editability.editable ||
            Token.estimate(part.text) < ReasoningDistillationPolicy.tokens.minimumInputTokens
          )
            return undefined
          if (rewrite.budget.admit(input.sessionID) !== "ok") return undefined
          const cfg = yield* config.get()
          const organizer = yield* llm.organizer({ model: input.model })
          if (!organizer) return undefined
          return yield* Effect.scoped(
            Effect.gen(function* () {
              // Reasoning rewriting is background work: when no stream
              // permit is free it is dropped, exactly like the queue's own
              // per-session bound, instead of delaying the turn.
              const permit = yield* scheduler.tryRequest({
                lane: "background",
                providerID: organizer.providerID,
                modelID: organizer.modelID,
                sessionID: input.sessionID,
              })
              if (Option.isNone(permit)) return undefined
              const outcome = yield* runReasoningRewrite({
                budget: rewrite.budget,
                sessionID: input.sessionID,
                slot: { messageID: part.messageID, partID: part.id, text: part.text },
                language: ConfigReasoningDistillation.resolveLanguage(cfg.reasoningDistillation),
                call: organizer.call,
                // Organization only queues a candidate; the next step commits it before reading history.
                adopt: (replacement) => Effect.succeed(replacement),
              })
              yield* Effect.logInfo(
                "reasoning distillation",
                rewriteLogFields(outcome, {
                  runtime: "opencode",
                  mode: "async",
                  "session.id": input.sessionID,
                  model: organizer.model,
                  transport: organizer.transport,
                }),
              )
              if (!outcome.adopted) return undefined
              return adoptReasoning({
                sessionID: input.sessionID,
                part,
                replacement: outcome.adopted,
                canAdopt: reasoningDistillationEnabled(input.model),
              }).pipe(
                Effect.provideService(Database.Service, database),
                Effect.provideService(Session.Service, sessions),
                Effect.provideService(EventV2Bridge.Service, events),
              )
            }),
          )
        }),
      )
    })

  return { reasoningDistillationEnabled, queueReasoning }
}
