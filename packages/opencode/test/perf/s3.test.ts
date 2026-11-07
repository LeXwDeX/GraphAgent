import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { makeFakeProvider, textScript } from "../lib/fake-provider"
import { reset, settle, snapshot, type Counters } from "../lib/engine-probe"
import { testEffect } from "../lib/effect"
import { makePerfLayer, perfConfig } from "./harness"
import { seedCompactedHistory } from "./seed"

// S3: a cold start on a long, heavily compacted session. The table holds 5000
// messages and ten completed compaction boundaries; the final boundary's tail
// marker points near the end, so the reconstructed visible history is only the
// retained tail. The measured turn is a plain conversation request: it must
// read the visible history, carry the media parts (images on user messages,
// one 256KiB summary diff), and trigger no compaction.
//
// This is the H4 baseline shape: `sql.read` records what the current
// full-table read costs, and `convert.messages` records what the reconstructed
// history contains. A later tail-bounded read is expected to lower the former
// without changing the latter.
const MESSAGES = 5_000
const TURNS = MESSAGES / 2
const COMPACTION_EVERY = 250
const TAIL_TURNS = 50
const IMAGE_EVERY = 5
const SUMMARY_DIFF_BYTES = 256 * 1_024

const context = 10_000
const baseModel = perfConfig.provider.test.models["test-model"]
const config = {
  ...perfConfig,
  compaction: { auto: true },
  provider: {
    ...perfConfig.provider,
    test: {
      ...perfConfig.provider.test,
      models: {
        "test-model": { ...baseModel, limit: { context, output: 1_000 } },
      },
    },
  },
}

const fake = makeFakeProvider({ title: "S3", script: () => textScript("continued answer") })
const it = testEffect(makePerfLayer(fake))

const withoutBytes = (counts: Counters) =>
  Object.fromEntries(Object.entries(counts).filter(([key]) => key !== "json.encodeBytes" && key !== "sha256Bytes"))

describe("S3 cold start on a compacted long session", () => {
  it.instance(
    "5000 messages with ten compactions read only the retained tail",
    () =>
      Effect.gen(function* () {
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
              parts: [{ type: "text", text: "continue the task" }],
            })
            yield* settle({ activity: fake.activity, timeoutMs: 60_000 })
            const counts = snapshot()
            const requests = fake.requests.filter((request) => request.purpose !== "auxiliary")
            return {
              counts,
              seededCompactions: seeded.compactions,
              conversationRequests: requests.filter((request) => request.purpose === "conversation").length,
              compactionRequests: requests.filter((request) => request.purpose === "compaction").length,
              finalRole: result.info.role,
            }
          })

        yield* runScenario("S3 warmup")

        const first = yield* runScenario("S3 first")
        expect(first.seededCompactions).toBe(TURNS / COMPACTION_EVERY)
        expect(first.conversationRequests).toBe(1)
        expect(first.compactionRequests).toBe(0)
        expect(first.finalRole).toBe("assistant")
        // The visible history is the retained tail plus the final compaction
        // pair and the measured prompt. Everything before the tail marker stays
        // in the table but must not reach the model.
        expect(first.counts["convert.messages"]).toBeGreaterThan(TAIL_TURNS * 2)
        expect(first.counts["convert.messages"]).toBeLessThan(MESSAGES / 2)
        // The current cold start pages through the whole table (the read is
        // statement-counted, not row-counted); the baseline records that cost
        // for H4's tail-bounded read, which must lower it substantially.
        expect(first.counts["sql.read"]).toBeGreaterThan(TAIL_TURNS)
        expect(first.counts["sql.read"]).toBeLessThan(MESSAGES)
        expect(first.counts["json.parseBytes"]).toBeGreaterThan(SUMMARY_DIFF_BYTES)
        expect(first.counts["events.durable"]).toBeGreaterThan(0)
        expect(first.counts["sql.write"]).toBeGreaterThan(0)

        const second = yield* runScenario("S3 second")
        expect(second.seededCompactions).toBe(TURNS / COMPACTION_EVERY)
        expect(withoutBytes(second.counts)).toEqual(withoutBytes(first.counts))
        expect(Math.abs(second.counts["json.encodeBytes"] - first.counts["json.encodeBytes"])).toBeLessThanOrEqual(64)
      }),
    { git: true, config },
    { timeout: 900_000 },
  )
})