import { describe, expect } from "bun:test"
import { Effect } from "effect"
import path from "node:path"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { makeFakeProvider, textScript, toolCallScript } from "../lib/fake-provider"
import { reset, settle, snapshot, type Counters } from "../lib/engine-probe"
import { testEffect } from "../lib/effect"
import { makePerfLayer, perfConfig } from "./harness"

// S4: a tool-dense turn. Each step is a full provider round-trip through the
// engine: assistant message, tool part, tool result and the next request. The
// agent may make 20 tool calls; `steps` counts assistant requests, and the
// request that reaches the budget runs with tools disabled, so the budget is
// one larger than the number of tool calls.
const STEPS = 20

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
const it = testEffect(makePerfLayer(fake))

// The session engine's idempotency gate (#523) drops a durable append whose
// type and payload hash repeat the aggregate's latest event. Repeated tool
// part updates that reach the publish path within the same millisecond carry
// identical payloads, so how many appends the gate drops depends on real time.
// Each drop removes exactly three reads and three writes, and the gate is the
// only source of variance in this scenario; every other counter must match.
const VOLATILE = new Set(["json.encodeBytes", "sha256Bytes", "sql.read", "sql.write"])
const withoutVolatile = (counts: Counters) =>
  Object.fromEntries(Object.entries(counts).filter(([key]) => !VOLATILE.has(key)))

describe("S4 tool-dense turn", () => {
  it.instance(
    "twenty tool steps then a tools-disabled final step are deterministic",
    () =>
      Effect.gen(function* () {
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
            return snapshot()
          })

        // Warm the shared services; the first turn pays one-time setup.
        yield* runScenario("S4 warmup")

        const first = yield* runScenario("S4 first")
        const requests = fake.requests.filter((request) => request.purpose === "conversation")
        expect(requests).toHaveLength(STEPS + 1)
        // The first twenty requests advertise the tool set and allow calls; the
        // final request runs after the step budget is spent, so the engine
        // disables tools and the model can only answer with text.
        expect(requests.slice(0, -1).every((request) => request.toolChoice === "auto")).toBe(true)
        expect(new Set(requests.slice(0, -1).map((request) => request.toolsHash)).size).toBe(1)
        expect(requests.at(-1)!.toolChoice).toBe("none")
        expect(requests.at(-1)!.toolsHash).not.toBe(requests[0].toolsHash)
        expect(first["events.durable"]).toBeGreaterThan(0)
        expect(first["sql.write"]).toBeGreaterThan(0)

        const second = yield* runScenario("S4 second")
        // Payload byte totals carry timestamps and sequence numbers; the
        // remaining counters must match exactly, the same rule as S1/S6.
        expect(withoutVolatile(second)).toEqual(withoutVolatile(first))
        expect(Math.abs(second["json.encodeBytes"] - first["json.encodeBytes"])).toBeLessThanOrEqual(64)

        // Dedup drops are the only tolerated SQL difference: both counters
        // move by the same amount, a multiple of the three-statement append
        // unit, and never by more than ten dropped appends.
        const readDelta = second["sql.read"] - first["sql.read"]
        const writeDelta = second["sql.write"] - first["sql.write"]
        expect(readDelta).toBe(writeDelta)
        // `%` yields -0 for negative multiples; compare the boolean instead.
        expect(readDelta % 3 === 0).toBe(true)
        expect(Math.abs(readDelta)).toBeLessThanOrEqual(30)
      }),
    {
      git: true,
      config,
      init: (directory) =>
        Effect.promise(async () => {
          readPath = path.join(directory, "data.txt")
          await Bun.write(readPath, "line one\nline two\n")
        }),
    },
    { timeout: 60_000 },
  )
})
