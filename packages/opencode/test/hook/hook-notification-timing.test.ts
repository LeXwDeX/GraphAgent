import { DagStore } from "@opencode-ai/core/dag/store"
import { LegacyEvent } from "@opencode-ai/schema/legacy-event"
import { decodeRecord, decodeString } from "../lib/hook-json"
import { Question } from "@/question"
import { handleElicitation } from "@/mcp/elicitation"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { expect } from "bun:test"
import { Effect, Fiber, Layer } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { SessionAttention } from "@/notification/attention"
import { Notification, type NotifyInput } from "@/notification"
import { Permission } from "@/permission"
import type { Session as SessionNamespace } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionID } from "@/session/schema"
import { testEffect } from "../lib/effect"
import { provideTmpdirInstance } from "../fixture/fixture"

const recorded: NotifyInput[] = []
let activeWorkflow = false
const notification = Layer.succeed(
  Notification.Service,
  Notification.Service.of({
    notify: (input) =>
      Effect.sync(() => {
        recorded.push(input)
      }),
  }),
)
const childID = SessionID.make("ses_notification_timing_child")
// Only the child id resolves to a persisted child session; every other id is a top-level or unknown session.
// Loaded lazily: importing the session module at top level closes a module-initialization cycle.
const sessions = Layer.unwrap(
  Effect.promise(async () => {
    const { Session } = await import("@/session/session")
    const { NotFoundError } = await import("@/storage/storage")
    return Layer.mock(Session.Service, {
      get: (sessionID: SessionID) =>
        sessionID === childID
          ? // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
            Effect.succeed({ id: childID, parentID: id } as unknown as SessionNamespace.Info)
          : Effect.fail(new NotFoundError({ message: "Session not found" })),
    })
  }),
)
const layer = Layer.mergeAll(Permission.layer, SessionStatus.layer, Question.layer).pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      EventV2Bridge.defaultLayer,
      notification,
      sessions,
      BackgroundJob.defaultLayer,
      SessionAttention.layer,
      Layer.mock(DagStore.Service, {
        listBySession: () =>
          Effect.succeed<DagStore.WorkflowRow[]>(
            activeWorkflow
              ? [
                  {
                    id: "workflow",
                    status: "running",
                    title: "Synthetic workflow",
                    projectId: "project",
                    sessionId: id,
                    directory: null,
                    config: "{}",
                    seq: 0,
                    wakeReported: false,
                    graphRev: 0,
                    startedAt: null,
                    completedAt: null,
                    timeCreated: 0,
                    timeUpdated: 0,
                  },
                ]
              : [],
          ),
      }),
    ),
  ),
)
const it = testEffect(layer.pipe(Layer.provideMerge(CrossSpawnSpawner.defaultLayer)))
const id = SessionID.make("ses_notification_timing")
const permissionAsk = Effect.gen(function* () {
  const permission = yield* Permission.Service
  return yield* permission.ask({
    sessionID: id,
    permission: "bash",
    patterns: ["fixture"],
    always: [],
    metadata: {},
    ruleset: [],
  })
})
const drain = Effect.gen(function* () {
  for (let i = 0; i < 15; i++) yield* Effect.yieldNow
})

it.effect(
  "permission notifies after six seconds, terminal typing defers, and reply/cancel clear timers",
  provideTmpdirInstance(() =>
    Effect.gen(function* () {
      recorded.length = 0
      const permission = yield* Permission.Service
      const attention = yield* SessionAttention.Service
      const pending = yield* permissionAsk.pipe(Effect.forkScoped)
      yield* drain
      expect(yield* permission.list()).toHaveLength(1)
      yield* TestClock.adjust("5 seconds")
      expect(recorded).toHaveLength(0)
      yield* attention.update(id, { clientID: "terminal", clientType: "terminal", activity: 1 })
      yield* drain
      yield* TestClock.adjust("5 seconds")
      expect(recorded).toHaveLength(0)
      yield* TestClock.adjust("1 second")
      yield* drain
      expect(recorded.map((item) => item.notificationType)).toEqual(["permission_prompt"])
      yield* permission.reply({ requestID: (yield* permission.list())[0].id, reply: "once" })
      yield* Fiber.join(pending)
      recorded.length = 0
      const second = yield* permissionAsk.pipe(Effect.forkScoped)
      yield* drain
      yield* permission.reply({ requestID: (yield* permission.list())[0].id, reply: "once" })
      yield* Fiber.join(second)
      const cancelled = yield* permissionAsk.pipe(Effect.forkScoped)
      yield* drain
      yield* Fiber.interrupt(cancelled)
      yield* TestClock.adjust("10 seconds")
      expect(recorded).toHaveLength(0)
      expect(yield* permission.list()).toHaveLength(0)
    }),
  ),
)

