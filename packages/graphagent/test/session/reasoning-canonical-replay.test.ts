import { expect } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Effect, Layer } from "effect"
import { NO_USEFUL_REASONING_TEXT } from "@opencode-ai/core/session/reasoning-distillation"
import { adoptReasoning } from "@/session/reasoning-adoption"
import { MessageV2 } from "@/session/message-v2"
import { Session } from "@/session/session"
import { MessageID, PartID } from "@/session/schema"
import { Storage } from "@/storage/storage"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Goal } from "@/goal/goal"
import { SessionAutomationLease } from "@/session/automation-lease"
import { Dag } from "@/dag/dag"
import { ProviderTest } from "../fake/provider"
import { testInstanceStoreLayer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(
    Session.layer.pipe(
      Layer.provide(Storage.defaultLayer),
      Layer.provide(Database.defaultLayer),
      Layer.provideMerge(EventV2Bridge.defaultLayer),
      Layer.provide(SessionProjector.defaultLayer),
      Layer.provide(RuntimeFlags.layer({ experimentalWorkspaces: false })),
      Layer.provide(BackgroundJob.defaultLayer),
      Layer.provide(Goal.defaultLayer),
      Layer.provide(SessionAutomationLease.defaultLayer),
      Layer.provide(Dag.defaultLayer),
    ),
    Database.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    testInstanceStoreLayer,
  ),
)

const source = "ORIGINAL canonical reasoning with a stable source identity"
const replacement = "DISTILLED canonical reasoning with the same source identity"
const detail = { type: "reasoning.text", text: source, format: "unknown", index: 0 }
const metadata = { openrouter: { reasoning_details: [detail] } }

/** The same complete envelope fixture as the core adoption test; both adoption paths must agree. */
const envelope = [
  "<｜｜DSML｜｜ calls>",
  '<｜｜DSML｜｜ invoke name="bash">',
  '<｜｜DSML｜｜ parameter name="command" string="true">git status --short</｜｜DSML｜｜ parameter>',
  "</｜｜DSML｜｜ invoke>",
  "</｜｜DSML｜｜ calls>",
].join("\n")

for (const output of [replacement, NO_USEFUL_REASONING_TEXT.zh])
  it.instance(
    `replays an adopted persistent reasoning object as one coherent pair (${output === replacement ? "content" : "noise"})`,
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Pinned canonical replay" })
        const providerID = ProviderV2.ID.make("openrouter")
        const modelID = ModelV2.ID.make("stealth/space-bunny-alpha")
        const firstUserID = MessageID.ascending()
        const assistantID = MessageID.ascending()
        const nextUserID = MessageID.ascending()

        const firstUser: SessionV1.User = {
          id: firstUserID,
          sessionID: chat.id,
          role: "user",
          time: { created: 1 },
          agent: "build",
          model: { providerID, modelID },
        }
        const assistant: SessionV1.Assistant = {
          id: assistantID,
          sessionID: chat.id,
          parentID: firstUserID,
          role: "assistant",
          agent: "build",
          modelID,
          providerID,
          mode: "build",
          path: { cwd: chat.directory, root: chat.directory },
          time: { created: 2, completed: 3 },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        }
        const part: SessionV1.ReasoningPart = {
          id: PartID.ascending(),
          sessionID: chat.id,
          messageID: assistantID,
          type: "reasoning",
          text: source,
          metadata,
          time: { start: 2, end: 3 },
        }
        yield* sessions.updateMessage(firstUser)
        yield* sessions.updatePart({
          id: PartID.ascending(),
          sessionID: chat.id,
          messageID: firstUserID,
          type: "text",
          text: "Explain the synthetic ledger",
          time: { start: 1, end: 1 },
        })
        yield* sessions.updateMessage(assistant)
        yield* sessions.updatePart(part)
        yield* sessions.updatePart({
          id: PartID.ascending(),
          sessionID: chat.id,
          messageID: assistantID,
          type: "text",
          text: "Ledger answer",
          time: { start: 3, end: 3 },
        })

        const stored = (yield* sessions.messages({ sessionID: chat.id }))
          .flatMap((message) => message.parts)
          .find((item) => item.id === part.id)
        if (stored?.type !== "reasoning") throw new Error("missing stored reasoning")
        const adopted = yield* adoptReasoning({
          sessionID: chat.id,
          part: stored,
          replacement: { messageID: assistantID, partID: part.id, before: source, after: output },
          canAdopt: Effect.succeed(true),
        })
        expect(adopted?.text).toBe(output)

        yield* sessions.updateMessage({ ...firstUser, id: nextUserID, time: { created: 4 } })
        yield* sessions.updatePart({
          id: PartID.ascending(),
          sessionID: chat.id,
          messageID: nextUserID,
          type: "text",
          text: "Continue the same synthetic ledger",
          time: { start: 4, end: 4 },
        })
        const reloaded = yield* sessions.messages({ sessionID: chat.id })
        expect(reloaded).toHaveLength(3)
        const saved = reloaded.flatMap((message) => message.parts).find((item) => item.id === part.id)
        expect(saved).toMatchObject({
          type: "reasoning",
          text: output,
          metadata: { openrouter: { reasoning_details: [{ ...detail, text: output }] } },
          distillation: { version: 2, originalText: source, originalMetadata: metadata },
        })
        expect(JSON.stringify(reloaded)).not.toContain('"role":"memory"')

        const model = ProviderTest.model({
          id: modelID,
          providerID,
          api: { id: modelID, npm: "@openrouter/ai-sdk-provider", url: "https://openrouter.ai/api/v1" },
        })
        const replay = (enabled: boolean) =>
          MessageV2.toModelMessagesEffect(reloaded, model, { reasoningDistillationEnabled: enabled })
        const reasoning = (messages: Awaited<ReturnType<typeof MessageV2.toModelMessages>>) =>
          messages
            .flatMap((message) =>
              message.role !== "assistant" || !Array.isArray(message.content) ? [] : message.content,
            )
            .filter((content) => content.type === "reasoning")

        const enabled = reasoning(yield* replay(true))
        expect(enabled).toHaveLength(1)
        expect(enabled[0]).toMatchObject({
          text: output,
          providerOptions: { openrouter: { reasoning_details: [{ ...detail, text: output }] } },
        })
        const disabled = reasoning(yield* replay(false))
        expect(disabled).toHaveLength(1)
        expect(disabled[0]).toMatchObject({ text: source, providerOptions: metadata })
        expect((yield* replay(true)).at(-1)).toMatchObject({
          role: "user",
          content: [{ type: "text", text: "Continue the same synthetic ledger" }],
        })
      }),
  )

