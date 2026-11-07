import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { makeFakeProvider, textScript } from "../lib/fake-provider"
import { reset, settle, snapshot, type Counters } from "../lib/engine-probe"
import { testEffect } from "../lib/effect"
import { makePerfLayer, perfConfig } from "./harness"
import { seedHistory } from "./seed"

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

const it = testEffect(makePerfLayer(fake))

const withoutBytes = (counts: Counters) =>
  Object.fromEntries(Object.entries(counts).filter(([key]) => key !== "json.encodeBytes" && key !== "sha256Bytes"))

describe("S2 session with two compactions", () => {
  it.instance(
    "500 messages and two automatic compactions are deterministic",
    () =>
      Effect.gen(function* () {
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
            const requests = fake.requests.filter((request) => request.purpose !== "auxiliary")
            const messages = yield* sessions.messages({ sessionID: session.id })
            return {
              counts,
              compactions: compactions,
              compactionRequests: requests.filter((request) => request.purpose === "compaction").length,
              conversationRequests: requests.filter((request) => request.purpose === "conversation").length,
              compactionMessages: messages.filter((message) => message.parts.some((part) => part.type === "compaction"))
                .length,
              finalRole: result.info.role,
            }
          })

        yield* runScenario("S2 warmup")

        const first = yield* runScenario("S2 first")
        expect(first.compactionRequests).toBe(2)
        expect(first.conversationRequests).toBe(1)
        expect(first.compactionMessages).toBe(2)
        expect(first.finalRole).toBe("assistant")
        expect(first.counts["events.durable"]).toBeGreaterThan(0)
        expect(first.counts["sql.write"]).toBeGreaterThan(0)
        expect(first.counts["convert.messages"]).toBeGreaterThan(MESSAGES)
        expect(first.counts["json.parseBytes"]).toBeGreaterThan(0)

        const second = yield* runScenario("S2 second")
        expect(second.compactionRequests).toBe(2)
        expect(second.conversationRequests).toBe(1)
        expect(second.compactionMessages).toBe(2)
        expect(withoutBytes(second.counts)).toEqual(withoutBytes(first.counts))
        expect(Math.abs(second.counts["json.encodeBytes"] - first.counts["json.encodeBytes"])).toBeLessThanOrEqual(64)
      }),
    { git: true, config },
    { timeout: 180_000 },
  )
})
