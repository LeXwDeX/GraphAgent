// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { Effect } from "effect"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import type { SessionID } from "@/session/schema"
import { makeFakeProvider } from "../../lib/fake-provider"
import { reset, settle, snapshot, stepBook, type Counters } from "../../lib/engine-probe"
import type { BaselineRequest } from "../fingerprint"
import { fingerprintRequests } from "../fingerprint"
import { makePerfLayer, perfConfig } from "../harness"
import type { Measurement, Scenario } from "./types"

// S1: a single session with 50 messages (25 turns), measured on the next turn.
// The same turn is replayed in a second, independent session; identical inputs
// must produce identical engine counts. This is the determinism check the H1–H6
// baselines rely on.
const TURNS = 25

const nextTurn = (prompt: SessionPrompt.Interface, sessionID: SessionID, text: string) =>
  prompt.prompt({ sessionID, agent: "build", parts: [{ type: "text", text }] })

export interface S1Result extends Measurement {
  /** Request shapes issued by the last measured turn. */
  readonly requests: ReadonlyArray<BaselineRequest>
  readonly firstCounts: Counters
  readonly firstRequests: number
}

export function s1Scenario(): Scenario<S1Result, Session.Service | SessionPrompt.Service> {
  const fake = makeFakeProvider({ reply: "ok", title: "S1" })
  const run = Effect.gen(function* () {
    const sessions = yield* Session.Service
    const prompt = yield* SessionPrompt.Service

    const seed = (sessionID: SessionID) =>
      Effect.gen(function* () {
        for (let turn = 0; turn < TURNS - 1; turn += 1) yield* nextTurn(prompt, sessionID, `turn ${turn}`)
        yield* settle({ activity: fake.activity })
      })

    const first = yield* sessions.create({ title: "S1 first" })
    yield* seed(first.id)
    reset()
    fake.reset()
    yield* nextTurn(prompt, first.id, "measured turn")
    yield* settle({ activity: fake.activity })
    const firstCounts = snapshot()
    const firstRequests = fake.requests.length

    const second = yield* sessions.create({ title: "S1 second" })
    yield* seed(second.id)
    reset()
    fake.reset()
    yield* nextTurn(prompt, second.id, "measured turn")
    yield* settle({ activity: fake.activity })
    const counts = snapshot()
    const book = stepBook()
    return {
      counts,
      steps: book.steps,
      perStep: book.perStep,
      requests: fingerprintRequests(fake.requests),
      firstCounts,
      firstRequests,
    }
  })
  return {
    id: "S1",
    layer: makePerfLayer(fake),
    instance: { git: true, config: perfConfig },
    // 24 seeded turns plus two measured turns need more than bun's 5s default.
    timeout: 30_000,
    run,
  }
}
