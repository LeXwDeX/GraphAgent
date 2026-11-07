import { Effect } from "effect"
import path from "node:path"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { makeFakeProvider, textScript, toolCallScript } from "../../lib/fake-provider"
import { reset, settle, snapshot, stepBook, type Counters } from "../../lib/engine-probe"
import type { BaselineRequest } from "../fingerprint"
import { fingerprintRequests } from "../fingerprint"
import { makePerfLayer, perfConfig } from "../harness"
import type { Measurement, Scenario } from "./types"

// S4: a tool-dense turn. Each step is a full provider round-trip through the
// engine: assistant message, tool part, tool result and the next request. The
// agent may make 20 tool calls; `steps` counts assistant requests, and the
// request that reaches the budget runs with tools disabled, so the budget is
// one larger than the number of tool calls.
const STEPS = 20

export interface S4Result extends Measurement {
  /** Request shapes of the last measured pass; the gate mirrors this book. */
  readonly requests: ReadonlyArray<BaselineRequest>
  /** Counters from the first measured pass, for the determinism comparison. */
  readonly firstCounts: Counters
}

export function s4Scenario(): Scenario<S4Result, Session.Service | SessionPrompt.Service> {
  let readPath = ""
  let conversation = 0
  const fake = makeFakeProvider({
    title: "S4",
    script: (input) => {
      const step = conversation
      conversation += 1
      if (step < STEPS)
        return toolCallScript(input, {
          id: `call-read-${step}`,
          name: "read",
          input: { filePath: readPath },
        })
      return textScript("done")
    },
  })

  const config = { ...perfConfig, agent: { build: { steps: STEPS + 1 } } }

  const run = Effect.gen(function* () {
    const sessions = yield* Session.Service
    const prompt = yield* SessionPrompt.Service

    const runScenario = (title: string) =>
      Effect.gen(function* () {
        const session = yield* sessions.create({ title })
        reset()
        fake.reset()
        conversation = 0
        yield* prompt.prompt({
          sessionID: session.id,
          agent: "build",
          parts: [{ type: "text", text: "read the file twenty times" }],
        })
        yield* settle({ activity: fake.activity })
        const counts = snapshot()
        const book = stepBook()
        return { counts, steps: book.steps, perStep: book.perStep, requests: fingerprintRequests(fake.requests) }
      })

    // Warm the shared services; the first turn pays one-time engine setup.
    yield* runScenario("S4 warmup")

    const first = yield* runScenario("S4 first")
    const second = yield* runScenario("S4 second")
    return {
      firstCounts: first.counts,
      counts: second.counts,
      steps: second.steps,
      perStep: second.perStep,
      requests: second.requests,
    }
  })

  return {
    id: "S4",
    layer: makePerfLayer(fake),
    instance: {
      git: true,
      config,
      init: (directory) =>
        Effect.promise(async () => {
          readPath = path.join(directory, "data.txt")
          await Bun.write(readPath, "line one\nline two\n")
        }),
    },
    timeout: 60_000,
    run,
  }
}
