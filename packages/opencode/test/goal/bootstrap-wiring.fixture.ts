import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { NodeFileSystem } from "@effect/platform-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { Goal } from "@/goal/goal"
import { SessionStatus } from "@/session/status"
import { MessageID, SessionID } from "@/session/schema"
import { GoalTool } from "@/tool/goal"
import { InstanceStore } from "@/project/instance-store"
import { provideTmpdirInstance } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(CrossSpawnSpawner.defaultLayer, NodeFileSystem.layer))

// GOAL-BOOT-WIRING probe: boots the instance through the PRODUCTION path
// (AppRuntime → InstanceStore.provide → InstanceBootstrap.run, which is the
// only place that serviceOption-resolves and inits GoalLoop). Every other
// test/goal suite builds GoalLoop.layer directly and therefore never
// exercises this wiring. Pipeline under test, no judge involved:
//   boot instance → set goal → publish session idle →
//   afterIdle must reach the no-lastAssistant branch and PAUSE the goal.
// If the serviceOption wiring, subscription, ownership gate, lease claim,
// or event delivery is broken, the goal stays "active" and this test goes red.
describe("GoalLoop production wiring — idle must drive afterIdle", () => {
  it.live(
    "an idle session with an active goal leaves the active state",
    () =>
      provideTmpdirInstance((path) =>
        Effect.promise(async () => {
          const { AppRuntime } = await import("@/effect/app-runtime")
          await AppRuntime.runPromise(
            Effect.gen(function* () {
              const store = yield* InstanceStore.Service
              yield* store.provide(
                { directory: path },
                Effect.gen(function* () {
                  // Instance booted via production bootstrap — GoalLoop.init
                  // must already have run here; do NOT call it again.
                  const goal = yield* Goal.Service
                  const status = yield* SessionStatus.Service

                  const sid = SessionID.descending()
                  yield* goal.set(sid, "wiring probe", 5)

                  // Session starts busy; flip to idle — this is the exact event
                  // the production Runner emits after a turn ends.
                  yield* status.set(sid, { type: "busy" })
                  yield* status.set(sid, { type: "idle" })

                  // No assistant message exists → the healthy pipeline pauses
                  // the goal with the "近期消息中无 assistant 回复" reason. A
                  // stalled pipeline leaves it active.
                  const final = yield* pollWithTimeout(
                    Effect.gen(function* () {
                      const state = yield* goal.load(sid)
                      if (state && state.status !== "active") return state
                      return undefined
                    }),
                    "goal never left active after idle — GoalLoop pipeline not armed on the production wiring",
                    "8 seconds",
                  )
                  expect(final.status).toBe("paused")
                }),
              )
            }),
          )
        }),
      ),
    20_000,
  )
})

it.live(
  "production AppLayer dispatches Goal controls without invoking the model",
  () =>
    provideTmpdirInstance((directory) =>
      Effect.promise(async () => {
        await Bun.write(
          `${directory}/opencode.json`,
          JSON.stringify({
            model: "test/test-model",
            formatter: false,
            lsp: false,
            provider: {
              test: {
                npm: "@ai-sdk/openai-compatible",
                models: { "test-model": { name: "Test Model" } },
                options: { apiKey: "test", baseURL: "http://127.0.0.1:1/v1" },
              },
            },
          }),
        )
        const { AppRuntime } = await import("@/effect/app-runtime")
        await AppRuntime.runPromise(
          Effect.gen(function* () {
            const store = yield* InstanceStore.Service
            yield* store.provide(
              { directory },
              Effect.gen(function* () {
                const session = yield* (yield* Session.Service).create({ title: "Goal wiring" })
                const goal = yield* Goal.Service
                yield* goal.set(session.id, "production Goal wiring", 7)
                yield* goal.pause(session.id, "smoke test")
                const result = yield* (yield* SessionPrompt.Service).command({
                  sessionID: session.id,
                  command: "goal",
                  arguments: "status",
                })
                const text = result.parts
                  .filter((part) => part.type === "text")
                  .map((part) => part.text)
                  .join("\n")
                expect(text).toContain("production Goal wiring")
                expect(text).toContain("0/7")
                expect((yield* goal.load(session.id))?.status).toBe("paused")
                yield* goal.clear(session.id)

                const child = yield* (yield* Session.Service).create({
                  parentID: session.id,
                  title: "Goal child guard",
                })
                const rejected = yield* goal.controlDuringTurn(child.id, { action: "create", text: "unowned loop" })
                expect(rejected.changed).toBe(false)
                expect(yield* goal.load(child.id)).toBeUndefined()
                yield* goal.set(child.id, "legacy child goal", 4)
                const pause = yield* goal.controlDuringTurn(child.id, { action: "pause", reason: "return to parent" })
                expect(pause.changed).toBe(true)
                const pausedChild = yield* goal.load(child.id)
                expect((yield* goal.controlDuringTurn(child.id, { action: "resume" })).changed).toBe(false)
                expect(yield* goal.load(child.id)).toEqual(pausedChild)
                yield* goal.clear(child.id)
                const create = yield* goal.controlDuringTurn(session.id, { action: "create", text: "main goal" })
                expect(create.changed).toBe(true)
                const parentGoal = yield* goal.load(session.id)
                const tool = yield* (yield* GoalTool).init()
                const childContext = {
                  sessionID: child.id,
                  messageID: MessageID.ascending(),
                  agent: "build",
                  abort: AbortSignal.any([]),
                  messages: [],
                  metadata: () => Effect.void,
                  ask: () => Effect.void,
                }
                const childStatus = yield* tool.execute({ action: "status" }, childContext)
                expect(childStatus.output).toContain("No autonomous goal")
                expect(childStatus.output).not.toContain("main goal")
                const childPause = yield* tool.execute(
                  { action: "pause", reason: "needs parent decision" },
                  childContext,
                )
                expect(childPause.output).toContain("Cannot pause")
                const childComplete = yield* tool.execute(
                  { action: "complete", reason: "child work delivered" },
                  childContext,
                )
                expect(childComplete.output).toContain("Cannot complete")
                expect(yield* goal.load(session.id)).toEqual(parentGoal)
                expect(yield* goal.load(child.id)).toBeUndefined()
                yield* goal.clear(session.id)
              }),
            )
          }),
        )
      }),
    ),
  20_000,
)
