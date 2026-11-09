// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect } from "bun:test"
import { Effect } from "effect"
import { ModelV2 } from "@graphagent/core/model"
import { ProviderV2 } from "@graphagent/core/provider"
import { SessionV1 } from "@graphagent/core/v1/session"
import { Session } from "@/session/session"
import { MessageID } from "@/session/schema"
import { sessionExport } from "@/cli/cmd/export"
import { resetDatabase } from "../../fixture/db"
import { disposeAllInstances } from "../../fixture/fixture"
import { testEffect } from "../../lib/effect"

const it = testEffect(Session.defaultLayer)

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

const model = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") }

const seedUser = (sessionID: SessionV1.User["sessionID"], created: number) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    return yield* sessions.updateMessage({
      id: MessageID.ascending(),
      sessionID,
      role: "user",
      agent: "build",
      model,
      time: { created },
    } satisfies SessionV1.User)
  })

describe("CLI export injects message_diff into message summaries", () => {
  it.instance("exports persisted turn diffs on the user message", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "export-diff" })
      const user = yield* seedUser(session.id, 1)
      const diffs = [{ file: "turn.ts", patch: "@@ -1 +1 @@", additions: 1, deletions: 0, status: "modified" as const }]
      yield* sessions.writeMessageDiff({ sessionID: session.id, messageID: user.id, diff: diffs })

      const exported = yield* sessionExport(session.id)
      const exportedUser = exported.messages.find((msg) => msg.info.id === user.id)
      expect(exportedUser?.info.role).toBe("user")
      if (exportedUser?.info.role !== "user") throw new Error("expected user message")
      expect(exportedUser.info.summary?.diffs).toEqual(diffs)
    }),
  )

  it.instance("leaves a user message without a stored diff unchanged", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "export-no-diff" })
      const user = yield* seedUser(session.id, 1)

      const exported = yield* sessionExport(session.id)
      const exportedUser = exported.messages.find((msg) => msg.info.id === user.id)
      if (exportedUser?.info.role !== "user") throw new Error("expected user message")
      expect(exportedUser.info.summary).toBeUndefined()
    }),
  )

  it.instance("keeps each message's own diff when turns are joined", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "export-joined" })
      const first = yield* seedUser(session.id, 1)
      const assistant = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        sessionID: session.id,
        role: "assistant",
        parentID: first.id,
        time: { created: 2 },
        agent: "build",
        modelID: model.modelID,
        providerID: model.providerID,
        mode: "build",
        path: { cwd: "/tmp", root: "/tmp" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      } satisfies SessionV1.Assistant)
      const second = yield* seedUser(session.id, 3)
      const firstDiff = [{ file: "first.ts", additions: 1, deletions: 0, status: "added" as const }]
      const secondDiff = [{ file: "second.ts", additions: 0, deletions: 1, status: "deleted" as const }]
      yield* sessions.writeMessageDiff({ sessionID: session.id, messageID: first.id, diff: firstDiff })
      yield* sessions.writeMessageDiff({ sessionID: session.id, messageID: second.id, diff: secondDiff })

      const exported = yield* sessionExport(session.id)
      const firstUser = exported.messages.find((msg) => msg.info.id === first.id)
      const secondUser = exported.messages.find((msg) => msg.info.id === second.id)
      const assistantMessage = exported.messages.find((msg) => msg.info.id === assistant.id)
      if (firstUser?.info.role !== "user" || secondUser?.info.role !== "user") throw new Error("expected user messages")
      expect(firstUser.info.summary?.diffs).toEqual(firstDiff)
      expect(secondUser.info.summary?.diffs).toEqual(secondDiff)
      expect(assistantMessage?.info.role).toBe("assistant")
      expect("summary" in (assistantMessage?.info ?? {})).toBe(false)
    }),
  )
})