it.instance("rejects a distilled tool-call envelope and replays the original reasoning", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Rejected DSML adoption" })
    const providerID = ProviderV2.ID.make("openrouter")
    const modelID = ModelV2.ID.make("stealth/space-bunny-alpha")
    const userID = MessageID.ascending()
    const assistantID = MessageID.ascending()
    const user: SessionV1.User = {
      id: userID,
      sessionID: chat.id,
      role: "user",
      time: { created: 1 },
      agent: "build",
      model: { providerID, modelID },
    }
    const assistant: SessionV1.Assistant = {
      id: assistantID,
      sessionID: chat.id,
      parentID: userID,
      role: "assistant",
      agent: "build",
      modelID,
      providerID,
      mode: "build",
      path: { cwd: chat.directory, root: chat.directory },
      time: { created: 2, completed: 3 },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    }
    const part: SessionV1.ReasoningPart = {
      id: PartID.ascending(),
      sessionID: chat.id,
      messageID: assistantID,
      type: "reasoning",
      text: source,
      metadata,
      time: { start: 2, end: 3 },
    }
    yield* sessions.updateMessage(user)
    yield* sessions.updatePart({
      id: PartID.ascending(),
      sessionID: chat.id,
      messageID: userID,
      type: "text",
      text: "Explain the synthetic ledger",
      time: { start: 1, end: 1 },
    })
    yield* sessions.updateMessage(assistant)
    yield* sessions.updatePart(part)
    yield* sessions.updatePart({
      id: PartID.ascending(),
      sessionID: chat.id,
      messageID: assistantID,
      type: "text",
      text: "Ledger answer",
      time: { start: 3, end: 3 },
    })

    const stored = (yield* sessions.messages({ sessionID: chat.id }))
      .flatMap((message) => message.parts)
      .find((item) => item.id === part.id)
    if (stored?.type !== "reasoning") throw new Error("missing stored reasoning")

    const adopted = yield* adoptReasoning({
      sessionID: chat.id,
      part: stored,
      replacement: { messageID: assistantID, partID: part.id, before: source, after: envelope },
      canAdopt: Effect.succeed(true),
    })
    expect(adopted).toBeUndefined()

    const reloaded = yield* sessions.messages({ sessionID: chat.id })
    const saved = reloaded.flatMap((message) => message.parts).find((item) => item.id === part.id)
    expect(saved).toMatchObject({ type: "reasoning", text: source, metadata })
    expect(saved?.type === "reasoning" ? saved.distillation : undefined).toBeUndefined()

    const model = ProviderTest.model({
      id: modelID,
      providerID,
      api: { id: modelID, npm: "@openrouter/ai-sdk-provider", url: "https://openrouter.ai/api/v1" },
    })
    const replay = yield* MessageV2.toModelMessagesEffect(reloaded, model, { reasoningDistillationEnabled: true })
    const reasoning = replay
      .flatMap((message) => (message.role !== "assistant" || !Array.isArray(message.content) ? [] : message.content))
      .filter((content) => content.type === "reasoning")
    expect(reasoning).toHaveLength(1)
    expect(reasoning[0]).toMatchObject({ text: source })
  }),
)
