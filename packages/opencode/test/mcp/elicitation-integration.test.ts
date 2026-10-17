import { describe, expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Cause, Effect, Exit, Fiber, Layer } from "effect"
import { Question } from "@/question"
import { Notification } from "@/notification"
import { SettingsHook, type HookPayload } from "@/hook/settings"
import { handleElicitation, type ElicitResponse } from "@/mcp/elicitation"
import { EventV2Bridge } from "@/event-v2-bridge"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { TestInstance } from "../fixture/fixture"

// mcp-elicitation-notification integration tests.
//
// 5.3 (core): handleElicitation end-to-end through a REAL Question layer —
//   surface, reply, accept content; reject → cancel; Elicitation/ElicitationResult
//   hooks observed.
// 5.5: Notification hook fires for elicitation (and permission) via the emitter.
// 5.6: headless composition (no Question service) declines immediately.
//
// The MCP transport dispatch (InMemoryTransport + Server sending elicitation/create)
// is SDK behavior and is covered by the unit + adapter-layer tests here; a transport-
// level round-trip is a proportionate follow-up rather than a gap in adapter coverage.

const SESSION = "ses_elicitation_test"

// Recording SettingsHook captures every trigger payload.
const emptyResult = {
  blocked: undefined,
  permissionDecision: undefined,
  permissionDecisionReason: undefined,
  additionalContexts: [] as string[],
  systemMessages: [] as string[],
  hookSpecificOutput: undefined,
}
function recorderLayer(): { recorded: HookPayload[]; layer: Layer.Layer<SettingsHook.Service> } {
  const recorded: HookPayload[] = []
  const layer = Layer.succeed(
    SettingsHook.Service,
    SettingsHook.Service.of({
      trigger: (payload: HookPayload) => Effect.sync(() => (recorded.push(payload), { ...emptyResult })),
      list: () => Effect.succeed([]),
    }),
  )
  return { recorded, layer }
}

// Composition with Question + Notification + recording hooks. SessionContext is
// set per-test (the adapter reads it to route the Question).
function makeEnv() {
  const rec = recorderLayer()
  const env = Layer.mergeAll(
    Question.layer.pipe(Layer.provideMerge(EventV2Bridge.defaultLayer)),
    Notification.defaultLayer,
    rec.layer,
  )
  return { ...rec, env }
}

const env1 = makeEnv()
const it = testEffect(env1.env)

const awaitValue = <A, E>(fiber: Fiber.Fiber<A, E>) =>
  Effect.gen(function* () {
    const exit = yield* Fiber.await(fiber)
    if (Exit.isFailure(exit)) return yield* Effect.failCause(exit.cause)
    return exit.value
  })

const ask = (input: { message: string; requestedSchema: unknown; mode?: string }) =>
  handleElicitation({ ...input, sessionID: SESSION })

const waitForPending = (count: number) =>
  Effect.gen(function* () {
    const question = yield* Question.Service
    return yield* pollWithTimeout(
      Effect.gen(function* () {
        const items = yield* question.list()
        return items.length === count ? (items as readonly Question.Request[]) : undefined
      }),
      `timed out waiting for ${count} pending question(s)`,
      "5 seconds",
    )
  })

describe("mcp elicitation — end-to-end through Question (5.3)", () => {
  it.instance("accept: surface, reply with valid answer, content received", () =>
    Effect.gen(function* () {
      const question = yield* Question.Service
      const schema = { type: "object", properties: { color: { type: "string", enum: ["red", "green", "blue"] } } }

      const fiber = yield* ask({ message: "Pick a color", requestedSchema: schema }).pipe(Effect.forkScoped)
      const pending = yield* waitForPending(1)
      yield* question.reply({ requestID: pending[0].id, answers: [["green"]] })
      const response = (yield* awaitValue(fiber)) as ElicitResponse

      expect(response.action).toBe("accept")
      expect(response.content).toEqual({ color: "green" })
    }),
  )

  it.instance("cancel: user dismissal reaches ElicitationResult without submitted content", () =>
    Effect.gen(function* () {
      const question = yield* Question.Service
      const schema = { type: "object", properties: { name: { type: "string" } } }
      const before = env1.recorded.length

      const fiber = yield* ask({ message: "enter name", requestedSchema: schema }).pipe(Effect.forkScoped)
      const pending = yield* waitForPending(1)
      yield* question.reject(pending[0].id)
      const response = (yield* awaitValue(fiber)) as ElicitResponse

      expect(response.action).toBe("cancel")
      expect(response.content).toBeUndefined()
      const events = env1.recorded.slice(before)
      expect(events.filter((p) => p.event === "Elicitation")).toHaveLength(1)
      expect(
        events.filter((p) => p.event === "ElicitationResult" && (p as { action?: string }).action === "cancel"),
      ).toHaveLength(1)
    }),
  )

  it.instance("decline: invalid reply (out-of-enum) resolves to decline", () =>
    Effect.gen(function* () {
      const question = yield* Question.Service
      const schema = { type: "object", properties: { color: { type: "string", enum: ["red", "green"] } } }

      const fiber = yield* ask({ message: "pick", requestedSchema: schema }).pipe(Effect.forkScoped)
      const pending = yield* waitForPending(1)
      // Reply with a value not in the enum → validateAndCoerce returns undefined → decline
      yield* question.reply({ requestID: pending[0].id, answers: [["purple"]] })
      const response = (yield* awaitValue(fiber)) as ElicitResponse
      expect(response.action).toBe("decline")
    }),
  )

  it.instance("interruption remains an interruption and releases the pending question", () =>
    Effect.gen(function* () {
      const question = yield* Question.Service
      const before = env1.recorded.length
      const fiber = yield* ask({
        message: "Enter a name",
        requestedSchema: { type: "object", properties: { name: { type: "string" } } },
      }).pipe(Effect.forkScoped)
      yield* waitForPending(1)
      yield* Fiber.interrupt(fiber)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
      expect(yield* question.list()).toHaveLength(0)
      expect(env1.recorded.slice(before).filter((p) => p.event === "ElicitationResult")).toHaveLength(0)
    }),
  )

  it.instance("decline: url-mode is out of scope and declines without surfacing", () =>
    Effect.gen(function* () {
      const question = yield* Question.Service
      const fiber = yield* ask({ message: "go", requestedSchema: {}, mode: "url" }).pipe(Effect.forkScoped)
      const response = (yield* awaitValue(fiber)) as ElicitResponse
      expect(response.action).toBe("decline")
      const pending = yield* question.list()
      expect(pending).toHaveLength(0)
    }),
  )
})

