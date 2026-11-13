// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect } from "bun:test"
import { Database } from "@graphagent/core/database/database"
import { LayerNode } from "@graphagent/core/effect/layer-node"
import { CrossSpawnSpawner } from "@graphagent/core/cross-spawn-spawner"
import { SessionProjector } from "@graphagent/core/session/projector"
import { SessionV1 } from "@graphagent/core/v1/session"
import { ModelV2 } from "@graphagent/core/model"
import { ProviderV2 } from "@graphagent/core/provider"
import { Effect, Layer } from "effect"
import { Snapshot } from "@/snapshot"
import { Session as SessionNs } from "@/session/session"
import { SessionSummary } from "@/session/summary"
import { MessageID, PartID, type SessionID } from "@/session/schema"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { reset as resetProbe, snapshot as probeCounters } from "../lib/engine-probe"
import { testEffect } from "../lib/effect"

const diff = {
  calls: [] as Array<{ from: string; to: string }>,
  result: [] as Snapshot.FileDiff[],
}

const snapshotStub = Layer.mock(Snapshot.Service, {
  diffFull: (from: string, to: string) =>
    Effect.sync(() => {
      diff.calls.push({ from, to })
      return diff.result
    }),
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

const seedTurn = Effect.fnUntraced(function* (
  sessionID: SessionID,
  options?: { readonly snapshots?: { readonly from: string; readonly to: string } },
) {
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
  if (options?.snapshots) {
    yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: assistantMessageID,
      sessionID,
      type: "step-start",
      snapshot: options.snapshots.from,
    })
    yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: assistantMessageID,
      sessionID,
      type: "step-finish",
      reason: "stop",
      snapshot: options.snapshots.to,
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    })
  } else {
    yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: assistantMessageID,
      sessionID,
      type: "text",
      text: "no file changes",
    })
  }
  return userMessageID
})

describe("summarizeTurn diff count", () => {
  it.instance(
    "computes one diff per involved user message that has a patch and none for messages without one",
    () =>
      Effect.gen(function* () {
        const sessions = yield* SessionNs.Service
        const summary = yield* SessionSummary.Service
        const session = yield* sessions.create({ title: "summary-counts" })

        const patched = yield* seedTurn(session.id, { snapshots: { from: "patch-start", to: "patch-end" } })
        const patchedAgain = yield* seedTurn(session.id, { snapshots: { from: "patch2-start", to: "patch2-end" } })
        const unchanged = yield* seedTurn(session.id, { snapshots: { from: "same", to: "same" } })
        const plain = yield* seedTurn(session.id)

        diff.calls = []
        diff.result = [
          { file: "patched.txt", patch: "@@ -1 +1 @@", additions: 1, deletions: 1, status: "modified" },
        ]
        // A turn may carry several involved user messages; the summarizer runs
        // one diff computation per message that has a start/end snapshot pair.
        // The unchanged and no-snapshot messages must not invoke git at all.
        yield* summary.summarizeTurn({
          sessionID: session.id,
          userMessageIDs: [patched, unchanged, patchedAgain, plain],
        })

        expect(diff.calls).toEqual([
          { from: "patch-start", to: "patch-end" },
          { from: "patch2-start", to: "patch2-end" },
        ])
        expect((yield* summary.diff({ sessionID: session.id, messageID: patched })).map((item) => item.file)).toEqual([
          "patched.txt",
        ])
        expect(
          (yield* summary.diff({ sessionID: session.id, messageID: patchedAgain })).map((item) => item.file),
        ).toEqual(["patched.txt"])
        expect(yield* summary.diff({ sessionID: session.id, messageID: unchanged })).toEqual([])
        expect(yield* summary.diff({ sessionID: session.id, messageID: plain })).toEqual([])

        // A no-patch turn contributes zero summaries: summarizing it again
        // must not reach diffFull.
        yield* summary.summarizeTurn({ sessionID: session.id, userMessageIDs: [unchanged] })
        expect(diff.calls).toHaveLength(2)
      }),
    { timeout: 30000 },
  )
})

describe("summary hydration", () => {
  it.instance(
    "hydrating messages never parses the stored turn diff",
    () =>
      Effect.gen(function* () {
        const sessions = yield* SessionNs.Service
        const session = yield* sessions.create({ title: "summary-hydrate" })
        const userMessageID = yield* seedTurn(session.id, {
          snapshots: { from: "hydrate-start", to: "hydrate-end" },
        })

        // H5 (#1016): turn diffs live in `message_diff`, not in the message
        // row, so hydrating a turn parses none of the patch payload.
        const patch = "x".repeat(256 * 1024)
        yield* sessions.writeMessageDiff({
          sessionID: session.id,
          messageID: userMessageID,
          diff: [{ file: "big.txt", patch, additions: 1, deletions: 0, status: "modified" }],
        })

        resetProbe()
        const hydrated = yield* sessions.turnMessages({ sessionID: session.id, userMessageID })
        expect(hydrated).toHaveLength(2)
        const diffBytes = Buffer.byteLength(patch)
        expect(probeCounters()["json.parseBytes"]).toBeLessThan(diffBytes / 2)

        // Control: the probe does see the payload when the diff table itself
        // is read, so the bound above is not an artifact of an uninstalled
        // counter.
        resetProbe()
        const read = yield* sessions.readMessageDiff(userMessageID)
        expect(read[0]?.patch).toBe(patch)
        expect(probeCounters()["json.parseBytes"]).toBeGreaterThanOrEqual(diffBytes)
      }),
    { timeout: 30000 },
  )
})