it.effect(
  "web activity keeps SDK permission timing while view leases are terminal-only and expire",
  provideTmpdirInstance(() =>
    Effect.gen(function* () {
      const attention = yield* SessionAttention.Service
      let fired = false
      const timer = yield* attention.quiet(id, 6000).pipe(
        Effect.andThen(
          Effect.sync(() => {
            fired = true
          }),
        ),
        Effect.forkScoped,
      )
      yield* drain
      yield* TestClock.adjust("5 seconds")
      yield* attention.update(id, { clientID: "web", clientType: "web", activity: 1, backgroundView: true })
      expect(yield* attention.viewing(id)).toBe(false)
      yield* TestClock.adjust("1 second")
      yield* Fiber.join(timer)
      expect(fired).toBe(true)
      yield* attention.update(id, { clientID: "terminal", clientType: "terminal", backgroundView: true })
      expect(yield* attention.viewing(id)).toBe(true)
      yield* attention.update(id, { clientID: "terminal", clientType: "terminal", backgroundView: false })
      expect(yield* attention.viewing(id)).toBe(false)
      yield* attention.update(id, { clientID: "terminal", clientType: "terminal", backgroundView: true })
      yield* TestClock.adjust("30 seconds")
      expect(yield* attention.viewing(id)).toBe(false)
      yield* attention.update(id, { clientID: "terminal", clientType: "terminal", backgroundView: true })
      yield* attention.update(id, { clientID: "terminal", closed: true })
      yield* attention.update(id, { clientID: "terminal", clientType: "terminal", backgroundView: true })
      expect(yield* attention.viewing(id)).toBe(false)
    }),
  ),
)

it.effect(
  "actual busy-to-idle notifies once; typing, new busy, cleanup and background work cancel",
  provideTmpdirInstance(() =>
    Effect.gen(function* () {
      recorded.length = 0
      const status = yield* SessionStatus.Service
      const attention = yield* SessionAttention.Service
      const jobs = yield* BackgroundJob.Service
      yield* status.set(id, { type: "busy" })
      yield* status.set(id, { type: "idle" })
      yield* drain
      yield* TestClock.adjust("59 seconds")
      expect(recorded).toHaveLength(0)
      yield* TestClock.adjust("1 second")
      yield* drain
      expect(recorded.map((item) => item.notificationType)).toEqual(["idle_prompt"])
      yield* status.set(id, { type: "idle" })
      yield* TestClock.adjust("60 seconds")
      expect(recorded).toHaveLength(1)
      recorded.length = 0
      for (const cancel of [
        attention.input(id),
        attention.update(id, { clientID: "web", clientType: "web", activity: 2 }),
        status.set(id, { type: "busy" }),
        status.clear?.(id) ?? Effect.void,
      ]) {
        yield* status.set(id, { type: "busy" })
        yield* status.set(id, { type: "idle" })
        yield* drain
        yield* cancel
        yield* drain
        yield* TestClock.adjust("60 seconds")
      }
      const job = yield* jobs.start({ type: "task", metadata: { parentSessionId: id }, run: Effect.never })
      yield* status.set(id, { type: "busy" })
      yield* status.set(id, { type: "idle" })
      yield* drain
      yield* TestClock.adjust("60 seconds")
      expect(recorded).toHaveLength(0)
      yield* jobs.cancel(job.id)
      activeWorkflow = true
      yield* status.set(id, { type: "busy" })
      yield* status.set(id, { type: "idle" })
      yield* drain
      yield* TestClock.adjust("60 seconds")
      expect(recorded).toHaveLength(0)
      activeWorkflow = false
    }),
  ),
)

it.effect(
  "a child session going busy to idle never asks the user for a prompt, while its parent still does",
  provideTmpdirInstance(() =>
    Effect.gen(function* () {
      recorded.length = 0
      const status = yield* SessionStatus.Service
      const attention = yield* SessionAttention.Service
      yield* status.set(childID, { type: "busy" })
      yield* status.set(childID, { type: "idle" })
      yield* drain
      yield* TestClock.adjust("120 seconds")
      yield* drain
      expect(recorded).toHaveLength(0)
      yield* status.set(id, { type: "busy" })
      yield* status.set(id, { type: "idle" })
      yield* drain
      // Parent attention input still cancels the timer.
      yield* attention.input(id)
      yield* drain
      yield* TestClock.adjust("120 seconds")
      expect(recorded).toHaveLength(0)
      yield* status.set(id, { type: "busy" })
      yield* status.set(id, { type: "idle" })
      yield* drain
      yield* TestClock.adjust("60 seconds")
      yield* drain
      expect(recorded.map((item) => item.notificationType)).toEqual(["idle_prompt"])
    }),
  ),
)