const commandIt = testEffect(
  Layer.mergeAll(Question.layer.pipe(Layer.provideMerge(EventV2Bridge.defaultLayer)), SettingsHook.defaultLayer),
)

describe("mcp elicitation cancellation command hook", () => {
  commandIt.instance("a real result hook receives cancel and preserves the dismissed response", () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const script = path.join(directory, "result-hook.ts")
      const audit = path.join(directory, "result.json")
      yield* Effect.promise(async () => {
        await fs.mkdir(path.join(directory, ".opencode"), { recursive: true })
        await fs.writeFile(
          script,
          `const input = await Bun.stdin.json()
await Bun.write(process.argv[2], JSON.stringify(input))
console.log(JSON.stringify({ hookSpecificOutput: {
  hookEventName: "ElicitationResult",
  action: input.action === "cancel" ? "cancel" : "decline"
} }))
`,
        )
        await fs.writeFile(
          path.join(directory, ".opencode", "hooks.json"),
          JSON.stringify({
            ElicitationResult: [
              {
                matcher: "fixture",
                hooks: [{ type: "command", command: process.execPath, args: [script, audit] }],
              },
            ],
          }),
        )
      })
      const fiber = yield* handleElicitation({
        sessionID: SESSION,
        serverName: "fixture",
        message: "Enter a name",
        requestedSchema: { type: "object", properties: { name: { type: "string" } } },
      }).pipe(Effect.forkScoped)
      const pending = yield* waitForPending(1)
      yield* (yield* Question.Service).reject(pending[0].id)
      const response = yield* awaitValue(fiber)
      const recorded = yield* Effect.promise(() => Bun.file(audit).json())
      expect(recorded.hook_event_name).toBe("ElicitationResult")
      expect(recorded.mcp_server_name).toBe("fixture")
      expect(recorded.action).toBe("cancel")
      expect(recorded.content).toBeUndefined()
      expect(response).toEqual({ action: "cancel" })
    }),
  )
})

describe("mcp elicitation — Notification emitter (5.5)", () => {
  it.instance("an answered elicitation cancels its delayed dialog notification", () =>
    Effect.gen(function* () {
      const question = yield* Question.Service
      const before = env1.recorded.length
      const schema = { type: "object", properties: { x: { type: "boolean" } } }

      const fiber = yield* ask({ message: "confirm?", requestedSchema: schema }).pipe(Effect.forkScoped)
      const pending = yield* waitForPending(1)
      yield* question.reply({ requestID: pending[0].id, answers: [["Yes"]] })
      yield* awaitValue(fiber)

      const notifications = env1.recorded
        .slice(before)
        .filter(
          (p): p is Extract<HookPayload, { event: "Notification" }> =>
            p.event === "Notification" &&
            (p as { notificationType?: string }).notificationType === "elicitation_dialog",
        )
      expect(notifications).toHaveLength(0)
    }),
  )
})

// ── 5.6 headless composition (no Question service) ──────────────
// A composition WITHOUT the Question layer: handleElicitation must decline
// immediately and never hang. Built from a separate env that omits Question.

const headlessEnv = (() => {
  const rec = recorderLayer()
  const env = Layer.mergeAll(Notification.defaultLayer, rec.layer)
  return { ...rec, env }
})()
const headlessIt = testEffect(headlessEnv.env)

describe("mcp elicitation — headless declines immediately (5.6)", () => {
  headlessIt.instance("no Question service → immediate decline, no surface", () =>
    Effect.gen(function* () {
      const response = yield* handleElicitation({
        message: "x",
        requestedSchema: { type: "object", properties: { a: { type: "string" } } },
        sessionID: SESSION,
      })
      expect(response.action).toBe("decline")
      // The hook can answer in headless mode; absent an answer there is still no Question UI.
      expect(headlessEnv.recorded.filter((p) => p.event === "Elicitation")).toHaveLength(1)
    }),
  )

  headlessIt.instance("no session context → immediate decline even with Question present", () =>
    Effect.gen(function* () {
      const response = yield* handleElicitation({
        message: "x",
        requestedSchema: { type: "object", properties: { a: { type: "string" } } },
        // sessionID omitted → decline even if Question is present
      })
      expect(response.action).toBe("decline")
    }),
  )
})
