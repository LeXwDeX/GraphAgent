import { describe, expect } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { ModelV2 } from "@graphagent/core/model"
import { ProviderV2 } from "@graphagent/core/provider"
import { AppLayer } from "@/effect/app-runtime"
import { SettingsHook } from "@/hook"
import { __transcriptStats, resetTranscriptStats } from "@/hook/transcript"
import { Session } from "@/session/session"
import { MessageID, PartID, type SessionID } from "@/session/schema"
import { testEffect } from "../lib/effect"

const it = testEffect(AppLayer)

// D1 PR3: planning a trigger whose matcher excludes the call must not touch
// session state. The transcript, prompt identity and scratchpad are all lazy;
// this test pins that no materialization, no message read and no write happens
// even after a long-running agent has accumulated a large session.
const writeHooks = (directory: string) =>
  Effect.promise(async () => {
    await fs.mkdir(path.join(directory, ".agents"), { recursive: true })
    await fs.writeFile(
      path.join(directory, ".agents", "hooks.json"),
      JSON.stringify({
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "true", timeout: 5 }] }],
      }),
    )
  })

const seed = (sessionID: SessionID, count: number) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    for (let i = 0; i < count; i++) {
      const id = MessageID.ascending()
      yield* sessions.updateMessage({
        id,
        sessionID,
        role: "user",
        time: { created: 1000 + i },
        agent: "build",
        model: { providerID: ProviderV2.ID.make("fixture"), modelID: ModelV2.ID.make("fixture") },
      })
      yield* sessions.updatePart({
        id: PartID.ascending(),
        sessionID,
        messageID: id,
        type: "text",
        text: `message ${i}`,
      })
    }
  })

describe("hook planning cost is independent of session size", () => {
  it.instance(
    "a tool call the matcher excludes materializes nothing and reads no messages",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const session = yield* sessions.create({})
        yield* seed(session.id, 2000)
        const hook = yield* SettingsHook.Service
        resetTranscriptStats()
        for (let i = 0; i < 100; i++) {
          const result = yield* hook.trigger(
            { event: "PreToolUse", toolName: "read", toolInput: { filePath: `/tmp/read-${i}.ts` } },
            { sessionID: session.id },
          )
          expect(result.additionalContexts).toEqual([])
        }
        expect(__transcriptStats.materializeCalls).toBe(0)
        expect(__transcriptStats.messagesRead).toBe(0)
        expect(__transcriptStats.writes).toBe(0)
      }),
    { init: writeHooks },
  )
})
