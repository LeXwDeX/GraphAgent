import { describe, expect, test } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Effect, Layer } from "effect"
import { Snapshot } from "@/snapshot"
import { Session as SessionNs, truncateSummaryDiffs, MAX_SUMMARY_DIFF_BYTES } from "@/session/session"
import { SessionSummary } from "@/session/summary"
import { MessageID, PartID, type SessionID } from "@/session/schema"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { pollWithTimeout, testEffect } from "../lib/effect"

const stub = { diffs: [] as Snapshot.FileDiff[] }

const snapshotStub = Layer.mock(Snapshot.Service, {
  diffFull: () => Effect.succeed(stub.diffs),
})

const root = LayerNode.group([
  SessionNs.node,
  SessionProjector.node,
  SessionSummary.node,
  Database.node,
  CrossSpawnSpawner.node,
])

const it = testEffect(
  LayerNode.buildLayer(root, {
    replacements: [
      LayerNode.replace(Snapshot.node, snapshotStub),
      LayerNode.replace(RuntimeFlags.node, RuntimeFlags.layer({ experimentalWorkspaces: false })),
    ],
  }),
)

const giantDiffs = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    file: `f${String(i).padStart(3, "0")}.txt`,
    patch: "x".repeat(2048),
    additions: 10,
    deletions: 2,
    status: "modified" as const,
  }))

const seedUserTurn = Effect.fnUntraced(function* (sessionID: SessionID) {
  const sessions = yield* SessionNs.Service
  const userMessageID = MessageID.ascending()
  yield* sessions.updateMessage({
    id: userMessageID,
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "user",
    model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
  } satisfies SessionV1.User)
  const assistantMessageID = MessageID.ascending()
  yield* sessions.updateMessage({
    id: assistantMessageID,
    sessionID,
    role: "assistant",
    parentID: userMessageID,
    time: { created: Date.now() },
    agent: "build",
    modelID: ModelV2.ID.make("test"),
    providerID: ProviderV2.ID.make("test"),
    mode: "build",
    path: { cwd: sessionID, root: sessionID },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  } satisfies SessionV1.Assistant)
  yield* sessions.updatePart({
    id: PartID.ascending(),
    messageID: assistantMessageID,
    sessionID,
    type: "step-start",
    snapshot: "from",
  })
  yield* sessions.updatePart({
    id: PartID.ascending(),
    messageID: assistantMessageID,
    sessionID,
    type: "step-finish",
    reason: "stop",
    snapshot: "to",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  })
  return userMessageID
})

describe("summary.diffs source truncation", () => {
  it.instance(
    "summarize truncates oversized diffs to the byte budget and keeps the leading files",
    () =>
      Effect.gen(function* () {
        const sessions = yield* SessionNs.Service
        const summary = yield* SessionSummary.Service
        const session = yield* sessions.create({ title: "giant-summary" })
        const userMessageID = yield* seedUserTurn(session.id)

        stub.diffs = giantDiffs(300)
        yield* summary.summarize({ sessionID: session.id, messageID: userMessageID })

        const diffs = yield* pollWithTimeout(
          Effect.gen(function* () {
            const list = yield* summary.diff({ sessionID: session.id, messageID: userMessageID })
            return list.length > 0 ? list : undefined
          }),
          "summarized diffs never persisted",
        )

        expect(diffs.length).toBeLessThan(300)
        expect(Buffer.byteLength(JSON.stringify(diffs))).toBeLessThanOrEqual(SessionNs.MAX_SUMMARY_DIFF_BYTES)
        expect(diffs[0]?.file).toBe("f000.txt")
        expect(diffs.at(-1)?.file).toBe(`f${String(diffs.length - 1).padStart(3, "0")}.txt`)
      }),
    { timeout: 30000 },
  )
})

describe("truncateSummaryDiffs boundaries", () => {
  const item = {
    file: "a.txt",
    patch: "x".repeat(1024),
    additions: 1,
    deletions: 1,
    status: "modified" as const,
  }

  test("keeps an empty array as empty", () => {
    expect(truncateSummaryDiffs([])).toEqual([])
    expect(truncateSummaryDiffs(undefined)).toBeUndefined()
  })

  test("returns an empty array when a single entry exceeds the budget, without throwing", () => {
    const huge = [{ ...item, patch: "x".repeat(MAX_SUMMARY_DIFF_BYTES) }]
    expect(truncateSummaryDiffs(huge)).toEqual([])
  })

  test("fills the budget exactly to the largest complete entry count", () => {
    const size = Buffer.byteLength(JSON.stringify(item))
    const count = Math.floor((MAX_SUMMARY_DIFF_BYTES - 1) / (size + 1))
    const kept = truncateSummaryDiffs(Array.from({ length: count + 5 }, () => item))
    expect(kept?.length).toBe(count)
    expect(Buffer.byteLength(JSON.stringify(kept))).toBeLessThanOrEqual(MAX_SUMMARY_DIFF_BYTES)
  })

  test("skips an oversized entry and keeps later entries that still fit", () => {
    const huge = { ...item, file: "huge.txt", patch: "x".repeat(MAX_SUMMARY_DIFF_BYTES) }
    const smallA = { ...item, file: "small-a.txt", patch: "y".repeat(64) }
    const smallB = { ...item, file: "small-b.txt", patch: "z".repeat(64) }
    const kept = truncateSummaryDiffs([huge, smallA, smallB])
    expect(kept).toEqual([smallA, smallB])
    expect(Buffer.byteLength(JSON.stringify(kept))).toBeLessThanOrEqual(MAX_SUMMARY_DIFF_BYTES)
  })

  test("keeps serialized output within the budget for mixed oversized inputs", () => {
    const huge = { ...item, patch: "x".repeat(MAX_SUMMARY_DIFF_BYTES) }
    const nearBudget = { ...item, patch: "x".repeat(MAX_SUMMARY_DIFF_BYTES - 120) }
    const shapes = [
      [huge, item, item],
      [item, huge, item],
      [item, item, huge],
      [nearBudget, item, nearBudget, item],
      [huge, nearBudget, huge, item],
      [nearBudget, nearBudget],
      [item, nearBudget, item, huge, item],
    ]
    shapes.forEach((shape) => {
      const kept = truncateSummaryDiffs(shape)
      expect(Buffer.byteLength(JSON.stringify(kept))).toBeLessThanOrEqual(MAX_SUMMARY_DIFF_BYTES)
    })
  })
})
