// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { Effect } from "effect"
import { SessionV1 } from "@graphagent/core/v1/session"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { makeFakeProvider, textScript } from "../../lib/fake-provider"
import { reset, settle, snapshot, stepBook, type Counters } from "../../lib/engine-probe"
import type { BaselineRequest } from "../fingerprint"
import { fingerprintRequests } from "../fingerprint"
import { makePerfLayer, perfConfig } from "../harness"
import { seedCompactedHistory } from "../seed"
import type { Measurement, Scenario } from "./types"

// S3: a cold start on a long, heavily compacted session. The table holds 5000
// messages and ten completed compaction boundaries; the final boundary's tail
// marker points near the end, so the reconstructed visible history is only the
// retained tail. The measured turn is a plain conversation request: it must
// read the visible history, carry the media parts (images on user messages,
// one 256KiB message diff), and trigger no compaction.
//
// The tail-bounded claim reconstructs this view from the retained tail alone:
// `sql.read` records the bounded statement count and `convert.messages` records
// what the reconstructed history contains.
export const MESSAGES = 5_000
export const TURNS = MESSAGES / 2
export const COMPACTION_EVERY = 250
export const TAIL_TURNS = 50
const IMAGE_EVERY = 5
export const SUMMARY_DIFF_BYTES = 256 * 1_024

const CONTEXT = 10_000
const OUTPUT = 1_000
const PROMPT_TEXT = "continue the task"

/** The scalar results of one measured pass. */
export interface S3Pass {
  /** Whole-window counters for this pass. */
  readonly counts: Counters
  /** Request shapes issued by the measured turn. */
  readonly requests: ReadonlyArray<BaselineRequest>
  /** Completed compaction boundaries the pass starts from. */
  readonly seededCompactions: number
  /** Conversation requests issued by the measured turn. */
  readonly conversationRequests: number
  /** Compaction requests issued by the measured turn. */
  readonly compactionRequests: number
  /** Role of the message the measured prompt resolved to. */
  readonly finalRole: SessionV1.Info["role"]
}

export interface S3Result extends Measurement {
  /** Request shapes of the last measured pass; the gate mirrors this book. */
  readonly requests: ReadonlyArray<BaselineRequest>
  /** First measured pass, kept for the determinism comparison. */
  readonly first: S3Pass
  /** Last measured pass; its books are also the top-level Measurement fields. */
  readonly second: S3Pass
}

export function s3Scenario(): Scenario<S3Result, Session.Service | SessionPrompt.Service> {
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

  const fake = makeFakeProvider({ title: "S3", script: () => textScript("continued answer") })

  const run = Effect.gen(function* () {
    const sessions = yield* Session.Service
    const prompt = yield* SessionPrompt.Service

    const runScenario = (title: string) =>
      Effect.gen(function* () {
        const session = yield* sessions.create({ title })
        const seeded = yield* seedCompactedHistory(session.id, {
          turns: TURNS,
          compactionEvery: COMPACTION_EVERY,
          tailTurns: TAIL_TURNS,
          imageEvery: IMAGE_EVERY,
          summaryDiffBytes: SUMMARY_DIFF_BYTES,
        })
        reset()
        fake.reset()
        const result = yield* prompt.prompt({
          sessionID: session.id,
          agent: "build",
          parts: [{ type: "text", text: PROMPT_TEXT }],
        })
        yield* settle({ activity: fake.activity, timeoutMs: 60_000 })
        const counts = snapshot()
        const book = stepBook()
        const requests = fake.requests.filter((request) => request.purpose !== "auxiliary")
        return {
          counts,
          steps: book.steps,
          perStep: book.perStep,
          requests: fingerprintRequests(requests),
          seededCompactions: seeded.compactions,
          conversationRequests: requests.filter((request) => request.purpose === "conversation").length,
          compactionRequests: requests.filter((request) => request.purpose === "compaction").length,
          finalRole: result.info.role,
        }
      })

    yield* runScenario("S3 warmup")

    const first = yield* runScenario("S3 first")
    const second = yield* runScenario("S3 second")
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
    id: "S3",
    layer: makePerfLayer(fake),
    instance: { git: true, config },
    timeout: 900_000,
    run,
  }
}