it.effect(
  "actual MCP form is visible before its six-second notification and answers/cancel clear timers",
  provideTmpdirInstance(() =>
    Effect.gen(function* () {
      recorded.length = 0
      const question = yield* Question.Service
      const ask = () =>
        handleElicitation({
          sessionID: id,
          message: "Synthetic form",
          requestedSchema: { type: "object", properties: { answer: { type: "boolean" } } },
        })
      const pending = yield* ask().pipe(Effect.forkScoped)
      yield* drain
      expect(yield* question.list()).toHaveLength(1)
      expect(recorded).toHaveLength(0)
      yield* TestClock.adjust("6 seconds")
      yield* drain
      expect(recorded.map((item) => item.notificationType)).toEqual(["elicitation_dialog"])
      yield* question.reply({ requestID: (yield* question.list())[0].id, answers: [["Yes"]] })
      expect(yield* Fiber.join(pending)).toEqual({ action: "accept", content: { answer: true } })
      recorded.length = 0
      const answered = yield* ask().pipe(Effect.forkScoped)
      yield* drain
      yield* question.reply({ requestID: (yield* question.list())[0].id, answers: [["No"]] })
      yield* Fiber.join(answered)
      const cancelled = yield* ask().pipe(Effect.forkScoped)
      yield* drain
      yield* Fiber.interrupt(cancelled)
      yield* TestClock.adjust("10 seconds")
      expect(recorded).toHaveLength(0)
      expect(yield* question.list()).toHaveLength(0)
    }),
  ),
)

it.effect(
  "duplicate activity and heartbeats do not defer again, and session clear interrupts pending quiet work",
  provideTmpdirInstance(() =>
    Effect.gen(function* () {
      const attention = yield* SessionAttention.Service
      yield* attention.update(id, { clientID: "dedup", clientType: "terminal", activity: 1 })
      let sent = false
      const timer = yield* attention.quiet(id, 6000).pipe(
        Effect.andThen(
          Effect.sync(() => {
            sent = true
          }),
        ),
        Effect.forkScoped,
      )
      yield* drain
      yield* TestClock.adjust("5 seconds")
      yield* attention.update(id, { clientID: "dedup", clientType: "terminal", activity: 1 })
      yield* attention.update(id, { clientID: "dedup", clientType: "terminal", backgroundView: false })
      yield* TestClock.adjust("1 second")
      yield* Fiber.join(timer)
      expect(sent).toBe(true)
      sent = false
      const cleared = yield* attention.quiet(id, 6000).pipe(
        Effect.andThen(
          Effect.sync(() => {
            sent = true
          }),
        ),
        Effect.forkScoped,
      )
      yield* drain
      yield* attention.clear(id)
      yield* Fiber.await(cleared)
      yield* TestClock.adjust("10 seconds")
      expect(sent).toBe(false)
    }),
  ),
)

