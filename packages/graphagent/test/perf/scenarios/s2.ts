// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { Effect } from "effect"
import type { SessionV1 } from "@graphagent/core/v1/session"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { makeFakeProvider, textScript } from "../../lib/fake-provider"
import { reset, settle, snapshot, stepBook, type Counters } from "../../lib/engine-probe"
import type { BaselineRequest } from "../fingerprint"
import { fingerprintRequests } from "../fingerprint"
import { makePerfLayer, perfConfig } from "../harness"
import { seedHistory } from "../seed"
import type { Measurement, Scenario } from "./types"

// S2: a session with 500 messages that compacts twice in one measured turn.
// The first compaction is triggered by the seeded last-assistant token count
// (observed usage, no provider round trip); its oversized summary pushes the
// next estimate over the limit, so a second compaction replaces it. The second
// summary is short, letting the turn finish with one conversation request.
const MESSAGES = 500
const TURNS = MESSAGES / 2
const CONTEXT = 10_000
const OUTPUT = 1_000
const TRIGGER_TOKENS = CONTEXT - 500

// Compaction keeps a recent tail outside the summary, bounded by
// `preserve_recent_tokens` (25% of the usable budget, 2250 tokens here). The
// measured user turn must exceed that budget: otherwise the first compaction
// retains the turn as its tail, and the follow-up compaction's tail slice spans
// back over the previous compaction pair and re-exposes the oversized summary,
// which would trigger a third compaction. An oversized user message makes the
// first compaction take the whole history instead, so exactly two compactions
// run before the conversation request.
const PROMPT_TEXT = "continue the task\n\n" + "context ".repeat(2_000)

/** One measured pass: engine counters plus the request/message facts S2 asserts. */
export interface S2PassResult {
  readonly counts: Counters
  readonly steps: number
  readonly perStep: Counters
  readonly requests: ReadonlyArray<BaselineRequest>
  readonly compactions: number
  readonly compactionRequests: number
  readonly conversationRequests: number
  readonly compactionMessages: number
  readonly finalRole: SessionV1.Info["role"]
}

export interface S2Result extends Measurement {
  /** Request shapes of the last measured pass; the gate mirrors this book. */
  readonly requests: ReadonlyArray<BaselineRequest>
  readonly first: S2PassResult
  readonly second: S2PassResult
}

export function s2Scenario(): Scenario<S2Result, Session.Service | SessionPrompt.Service> {
  const baseModel = perfConfig.provider.test.models["test-model"]
  const config = {
    ...perfConfig,
    compaction: { auto: true },
    provider: {
      ...perfConfig.provider,
      test: {
        ...perfConfig.provider.test,
        models: {
          "test-model": { ...baseModel, limit: { context: CONTEXT, output: OUTPUT } },
        },
      },
    },
  }

  let compactions = 0
  const fake = makeFakeProvider({
    title: "S2",
    script: (_input, request) => {
      if (request.purpose === "compaction") {
        compactions += 1
        // Roughly 14k estimated tokens (4 bytes per token), comfortably above the
        // 9k usable budget.
        return textScript(compactions === 1 ? "oversized summary ".repeat(3_000) : "short summary")
      }
      return textScript("continued answer")
    },
  })

  const run = Effect.gen(function* () {
    const sessions = yield* Session.Service
    const prompt = yield* SessionPrompt.Service

    const runScenario = (title: string) =>
      Effect.gen(function* () {
        const session = yield* sessions.create({ title })
        yield* seedHistory(session.id, {
          turns: TURNS,
          lastTokens: { input: TRIGGER_TOKENS, output: 50 },
        })
        reset()
        fake.reset()
        compactions = 0
        const result = yield* prompt.prompt({
          sessionID: session.id,
          agent: "build",
          parts: [{ type: "text", text: PROMPT_TEXT }],
        })
        yield* settle({ activity: fake.activity, timeoutMs: 30_000 })
        const counts = snapshot()
        // Close the per-request book before any other read (request filters,
        // sessions.messages, store queries) so the deltas cover exactly this pass.
        const book = stepBook()
        const requests = fake.requests.filter((request) => request.purpose !== "auxiliary")
        const messages = yield* sessions.messages({ sessionID: session.id })
        return {
          counts,
          steps: book.steps,
          perStep: book.perStep,
          requests: fingerprintRequests(fake.requests),
          compactions,
          compactionRequests: requests.filter((request) => request.purpose === "compaction").length,
          conversationRequests: requests.filter((request) => request.purpose === "conversation").length,
          compactionMessages: messages.filter((message) => message.parts.some((part) => part.type === "compaction"))
            .length,
          finalRole: result.info.role,
        }
      })

    yield* runScenario("S2 warmup")
    const first = yield* runScenario("S2 first")
    const second = yield* runScenario("S2 second")
    return {
      counts: second.counts,
      steps: second.steps,
      perStep: second.perStep,
      requests: second.requests,
      first,
      second,
    }
  })

  return {
    id: "S2",
    layer: makePerfLayer(fake),
    instance: { git: true, config },
    timeout: 180_000,
    run,
  }
}
