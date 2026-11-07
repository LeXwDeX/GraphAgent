import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import type { SessionID } from "@/session/schema"
import { makeFakeProvider } from "../lib/fake-provider"
import { reset, settle, snapshot, type Counters } from "../lib/engine-probe"
import { testEffect } from "../lib/effect"
import { makePerfLayer, perfConfig } from "./harness"

// S1: a single session with 50 messages (25 turns), measured on the next turn.
// The same turn is replayed in a second, independent session; identical inputs
// must produce identical engine counts. This is the determinism check the H1–H6
// baselines rely on.
const TURNS = 25

const fake = makeFakeProvider({ reply: "ok", title: "S1" })
const it = testEffect(makePerfLayer(fake))

const nextTurn = (prompt: SessionPrompt.Interface, sessionID: SessionID, text: string) =>
  prompt.prompt({ sessionID, agent: "build", parts: [{ type: "text", text }] })

const seed = (sessionID: SessionID, turns: number) =>
  Effect.gen(function* () {
    const prompt = yield* SessionPrompt.Service
    for (let turn = 0; turn < turns; turn += 1) yield* nextTurn(prompt, sessionID, `turn ${turn}`)
    yield* settle({ activity: fake.activity })
  })

const measureTurn = (sessionID: SessionID, text: string) =>
  Effect.gen(function* () {
    const prompt = yield* SessionPrompt.Service
    yield* nextTurn(prompt, sessionID, text)
    yield* settle({ activity: fake.activity })
    return snapshot()
  })

const withoutBytes = (counts: Counters) =>
  Object.fromEntries(Object.entries(counts).filter(([key]) => key !== "json.encodeBytes" && key !== "sha256Bytes"))

const createSession = (title: string) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    return yield* sessions.create({ title })
  })

describe("S1 single session", () => {
  it.instance(
    "50 messages then one measured turn is deterministic across sessions",
    () =>
      Effect.gen(function* () {
        const first = yield* createSession("S1 first")
        yield* seed(first.id, TURNS - 1)
        reset()
        fake.reset()
        const firstCounts = yield* measureTurn(first.id, "measured turn")

        // The title fork belongs to turn 1; a measured turn is one request.
        expect(fake.requests).toHaveLength(1)
        expect(fake.requests[0]?.purpose).toBe("conversation")
        expect(firstCounts["events.durable"]).toBeGreaterThan(0)
        expect(firstCounts["sql.write"]).toBeGreaterThan(0)
        expect(firstCounts["sql.read"]).toBeGreaterThan(0)
        expect(firstCounts.commits).toBeGreaterThan(0)

        const second = yield* createSession("S1 second")
        yield* seed(second.id, TURNS - 1)
        reset()
        fake.reset()
        const secondCounts = yield* measureTurn(second.id, "measured turn")

        expect(fake.requests).toHaveLength(1)

        // Payload byte totals include timestamps and event sequence numbers, so
        // they are not bit-identical across runs. Everything else must match
        // exactly; the byte counters only need to stay in the same small band.
        expect(withoutBytes(secondCounts)).toEqual(withoutBytes(firstCounts))
        expect(firstCounts["json.encodeBytes"]).toBeGreaterThan(0)
        expect(Math.abs(secondCounts["json.encodeBytes"] - firstCounts["json.encodeBytes"])).toBeLessThanOrEqual(64)
      }),
    { git: true, config: perfConfig },
    // 24 seeded turns plus two measured turns need more than bun's 5s default;
    // the package test script already raises the timeout, this keeps single-file
    // runs stable too.
    { timeout: 30_000 },
  )
})

// Keep the counter keys referenced so an unused-import check cannot hide a
// renamed or dropped baseline metric.
const metricNames: Array<keyof Counters> = [
  "sql.read",
  "sql.write",
  "commits",
  "json.parseBytes",
  "json.encodeBytes",
  "sha256Bytes",
  "git.spawns",
  "snapshot.lockWaits",
  "events.durable",
  "events.ephemeral",
  "convert.messages",
  "schema.fromSchema",
]
describe("engine counters", () => {
  it.instance("expose every baseline metric", () =>
    Effect.sync(() => {
      const counts = snapshot()
      expect(Object.keys(counts).sort()).toEqual([...metricNames].sort())
    }),
  )
})