// Real AppLayer construction is intentional: the admission service must capture
// the same attention service as the idle producer, not just a supplied test port.
const { AppLayer } = await import("@/effect/app-runtime")
const { Session } = await import("@/session/session")
const { SessionPrompt } = await import("@/session/prompt")
const { SessionHooks } = await import("@/hook/session-hooks")
const { ModelV2 } = await import("@opencode-ai/core/model")
const { ProviderV2 } = await import("@opencode-ai/core/provider")
const fs = await import("node:fs/promises")
const path = await import("node:path")
const appIt = testEffect(
  AppLayer.pipe(Layer.provideMerge(CrossSpawnSpawner.defaultLayer), Layer.provideMerge(SessionHooks.defaultLayer)),
)
appIt.effect(
  "real AppLayer rejected prompt and command admissions cancel an existing idle notification",
  provideTmpdirInstance(
    (directory) =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const prompt = yield* SessionPrompt.Service
        const status = yield* SessionStatus.Service
        const hooks = yield* SessionHooks.Service
        const model = { providerID: ProviderV2.ID.make("notification-fixture"), modelID: ModelV2.ID.make("fixture") }
        const session = yield* sessions.create({ model: { providerID: model.providerID, id: model.modelID } })
        const audit = path.join(directory, "idle-admission-notification")
        yield* hooks.add(session.id, {
          event: "Notification",
          hooks: [{ type: "command", command: `printf notification >> '${audit.replaceAll("'", "'\\''")}'` }],
        })
        const block = {
          type: "command" as const,
          command: `printf '%s' '{"decision":"block","reason":"idle admission guard"}'`,
        }
        yield* hooks.add(session.id, { event: "UserPromptSubmit", hooks: [block] })
        yield* hooks.add(session.id, { event: "UserPromptExpansion", hooks: [block] })
        yield* status.set(session.id, { type: "busy" })
        yield* status.set(session.id, { type: "idle" })
        yield* drain
        yield* TestClock.adjust("60 seconds")
        yield* Effect.promise(async () => {
          for (let i = 0; i < 200; i++) {
            if (await Bun.file(audit).exists()) return
            await Bun.sleep(5)
          }
          throw new Error("AppLayer idle Notification positive control never arrived")
        })
        expect(yield* Effect.promise(() => fs.readFile(audit, "utf8"))).toBe("notification")
        for (const kind of ["prompt", "command"] as const) {
          yield* Effect.promise(() => fs.writeFile(audit, ""))
          yield* status.set(session.id, { type: "busy" })
          yield* status.set(session.id, { type: "idle" })
          yield* drain
          yield* TestClock.adjust("59 seconds")
          const result =
            kind === "prompt"
              ? yield* prompt.prompt({
                  sessionID: session.id,
                  agent: "build",
                  model,
                  hookMode: "interactive",
                  noReply: true,
                  parts: [{ type: "text", text: "Synthetic blocked input" }],
                })
              : yield* prompt.command({
                  sessionID: session.id,
                  agent: "build",
                  model: "notification-fixture/fixture",
                  hookMode: "interactive",
                  command: "notificationfixture",
                  arguments: "",
                })
          expect(JSON.stringify(result)).toContain("idle admission guard")
          yield* TestClock.adjust("2 seconds")
          yield* drain
          expect(yield* Effect.promise(() => fs.readFile(audit, "utf8"))).toBe("")
        }
      }),
    {
      config: {
        command: { notificationfixture: { template: "Synthetic command input" } },
        provider: {
          "notification-fixture": {
            name: "Fixture",
            npm: "@ai-sdk/openai-compatible",
            options: { baseURL: "http://127.0.0.1:1/v1", apiKey: "synthetic" },
            models: { fixture: { name: "Fixture", limit: { context: 4096, output: 64 } } },
          },
        },
      },
    },
  ),
)
// A blocked UserPromptExpansion returns before the normal path lands its
// notices, so a `systemMessage` on the same hook silently disappeared.
appIt.effect(
  "blocked UserPromptExpansion still lands its systemMessage as a notice",
  provideTmpdirInstance(
    (_directory) =>
      Effect.gen(function* () {
        const events = yield* EventV2Bridge.Service
        const sessions = yield* Session.Service
        const prompt = yield* SessionPrompt.Service
        const hooks = yield* SessionHooks.Service
        const model = { providerID: ProviderV2.ID.make("notification-fixture"), modelID: ModelV2.ID.make("fixture") }
        const session = yield* sessions.create({ model: { providerID: model.providerID, id: model.modelID } })
        yield* hooks.add(session.id, {
          event: "UserPromptExpansion",
          hooks: [
            {
              type: "command",
              command: `printf '%s' '${JSON.stringify({
                decision: "block",
                reason: "blocked-by-test",
                systemMessage: "EXPANSION_WARNING",
              })}'`,
            },
          ],
        })
        const notices: string[] = []
        const off = yield* events.listen((event) => {
          if (event.type !== LegacyEvent.HookMessage.type) return Effect.void
          const data = decodeRecord(event.data)
          if (data.sessionID === session.id) notices.push(decodeString(data.message))
          return Effect.void
        })
        yield* Effect.addFinalizer(() => (typeof off === "function" ? Effect.sync(off) : off))
        const result = yield* prompt.command({
          sessionID: session.id,
          agent: "build",
          model: "notification-fixture/fixture",
          hookMode: "interactive",
          command: "notificationfixture",
          arguments: "",
        })
        expect(JSON.stringify(result)).toContain("blocked-by-test")
        expect(notices).toContain("EXPANSION_WARNING")
      }),
    {
      config: {
        command: { notificationfixture: { template: "Synthetic command input" } },
        provider: {
          "notification-fixture": {
            name: "Fixture",
            npm: "@ai-sdk/openai-compatible",
            options: { baseURL: "http://127.0.0.1:1/v1", apiKey: "synthetic" },
            models: { fixture: { name: "Fixture", limit: { context: 4096, output: 64 } } },
          },
        },
      },
    },
  ),
)
