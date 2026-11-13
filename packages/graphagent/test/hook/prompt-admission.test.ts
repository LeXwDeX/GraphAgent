// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { SettingsHook, HOOK_REWAKE_SENTINEL } from "@/hook"
import { SessionHooks } from "@/hook/session-hooks"
import { HookRewakeLive } from "@/hook/rewake-live"
import { HookFileWatch } from "@/hook/file-watch"
import { HookLifecycle } from "@/hook/lifecycle"
import { expect, spyOn } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Deferred, Effect, Exit, Fiber, Layer, Option } from "effect"
import { LayerNode } from "@graphagent/core/effect/layer-node"
import { Session } from "@/session/session"
import { SessionInbox } from "@/session/inbox"
import { SessionPrompt } from "@/session/prompt"
import { HookNotification } from "@/hook/notifications"
import { SessionSummary } from "@/session/summary"
import { Database } from "@graphagent/core/database/database"
import { EventV2 } from "@graphagent/core/event"
import { SessionTable } from "@graphagent/core/session/sql"
import { eq } from "drizzle-orm"
import { SessionProjector } from "@graphagent/core/session/projector"
import { provideTmpdirServer } from "../fixture/fixture"
import { awaitWithTimeout, testEffect, pollWithTimeout } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"

import { LSP } from "@/lsp/lsp"
import { MCP } from "@/mcp"
import { SessionRetry } from "@/session/retry"
import { CrossSpawnSpawner } from "@graphagent/core/cross-spawn-spawner"
import { ProviderV2 } from "@graphagent/core/provider"
import { ModelV2 } from "@graphagent/core/model"
import { MessageID, SessionID } from "@/session/schema"
import { SessionCancellation } from "@/session/cancellation"
import { InstanceRef } from "@/effect/instance-ref"
import { InstanceState } from "@/effect/instance-state"
import { Goal } from "@/goal/goal"
import { GoalLoop, GoalLoopJudgeLLM } from "@/goal/loop"
import { SessionStatus } from "@/session/status"
import { ExclusiveRegistry } from "@/session/engine-process"
import { SessionRunState } from "@/session/run-state"

const mcp = Layer.succeed(
  MCP.Service,
  MCP.Service.of({
    status: () => Effect.succeed({}),
    clients: () => Effect.succeed({}),
    instructions: () => Effect.succeed([]),
    tools: () => Effect.succeed({}),
    prompts: () => Effect.succeed({}),
    resources: () => Effect.succeed({}),
    resourceTemplates: () => Effect.succeed({}),
    add: () => Effect.succeed({ status: { status: "disabled" as const } }),
    connect: () => Effect.void,
    disconnect: () => Effect.void,
    getPrompt: () => Effect.succeed(undefined),
    readResource: () => Effect.succeed(undefined),
    startAuth: () => Effect.die("unexpected MCP auth"),
    authenticate: () => Effect.die("unexpected MCP auth"),
    finishAuth: () => Effect.die("unexpected MCP auth"),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated" as const),
  }),
)

const lsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(false),
    touchFile: () => Effect.void,
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.succeed(undefined),
    definition: () => Effect.succeed([]),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed([]),
    workspaceSymbol: () => Effect.succeed([]),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
  }),
)

const root = LayerNode.group([
  SessionPrompt.node,
  SessionInbox.node,
  SettingsHook.node,
  HookRewakeLive.node,
  HookLifecycle.node,
  SessionHooks.node,
  HookFileWatch.node,
  Session.node,
  SessionProjector.node,
  SessionSummary.node,
  Database.node,
  CrossSpawnSpawner.node,
  LayerNode.make(TestLLMServer.layer, []),
])
const it = testEffect(
  LayerNode.buildLayer(root, {
    replacements: [LayerNode.replace(MCP.node, mcp), LayerNode.replace(LSP.node, lsp)],
  }),
)

const providerCfg = (url: string) => ({
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
          variants: { xhigh: {}, high: {} },
        },
      },
      options: {
        apiKey: "test-key",
        baseURL: url,
      },
    },
  },
})

it.live("followup admission owners are visible across instances", () =>
  provideTmpdirServer(({ dir }) =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const ctx = yield* InstanceState.context
      const sessionID = SessionID.create()
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined).pipe(Effect.asVoid))
      const owner = yield* SessionCancellation.admissions
        .run(sessionID, () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release))))
        .pipe(Effect.forkChild)
      yield* Deferred.await(started)
      expect(yield* prompt.followupAdmissionOwnerCount(sessionID)).toBe(1)
      const elsewhere = { ...ctx, directory: path.join(dir, "other") }
      expect(
        yield* prompt.followupAdmissionOwnerCount(sessionID).pipe(Effect.provideService(InstanceRef, elsewhere)),
      ).toBe(1)
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.await(owner)
      expect(yield* prompt.followupAdmissionOwnerCount(sessionID)).toBe(0)
    }),
  ),
)

it.live("resume does not wait on cancellation while holding the admission commit lock", () =>
  provideTmpdirServer(({ llm, dir }) =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const lifecycle = yield* HookLifecycle.Service
      const hooks = yield* SessionHooks.Service
      const session = yield* sessions.create({ title: "resume cancellation lock ordering" })
      const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
      const entered = path.join(dir, "resume-admission-entered")
      const release = path.join(dir, "resume-admission-release")
      yield* hooks.add(session.id, {
        event: "UserPromptSubmit",
        hooks: [
          {
            type: "command",
            command: `touch ${quote(entered)}; while [ ! -f ${quote(release)} ]; do sleep 0.01; done; printf '%s' '{}'`,
          },
        ],
      })
      yield* lifecycle.queueInitial(session.id, "initial")
      yield* Effect.addFinalizer(() => Effect.promise(() => fs.writeFile(release, "go").catch(() => undefined)))
      const resumed = yield* prompt.resume({ sessionID: session.id, hookMode: "noninteractive" }).pipe(Effect.forkChild)
      yield* pollWithTimeout(
        Effect.promise(() =>
          fs.access(entered).then(
            () => true as const,
            () => undefined,
          ),
        ),
        "resume did not reach admission",
      )
      const abort = SessionCancellation.begin(session.id)
      yield* Effect.addFinalizer(() => Effect.sync(abort.finish))
      // Cancel while resume is parked inside the UserPromptSubmit hook. The
      // admission fences the registered owner without waiting for the callback,
      // and the resumed turn must observe the cancellation once it returns.
      const cancelled = yield* SessionCancellation.admissions
        .cancel(session.id, Effect.sync(abort.finish))
        .pipe(Effect.forkChild)
      yield* awaitWithTimeout(Fiber.join(cancelled), "cancel waited on the resume commit lock")
      yield* Effect.promise(() => fs.writeFile(release, "go"))
      expect(Exit.isFailure(yield* Fiber.await(resumed))).toBe(true)
      expect(yield* llm.calls).toBe(0)
    }),
  ),
)

const goalIt = testEffect(
  LayerNode.buildLayer(
    LayerNode.group([root, GoalLoop.node, Goal.node, SessionStatus.node, ExclusiveRegistry.node, SessionRunState.node]),
    {
      replacements: [LayerNode.replace(MCP.node, mcp), LayerNode.replace(LSP.node, lsp)],
    },
  ).pipe(
    Layer.provideMerge(
      Layer.succeed(GoalLoopJudgeLLM, {
        call: () => Effect.succeed(JSON.stringify({ verdict: "done", reason: "finished" })),
      }),
    ),
  ),
)

goalIt.live("cancel decides the goal pause before dispatching owners", () =>
  provideTmpdirServer(() =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const goal = yield* Goal.Service
      const session = yield* sessions.create({ title: "goal cancel ordering" })
      yield* goal.set(session.id, "finish work", 5)
      yield* goal.markTurnDriven(session.id)
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const dispatched = Deferred.makeUnsafe<void>()
      const isTurnDriven = goal.isTurnDriven
      const spy = spyOn(goal, "isTurnDriven").mockImplementation((id) =>
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.andThen(isTurnDriven(id)),
        ),
      )
      const request = SessionCancellation.request(session.id)
      const unregister = request.register(() =>
        Effect.sync(() => Deferred.doneUnsafe(dispatched, Effect.void)).pipe(
          Effect.andThen(goal.clearTurnDriven(session.id)),
        ),
      )
      request.release()
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          spy.mockRestore()
          unregister?.()
          yield* Deferred.succeed(release, undefined)
        }),
      )
      const cancelled = yield* prompt.cancel(session.id).pipe(Effect.forkChild)
      yield* awaitWithTimeout(Deferred.await(entered), "goal pause decision did not start")
      const dispatchedBeforeDecision = yield* Deferred.isDone(dispatched)
      yield* Deferred.succeed(release, undefined)
      yield* awaitWithTimeout(Fiber.join(cancelled), "goal cancellation did not finish")
      expect(dispatchedBeforeDecision).toBe(false)
      expect((yield* goal.load(session.id))?.status).toBe("paused")
      expect(yield* Deferred.isDone(dispatched)).toBe(true)
    }),
  ),
)

goalIt.live("goal handoff abandons a start invalidated while holding the exclusive registry", () =>
  provideTmpdirServer(
    ({ llm }) =>
      Effect.gen(function* () {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const goal = yield* Goal.Service
        const lease = yield* ExclusiveRegistry.Service
        const runs = yield* SessionRunState.Service
        const session = yield* sessions.create({ title: "goal handoff cancellation" })
        const active = yield* goal.set(session.id, "finish work", 5)
        yield* goal.markTurnDriven(session.id)
        const token = Option.getOrThrow(
          yield* lease.claim(session.id, { kind: "goal", id: active.goal_id ?? "legacy" }),
        )
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const unregistering = yield* Deferred.make<void>()
        const start = runs.startIfIdle
        const startSpy = spyOn(runs, "startIfIdle").mockImplementation((...args) =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(start(...args)),
          ),
        )
        const unregister = lease.unregister
        const unregisterSpy = spyOn(lease, "unregister").mockImplementation((id, owner) =>
          Deferred.succeed(unregistering, undefined).pipe(Effect.andThen(unregister(id, owner))),
        )
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            startSpy.mockRestore()
            unregisterSpy.mockRestore()
            yield* Deferred.succeed(release, undefined)
          }),
        )
        const handoff = yield* SessionPrompt.admitIdleUnderFence(prompt, lease, token, {
          sessionID: session.id,
          parts: [{ type: "text", text: "continue", synthetic: true }],
        }).pipe(Effect.forkChild)
        yield* awaitWithTimeout(Deferred.await(entered), "goal handoff did not reach runner startup")
        const cancelled = yield* prompt.cancel(session.id).pipe(Effect.forkChild)
        yield* awaitWithTimeout(Deferred.await(unregistering), "goal pause did not reach lease release")
        yield* Deferred.succeed(release, undefined)
        expect((yield* awaitWithTimeout(Fiber.join(handoff), "stale goal handoff did not settle")).tag).toBe(
          "cancelled",
        )
        yield* awaitWithTimeout(Fiber.join(cancelled), "goal cancel deadlocked on the handoff")
        expect((yield* goal.load(session.id))?.status).toBe("paused")
        expect(yield* llm.calls).toBe(0)
      }),
    { git: true, config: providerCfg },
  ),
)

goalIt.live("goal handoff releases its lease when a later prompt holds the admission lock", () =>
  provideTmpdirServer(
    ({ llm }) =>
      Effect.gen(function* () {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const goal = yield* Goal.Service
        const lease = yield* ExclusiveRegistry.Service
        const session = yield* sessions.create({ title: "goal handoff blocked admission" })
        const active = yield* goal.set(session.id, "finish work", 5)
        yield* goal.markTurnDriven(session.id)
        const token = Option.getOrThrow(
          yield* lease.claim(session.id, { kind: "goal", id: active.goal_id ?? "legacy" }),
        )
        const preparing = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const unregistering = yield* Deferred.make<void>()
        const laterRequested = Deferred.makeUnsafe<void>()
        let cancellation: ReturnType<typeof SessionCancellation.begin> | undefined
        const begin = SessionCancellation.begin
        const beginSpy = spyOn(SessionCancellation, "begin").mockImplementation((id) => {
          const result = begin(id)
          if (id === session.id) cancellation = result
          return result
        })
        const prepare = prompt.prepareTurn
        const prepareSpy = spyOn(prompt, "prepareTurn").mockImplementation((...args) =>
          Deferred.succeed(preparing, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(prepare(...args)),
          ),
        )
        const unregister = lease.unregister
        const unregisterSpy = spyOn(lease, "unregister").mockImplementation((id, owner) =>
          Deferred.succeed(unregistering, undefined).pipe(Effect.andThen(unregister(id, owner))),
        )
        const request = SessionCancellation.request
        let observingLater = false
        const requestSpy = spyOn(SessionCancellation, "request").mockImplementation((id) => {
          const result = request(id)
          if (id === session.id && observingLater) Deferred.doneUnsafe(laterRequested, Effect.void)
          return result
        })
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            cancellation?.finish()
            beginSpy.mockRestore()
            prepareSpy.mockRestore()
            unregisterSpy.mockRestore()
            requestSpy.mockRestore()
            yield* Deferred.succeed(release, undefined)
          }),
        )
        const handoff = yield* SessionPrompt.admitIdleUnderFence(prompt, lease, token, {
          sessionID: session.id,
          parts: [{ type: "text", text: "CANCELLED_GOAL_HANDOFF_971", synthetic: true }],
        }).pipe(Effect.forkChild)
        yield* awaitWithTimeout(Deferred.await(preparing), "goal handoff did not enter its lease")
        const cancelled = yield* prompt.cancel(session.id).pipe(Effect.forkChild)
        yield* awaitWithTimeout(Deferred.await(unregistering), "goal pause did not reach lease release")
        yield* llm.text("later response")
        observingLater = true
        const later = yield* prompt
          .prompt(
            {
              sessionID: session.id,
              agent: "build",
              parts: [{ type: "text", text: "LATER_PROMPT_971" }],
            },
            { skipHookStart: true },
          )
          .pipe(Effect.forkChild)
        yield* awaitWithTimeout(Deferred.await(laterRequested), "later prompt did not reach cancellation admission")
        expect(yield* llm.calls).toBe(0)
        yield* Deferred.succeed(release, undefined)
        expect((yield* awaitWithTimeout(Fiber.join(handoff), "stale goal handoff deadlocked")).tag).toBe("cancelled")
        yield* awaitWithTimeout(Fiber.join(cancelled), "goal cancel deadlocked")
        yield* awaitWithTimeout(Fiber.join(later), "later prompt did not complete")
        expect(yield* llm.calls).toBe(1)
        const firstInput = JSON.stringify(yield* llm.inputs)
        expect(firstInput).toContain("LATER_PROMPT_971")
        expect(firstInput).not.toContain("CANCELLED_GOAL_HANDOFF_971")
        yield* llm.text("subsequent response")
        yield* awaitWithTimeout(
          prompt.prompt(
            {
              sessionID: session.id,
              agent: "build",
              parts: [{ type: "text", text: "subsequent prompt" }],
            },
            { skipHookStart: true },
          ),
          "subsequent prompt did not complete",
        )
        expect(yield* llm.calls).toBe(2)
      }),
    { git: true, config: providerCfg },
  ),
)

goalIt.live("cancel during real goal command startup retains the goal until pause", () =>
  provideTmpdirServer(
    ({ llm }) =>
      Effect.gen(function* () {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const goal = yield* Goal.Service
        const status = yield* SessionStatus.Service
        const session = yield* sessions.create({
          title: "goal startup cancellation",
          model: { providerID: ProviderV2.ID.make("test"), id: ModelV2.ID.make("test-model") },
        })
        yield* (yield* GoalLoop.Service).init()
        const starting = yield* Deferred.make<void>()
        const deciding = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const locked = yield* Deferred.make<void>()
        const unlock = yield* Deferred.make<void>()
        const waiting = yield* Deferred.make<void>()
        const idle = yield* Deferred.make<void>()
        const goalLoopIdle = yield* Deferred.make<string | undefined>()
        const goalAtIdle: Array<string | undefined> = []
        const ownsSession = Goal.ownsSession
        const observerSpy = spyOn(Goal, "ownsSession").mockImplementation((id, directory) =>
          ownsSession(id, directory).pipe(
            Effect.tap(() =>
              id === session.id
                ? goal.load(id).pipe(Effect.flatMap((current) => Deferred.succeed(goalLoopIdle, current?.status)))
                : Effect.void,
            ),
          ),
        )
        const set = status.set
        const statusSpy = spyOn(status, "set").mockImplementation((id, info) =>
          id === session.id && info.type === "busy"
            ? // Record the real busy transition before blocking. The runner's
              // onBusy never returns in this scenario, and the later idle must
              // remain a real transition for the goal loop to observe it.
              set(id, info).pipe(Effect.andThen(Deferred.succeed(starting, undefined)), Effect.andThen(Effect.never))
            : id === session.id && info.type === "idle"
              ? Effect.gen(function* () {
                  goalAtIdle.push((yield* goal.load(id))?.status)
                  yield* set(id, info)
                  yield* Deferred.succeed(idle, undefined)
                })
              : set(id, info),
        )
        const pause = goal.pauseForUserCancel
        const pauseSpy = spyOn(goal, "pauseForUserCancel").mockImplementation((id, reason) =>
          Deferred.succeed(deciding, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(pause(id, reason)),
          ),
        )
        const wait = SessionCancellation.waitForGoalCancels
        const waitSpy = spyOn(SessionCancellation, "waitForGoalCancels").mockImplementation((id) =>
          (id === session.id ? Deferred.succeed(waiting, undefined) : Effect.void).pipe(Effect.andThen(wait(id))),
        )
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            statusSpy.mockRestore()
            pauseSpy.mockRestore()
            waitSpy.mockRestore()
            observerSpy.mockRestore()
            yield* Deferred.succeed(release, undefined)
            yield* Deferred.succeed(unlock, undefined)
          }),
        )
        const command = yield* prompt
          .command({
            sessionID: session.id,
            command: "goal",
            arguments: "finish work",
            agent: "build",
          })
          .pipe(Effect.forkChild)
        yield* awaitWithTimeout(Deferred.await(starting), "goal command did not reach runner startup")
        const lock = yield* SessionCancellation.publication
          .withLock(session.id)(Deferred.succeed(locked, undefined).pipe(Effect.andThen(Deferred.await(unlock))))
          .pipe(Effect.forkChild({ startImmediately: true }))
        yield* awaitWithTimeout(Deferred.await(locked), "publication lock was not acquired")
        const cancelled = yield* prompt.cancel(session.id).pipe(Effect.forkChild)
        yield* awaitWithTimeout(
          Deferred.await(deciding),
          "goal cancellation did not reach pause while publication was locked",
        )
        expect(SessionCancellation.goalCancelPending(session.id)).toBe(true)
        yield* Deferred.succeed(unlock, undefined)
        yield* Fiber.join(lock)
        yield* awaitWithTimeout(Fiber.await(command), "cancelled goal startup did not settle")
        yield* awaitWithTimeout(Deferred.await(waiting), "idle did not wait for goal pause")
        expect(goalAtIdle).toEqual([])
        expect(yield* Deferred.isDone(goalLoopIdle)).toBe(false)
        const drivenBeforePause = yield* goal.isTurnDriven(session.id)
        yield* Deferred.succeed(release, undefined)
        yield* awaitWithTimeout(Fiber.join(cancelled), "goal cancellation did not finish")
        yield* awaitWithTimeout(Deferred.await(idle), "failed startup did not publish idle")
        expect(yield* awaitWithTimeout(Deferred.await(goalLoopIdle), "GoalLoop did not observe idle")).toBe("paused")
        const paused = yield* goal.load(session.id)
        expect(drivenBeforePause).toBe(true)
        expect(paused?.status).toBe("paused")
        expect(goalAtIdle).toEqual(["paused"])
        expect(paused?.paused_reason).toBe("用户中断（ESC）— /goal resume 继续")
        expect(yield* llm.calls).toBe(0)
      }),
    { git: true, config: providerCfg },
  ),
)

goalIt.live("cancel invalidates a model switch result before delayed owner dispatch", () =>
  provideTmpdirServer(
    () =>
      Effect.gen(function* () {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const goal = yield* Goal.Service
        const settings = yield* SettingsHook.Service
        const session = yield* sessions.create({
          title: "model switch cancellation",
          model: { providerID: ProviderV2.ID.make("test"), id: ModelV2.ID.make("test-model") },
        })
        yield* goal.set(session.id, "finish work", 5)
        yield* goal.markTurnDriven(session.id)
        const hookStarted = yield* Deferred.make<void>()
        const hookRelease = yield* Deferred.make<void>()
        const pauseStarted = yield* Deferred.make<void>()
        const pauseRelease = yield* Deferred.make<void>()
        const trigger = settings.trigger
        const triggerSpy = spyOn(settings, "trigger").mockImplementation((payload, context) =>
          payload.event === "PostModelSwitch" && context.sessionID === session.id
            ? Deferred.succeed(hookStarted, undefined).pipe(
                Effect.andThen(Deferred.await(hookRelease)),
                Effect.as({ additionalContexts: ["STALE_MODEL_CONTEXT"], systemMessages: ["STALE_MODEL_NOTICE"] }),
              )
            : trigger(payload, context),
        )
        const isTurnDriven = goal.isTurnDriven
        const pauseSpy = spyOn(goal, "isTurnDriven").mockImplementation((id) =>
          Deferred.succeed(pauseStarted, undefined).pipe(
            Effect.andThen(Deferred.await(pauseRelease)),
            Effect.andThen(isTurnDriven(id)),
          ),
        )
        const notification = spyOn(HookNotification, "message")
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            triggerSpy.mockRestore()
            pauseSpy.mockRestore()
            notification.mockRestore()
            yield* Deferred.succeed(hookRelease, undefined)
            yield* Deferred.succeed(pauseRelease, undefined)
          }),
        )
        yield* prompt.restoreModelContext(session.id)
        yield* awaitWithTimeout(Deferred.await(hookStarted), "model switch hook did not start")
        const consumer = yield* prompt
          .takeModelSwitchContext({ sessionID: session.id, apiModelID: "test-model" })
          .pipe(Effect.forkChild({ startImmediately: true }))
        const cancelled = yield* prompt.cancel(session.id).pipe(Effect.forkChild)
        yield* awaitWithTimeout(Deferred.await(pauseStarted), "cancellation did not reach the goal pause")
        yield* Deferred.succeed(hookRelease, undefined)
        const context = yield* awaitWithTimeout(Fiber.join(consumer), "model switch consumer did not settle")
        const notices = notification.mock.calls.filter(
          ([id, message]) => id === session.id && message === "STALE_MODEL_NOTICE",
        )
        yield* Deferred.succeed(pauseRelease, undefined)
        yield* awaitWithTimeout(Fiber.join(cancelled), "cancellation did not finish")
        expect(context).toEqual([])
        expect(notices).toHaveLength(0)
      }),
    { git: true, config: providerCfg },
  ),
)

goalIt.live("cancel during model switch notice landing drops remaining notices and context", () =>
  provideTmpdirServer(
    () =>
      Effect.gen(function* () {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const settings = yield* SettingsHook.Service
        const session = yield* sessions.create({
          title: "model switch notice cancellation",
          model: { providerID: ProviderV2.ID.make("test"), id: ModelV2.ID.make("test-model") },
        })
        const landed = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const trigger = settings.trigger
        const triggerSpy = spyOn(settings, "trigger").mockImplementation((payload, context) =>
          payload.event === "PostModelSwitch" && context.sessionID === session.id
            ? Effect.succeed({
                additionalContexts: ["STALE_MODEL_CONTEXT"],
                systemMessages: ["FIRST_NOTICE", "STALE_NOTICE"],
              })
            : trigger(payload, context),
        )
        const message = HookNotification.message
        const noticeSpy = spyOn(HookNotification, "message").mockImplementation((id, text) =>
          id === session.id && text === "FIRST_NOTICE"
            ? message(id, text).pipe(
                Effect.andThen(Deferred.succeed(landed, undefined)),
                Effect.andThen(Deferred.await(release)),
              )
            : message(id, text),
        )
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            triggerSpy.mockRestore()
            noticeSpy.mockRestore()
            yield* Deferred.succeed(release, undefined)
          }),
        )
        yield* prompt.restoreModelContext(session.id)
        const consumer = yield* prompt
          .takeModelSwitchContext({ sessionID: session.id, apiModelID: "test-model" })
          .pipe(Effect.forkChild)
        yield* awaitWithTimeout(Deferred.await(landed), "first model switch notice did not land")
        yield* awaitWithTimeout(prompt.cancel(session.id), "model switch cancellation did not finish")
        yield* Deferred.succeed(release, undefined)
        expect(yield* awaitWithTimeout(Fiber.join(consumer), "model switch consumer did not settle")).toEqual([])
        expect(noticeSpy.mock.calls.filter(([id]) => id === session.id).map(([, text]) => text)).toEqual([
          "FIRST_NOTICE",
        ])
      }),
    { git: true, config: providerCfg },
  ),
)

for (const outcome of ["pause", "done"] as const) {
  goalIt.live(`Goal ${outcome} notice preserves the selected session variant`, () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const goal = yield* Goal.Service
        const status = yield* SessionStatus.Service
        const session = yield* sessions.create({ title: `Goal ${outcome} variant`, permission: [] })
        if (outcome === "done") yield* llm.text("work completed")
        yield* prompt.prompt({
          sessionID: session.id,
          agent: "build",
          variant: "xhigh",
          noReply: outcome === "pause",
          parts: [{ type: "text", text: "select xhigh and do the work" }],
        })
        expect((yield* sessions.get(session.id)).model?.variant).toBe("xhigh")
        yield* (yield* GoalLoop.Service).init()
        yield* status.set(session.id, { type: "busy" })
        yield* goal.set(session.id, "finish the work", 5)
        yield* status.set(session.id, { type: "idle" })
        const notice = yield* pollWithTimeout(
          sessions
            .messages({ sessionID: session.id })
            .pipe(
              Effect.map((messages) =>
                messages.find((message) =>
                  message.parts.some(
                    (part) =>
                      part.type === "text" &&
                      (outcome === "pause" ? part.text.includes("目标已暂停") : part.text.includes("finished")),
                  ),
                ),
              ),
            ),
          `Goal ${outcome} notice was not persisted`,
          "8 seconds",
        )
        expect(notice.info.role).toBe("user")
        if (notice.info.role === "user") expect(notice.info.model.variant).toBe("xhigh")
        expect((yield* sessions.get(session.id)).model?.variant).toBe("xhigh")
        if (outcome === "pause") expect((yield* goal.load(session.id))?.status).toBe("paused")
        else expect((yield* goal.lastOutcome(session.id))?.status).toBe("done")
      }),
      { git: true, config: providerCfg },
    ),
  )
}

for (const variant of ["block", "continue-false"] as const) {
  it.live(`UserPromptSubmit ${variant} must stop before invoking the model`, () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const hooks = yield* SessionHooks.Service
        const session = yield* sessions.create({ title: "Audit prompt hook control", permission: [] })
        const output =
          variant === "block"
            ? { decision: "block", reason: "audit-block" }
            : { continue: false, stopReason: "audit-stop" }
        yield* hooks.add(session.id, {
          event: "UserPromptSubmit",
          hooks: [{ type: "command", command: "printf '%s' '" + JSON.stringify(output) + "'" }],
        })
        yield* llm.text("audit-model-was-called")
        const result = yield* prompt.prompt({
          sessionID: session.id,
          agent: "build",
          parts: [{ type: "text", text: "audit user prompt stop signal" }],
        })
        const calls = yield* llm.calls
        expect(calls).toBe(0)
        expect(result.info.role).toBe("user")
      }),
      { git: true, config: providerCfg },
    ),
  )
}

it.live("async hooks re-enter the real session after their caller has completed", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm, dir }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const hooks = yield* SessionHooks.Service
      const session = yield* sessions.create({ title: "Async hook callback", permission: [] })
      const release = path.join(dir, "release")
      const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
      yield* hooks.add(session.id, {
        event: "UserPromptSubmit",
        hooks: [
          {
            type: "command",
            async: true,
            asyncRewake: true,
            once: true,
            command: `while [ ! -f ${quote(release)} ]; do sleep 0.01; done; printf '%s' 'async finished' >&2; exit 2`,
          },
        ],
      })
      yield* llm.text("first response")
      yield* llm.text("rewake response")
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        variant: "xhigh",
        parts: [{ type: "text", text: "start async hook" }],
      })
      expect(yield* llm.calls).toBe(1)
      yield* Effect.promise(() => fs.writeFile(release, "go"))
      yield* pollWithTimeout(
        llm.calls.pipe(Effect.map((calls) => (calls === 2 ? true : undefined))),
        "async hook did not invoke the model again",
      )
      const messages = yield* pollWithTimeout(
        sessions
          .messages({ sessionID: session.id })
          .pipe(
            Effect.map((messages) =>
              messages.filter((message) => message.info.role === "assistant").length >= 2 ? messages : undefined,
            ),
          ),
        "async rewake assistant was not persisted",
      )
      expect(
        messages.some((message) =>
          message.parts.some((part) => part.type === "text" && part.text.includes("Async hook completed")),
        ),
      ).toBe(true)
      const assistants = messages.filter((message) => message.info.role === "assistant")
      expect(assistants).toHaveLength(2)
      const rewake = assistants[1].info
      if (rewake.role !== "assistant") throw new Error("expected rewake assistant")
      expect(rewake.variant).toBe("xhigh")
      expect((yield* sessions.get(session.id)).model?.variant).toBe("xhigh")
    }),
    { git: true, config: providerCfg },
  ),
)

it.live("ordinary async JSON reaches the next V1 model call without a user HookMessage", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm, dir }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const hooks = yield* SessionHooks.Service
      const session = yield* sessions.create({ title: "Async model feedback", permission: [] })
      const release = path.join(dir, "release-async-feedback")
      const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
      const output = JSON.stringify({
        systemMessage: "ASYNC_SYSTEM_TO_MODEL",
        hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "ASYNC_CONTEXT_TO_MODEL" },
      })
      const message = yield* Effect.acquireRelease(
        Effect.sync(() => spyOn(HookNotification, "message")),
        (spy) => Effect.sync(() => spy.mockRestore()),
      )
      yield* hooks.add(session.id, {
        event: "UserPromptSubmit",
        once: true,
        hooks: [
          {
            type: "command",
            async: true,
            command: `while [ ! -f ${quote(release)} ]; do sleep 0.01; done; printf 'working\\n'; printf '%s\\n' ${quote(output)}`,
          },
        ],
      })
      yield* llm.text("first response")
      yield* llm.text("second response")
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        parts: [{ type: "text", text: "start ordinary async hook" }],
      })
      expect(yield* llm.calls).toBe(1)
      yield* Effect.promise(() => fs.writeFile(release, "go"))
      yield* pollWithTimeout(
        hooks
          .list(session.id, "UserPromptSubmit")
          .pipe(Effect.map((remaining) => (remaining.length === 0 ? true : undefined))),
        "async feedback hook did not settle successfully",
      )
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        parts: [{ type: "text", text: "consume async feedback" }],
      })
      const inputs = yield* llm.inputs
      expect(inputs).toHaveLength(2)
      expect(JSON.stringify(inputs[1])).toContain("ASYNC_SYSTEM_TO_MODEL")
      expect(JSON.stringify(inputs[1])).toContain("ASYNC_CONTEXT_TO_MODEL")
      expect(message).not.toHaveBeenCalled()
    }),
    { git: true, config: providerCfg },
  ),
)

it.live("cancelled session discards a completing async Stop hook callback", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm, dir }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const hooks = yield* SessionHooks.Service
      const session = yield* sessions.create({ title: "Cancel discards stop callback", permission: [] })
      const release = path.join(dir, "release")
      const completed = path.join(dir, "completed")
      const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
      yield* hooks.add(session.id, {
        event: "Stop",
        once: true,
        hooks: [
          {
            type: "command",
            async: true,
            asyncRewake: true,
            command: `while [ ! -f ${quote(release)} ]; do sleep 0.01; done; touch ${quote(completed)}; printf '%s' 'result after cancel' >&2; exit 2`,
          },
        ],
      })
      yield* llm.text("first answer")
      yield* llm.text("must never be consumed after cancel")
      yield* prompt.prompt({ sessionID: session.id, agent: "build", parts: [{ type: "text", text: "do work" }] })
      // The turn is over and the async Stop hook is parked on the release file.
      expect(yield* llm.calls).toBe(1)
      // User aborts the (idle) session: a callback completing afterwards must
      // not silently restart the session the user just cancelled.
      yield* prompt.cancel(session.id)
      yield* Effect.promise(() => fs.writeFile(release, "go"))
      yield* pollWithTimeout(
        Effect.promise(async () => {
          try {
            return (await fs.access(completed).then(
              () => true,
              () => false,
            ))
              ? true
              : undefined
          } catch {
            return undefined
          }
        }),
        "async Stop callback never completed",
      )
      // Give a (wrong) rewake ample time to admit a new turn.
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 300)))
      expect(yield* llm.calls).toBe(1)
    }),
    { git: true, config: providerCfg },
  ),
)

it.live("cancel invalidates a stop-chain rewake queued behind a busy turn", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm, dir }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const hooks = yield* SessionHooks.Service
      const session = yield* sessions.create({ title: "Cancel queued rewake", permission: [] })
      const release = path.join(dir, "release")
      const completed = path.join(dir, "completed")
      const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
      yield* hooks.add(session.id, {
        event: "Stop",
        once: true,
        hooks: [
          {
            type: "command",
            async: true,
            asyncRewake: true,
            command: `while [ ! -f ${quote(release)} ]; do sleep 0.01; done; touch ${quote(completed)}; printf '%s' 'queued stale verdict' >&2; exit 2`,
          },
        ],
      })
      yield* llm.text("first answer")
      let openTurn!: () => void
      const turnGate = new Promise<void>((resolve) => {
        openTurn = resolve
      })
      yield* llm.hold("turn two answer", turnGate)
      yield* prompt.prompt({ sessionID: session.id, agent: "build", parts: [{ type: "text", text: "turn one" }] })
      expect(yield* llm.calls).toBe(1)
      // Turn two parks on the model gate: the runner is busy and the prompt
      // lock is held, so the rewake below queues behind it.
      const running = yield* prompt
        .prompt({ sessionID: session.id, agent: "build", parts: [{ type: "text", text: "turn two" }] })
        .pipe(Effect.forkChild)
      yield* pollWithTimeout(
        llm.calls.pipe(Effect.map((calls) => (calls === 2 ? true : undefined))),
        "turn two never reached the model",
      )
      // Complete the stale Stop callback: its rewake waits on the prompt lock.
      yield* Effect.promise(() => fs.writeFile(release, "go"))
      yield* pollWithTimeout(
        Effect.promise(() =>
          fs.access(completed).then(
            () => true,
            () => undefined,
          ),
        ),
        "stale callback never completed",
      )
      // Cancel invalidates the chain and interrupts the busy turn; when the
      // queued rewake finally admits, its chain check must refuse it.
      yield* prompt.cancel(session.id)
      openTurn()
      yield* Fiber.join(running).pipe(Effect.ignore)
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 300)))
      expect(yield* llm.calls).toBe(2)
      // No stale rewake text ever reached a model request.
      const inputs = yield* llm.inputs
      expect(JSON.stringify(inputs).includes("Async hook completed")).toBe(false)
      yield* hooks.clear(session.id)
    }),
    { git: true, config: providerCfg },
  ),
)

it.live("a fresh prompt after cancel re-establishes a working Stop rewake chain", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm, dir }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const hooks = yield* SessionHooks.Service
      const session = yield* sessions.create({ title: "Rewake survives cancel", permission: [] })
      const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
      const addStopHook = (release: string, body: string) =>
        hooks.add(session.id, {
          event: "Stop",
          once: true,
          hooks: [
            {
              type: "command",
              async: true,
              asyncRewake: true,
              command: `while [ ! -f ${quote(release)} ]; do sleep 0.01; done; touch ${quote(`${release}.completed`)}; printf '%s' ${quote(body)} >&2; exit 2`,
            },
          ],
        })
      const releaseA = path.join(dir, "release-a")
      const releaseB = path.join(dir, "release-b")
      // Turn 1 with a pending Stop callback, then cancel: the callback dies.
      yield* addStopHook(releaseA, '{"systemMessage":"stale after cancel"}')
      yield* llm.text("first answer")
      yield* prompt.prompt({ sessionID: session.id, agent: "build", parts: [{ type: "text", text: "turn one" }] })
      expect(yield* llm.calls).toBe(1)
      yield* prompt.cancel(session.id)
      yield* Effect.promise(() => fs.writeFile(releaseA, "go"))
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 300)))
      expect(yield* llm.calls).toBe(1)
      // A fresh prompt + fresh Stop callback must still rewake normally.
      yield* addStopHook(releaseB, '{"systemMessage":"fresh verdict"}')
      yield* llm.text("second answer")
      yield* llm.text("fresh rewake answer")
      yield* prompt.prompt({ sessionID: session.id, agent: "build", parts: [{ type: "text", text: "turn two" }] })
      expect(yield* llm.calls).toBe(2)
      yield* Effect.promise(() => fs.writeFile(releaseB, "go"))
      yield* pollWithTimeout(
        Effect.promise(async () => {
          try {
            return (await fs.access(`${releaseB}.completed`).then(
              () => true,
              () => false,
            ))
              ? true
              : undefined
          } catch {
            return undefined
          }
        }),
        "fresh Stop callback never completed",
      )
      yield* pollWithTimeout(
        llm.calls.pipe(Effect.map((calls) => (calls === 3 ? true : undefined))),
        "fresh Stop callback did not rewake a new turn",
      )
      yield* hooks.clear(session.id)
    }),
    { git: true, config: providerCfg },
  ),
)

it.live("cancelling one session leaves another session's Stop rewake intact", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm, dir }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const hooks = yield* SessionHooks.Service
      const sessionA = yield* sessions.create({ title: "Cancelled neighbour", permission: [] })
      const sessionB = yield* sessions.create({ title: "Independent neighbour", permission: [] })
      const releaseA = path.join(dir, "release-a")
      const releaseB = path.join(dir, "release-b")
      const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
      const addStopHook = (sessionID: typeof sessionA.id, release: string, body: string) =>
        hooks.add(sessionID, {
          event: "Stop",
          once: true,
          hooks: [
            {
              type: "command",
              async: true,
              asyncRewake: true,
              command: `while [ ! -f ${quote(release)} ]; do sleep 0.01; done; if [ -f ${quote(`${release}.rewoke`)} ]; then exit 0; fi; touch ${quote(`${release}.rewoke`)}; printf '%s' ${quote(body)} >&2; exit 2`,
            },
          ],
        })
      yield* addStopHook(sessionA.id, releaseA, '{"systemMessage":"neighbour A verdict"}')
      yield* addStopHook(sessionB.id, releaseB, '{"systemMessage":"neighbour B verdict"}')
      yield* llm.text("a1")
      yield* prompt.prompt({ sessionID: sessionA.id, agent: "build", parts: [{ type: "text", text: "a turn" }] })
      yield* llm.text("b1")
      yield* prompt.prompt({ sessionID: sessionB.id, agent: "build", parts: [{ type: "text", text: "b turn" }] })
      expect(yield* llm.calls).toBe(2)
      yield* prompt.cancel(sessionA.id)
      yield* Effect.promise(() => Promise.all([fs.writeFile(releaseA, "go"), fs.writeFile(releaseB, "go")]))
      yield* pollWithTimeout(
        llm.calls.pipe(Effect.map((calls) => (calls === 3 ? true : undefined))),
        "session B Stop callback did not rewake a new turn",
      )
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 300)))
      // Still exactly one rewake (B's): A's was invalidated, not deferred.
      expect(yield* llm.calls).toBe(3)
      const messagesA = yield* sessions.messages({ sessionID: sessionA.id })
      expect(messagesA.every((m) => m.parts.every((p) => !(p.type === "text" && p.text.includes("neighbour A"))))).toBe(
        true,
      )
      yield* hooks.clear(sessionA.id)
      yield* hooks.clear(sessionB.id)
    }),
    { git: true, config: providerCfg },
  ),
)

it.live("session cancellation aborts an executing pre-tool hook", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm, dir }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const hooks = yield* SessionHooks.Service
      const session = yield* sessions.create({
        title: "Cancel running hook",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      const ready = path.join(dir, "hook.pid")
      const target = path.join(dir, "must-not-write.txt")
      const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
      yield* hooks.add(session.id, {
        event: "PreToolUse",
        hooks: [{ type: "command", command: `echo $$ > ${quote(ready)}; exec sleep 30` }],
      })
      yield* llm.tool("write", { filePath: target, content: "should be cancelled" })
      yield* prompt
        .prompt({ sessionID: session.id, agent: "build", parts: [{ type: "text", text: "cancel this operation" }] })
        .pipe(Effect.forkChild)
      const pid = yield* pollWithTimeout(
        Effect.promise(async () => {
          try {
            return Number(await fs.readFile(ready, "utf8")) || undefined
          } catch {
            return undefined
          }
        }),
        "pre-tool hook never started",
      )
      yield* prompt.cancel(session.id)
      yield* pollWithTimeout(
        Effect.sync(() => {
          try {
            process.kill(pid, 0)
            return undefined
          } catch {
            return true
          }
        }),
        "pre-tool hook survived session cancellation",
        2000,
      )
      expect(
        yield* Effect.promise(() =>
          fs.access(target).then(
            () => true,
            () => false,
          ),
        ),
      ).toBe(false)
    }),
    { git: true, config: providerCfg },
  ),
)

it.live("session cancellation aborts a post-tool hook and preserves the completed tool", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm, dir }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const hooks = yield* SessionHooks.Service
      const session = yield* sessions.create({
        title: "Cancel post-tool hook",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      const ready = path.join(dir, "post-hook.pid")
      const target = path.join(dir, "written.txt")
      const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
      yield* hooks.add(session.id, {
        event: "PostToolUse",
        hooks: [{ type: "command", command: `echo $$ > ${quote(ready)}; exec sleep 30` }],
      })
      yield* llm.tool("write", { filePath: target, content: "completed before cancellation" })
      const running = yield* prompt
        .prompt({
          sessionID: session.id,
          agent: "build",
          parts: [{ type: "text", text: "write the file" }],
        })
        .pipe(Effect.forkChild)
      const pid = yield* pollWithTimeout(
        Effect.promise(async () => {
          try {
            return Number(await fs.readFile(ready, "utf8")) || undefined
          } catch {
            return undefined
          }
        }),
        "post-tool hook never started",
      )
      yield* prompt.cancel(session.id)
      yield* pollWithTimeout(
        Effect.sync(() => {
          try {
            process.kill(pid, 0)
            return undefined
          } catch {
            return true
          }
        }),
        "post-tool hook survived cancellation",
        2000,
      )
      const result = yield* Fiber.await(running)
      expect(Exit.isSuccess(result)).toBe(true)
      if (Exit.isFailure(result)) return
      const tool = result.value.parts.find((part) => part.type === "tool")
      expect(tool?.state.status).toBe("completed")
      expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("completed before cancellation")
    }),
    { git: true, config: providerCfg },
  ),
)

it.live("native tool failures run failure hooks and preserve their feedback", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm, dir }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const hooks = yield* SessionHooks.Service
      const session = yield* sessions.create({
        title: "Native failure hook",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* hooks.add(session.id, {
        event: "PostToolUseFailure",
        hooks: [
          {
            type: "command",
            command: `printf '%s' '{"hookSpecificOutput":{"hookEventName":"PostToolUseFailure","additionalContext":"failure-feedback: retry an existing file"}}'`,
          },
        ],
      })
      yield* llm.tool("read", { filePath: path.join(dir, "missing.txt") })
      yield* llm.text("I will retry a file that exists.")
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        parts: [{ type: "text", text: "read the missing file" }],
      })
      const parts = (yield* sessions.messages({ sessionID: session.id })).flatMap((message) => message.parts)
      const failed = parts.find((part) => part.type === "tool" && part.tool === "read")
      expect(failed?.type).toBe("tool")
      if (failed?.type !== "tool") return
      expect(failed?.state.status).toBe("error")
      if (failed?.state.status !== "error") return
      expect(failed.state.error).toContain("failure-feedback")
      expect(JSON.stringify(yield* llm.inputs)).toContain("failure-feedback")
    }),
    { git: true, config: providerCfg },
  ),
)

it.live("native write, edit and multi-file patch emit actual FileChanged paths", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm, dir }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const hooks = yield* SessionHooks.Service
      const session = yield* sessions.create({
        title: "Hook file events",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      const capture = path.join(dir, "events.jsonl")
      const original = path.join(dir, "source.txt")
      const moved = path.join(dir, "moved.txt")
      const second = path.join(dir, "second.txt")
      const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
      yield* hooks.add(session.id, {
        event: "FileChanged",
        hooks: [{ type: "command", command: "cat >> " + quote(capture) }],
      })
      const watcher = yield* HookFileWatch.Service
      const settings = yield* SettingsHook.Service
      yield* watcher.replace(session.id, [original, moved, second], (file, event) =>
        settings
          .trigger(
            { event: "FileChanged", path: file, changeType: event },
            { sessionID: session.id, transcript: () => Effect.succeed("") },
          )
          .pipe(Effect.asVoid),
      )
      yield* llm.tool("write", { filePath: original, content: "before\n" })
      yield* llm.tool("edit", { filePath: original, oldString: "before", newString: "edited" })
      yield* llm.text("edited")
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") },
        parts: [{ type: "text", text: "exercise write and edit" }],
      })
      expect(yield* Effect.promise(() => fs.readFile(original, "utf8"))).toBe("edited\n")
      yield* pollWithTimeout(
        Effect.promise(async () => {
          const text = await fs.readFile(capture, "utf8").catch(() => "")
          return text.includes(original) ? true : undefined
        }),
        "registered original path was not observed",
        "10 seconds",
      )
      yield* llm.tool("apply_patch", {
        patchText: `*** Begin Patch\n*** Update File: ${original}\n*** Move to: ${moved}\n@@\n-edited\n+after\n*** Add File: ${second}\n+second\n*** End Patch`,
      })
      yield* llm.text("done")
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("gpt-hook-test") },
        parts: [{ type: "text", text: "exercise patch" }],
      })
      expect(yield* Effect.promise(() => fs.readFile(moved, "utf8"))).toBe("after\n")
      expect(yield* Effect.promise(() => fs.readFile(second, "utf8"))).toBe("second\n")
      expect(
        yield* Effect.promise(() =>
          fs.access(original).then(
            () => true,
            () => false,
          ),
        ),
      ).toBe(false)
      const records = yield* pollWithTimeout(
        Effect.promise(async () => {
          const text = await fs.readFile(capture, "utf8").catch(() => "")
          if (!text.trim()) return undefined
          const rows = text
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line))
          const paths = new Set(rows.map((row) => row.file_path))
          return [original, moved, second].every((file) => paths.has(file)) ? rows : undefined
        }),
        "registered patch paths were not observed",
        "10 seconds",
      )
      expect(records.every((record) => ["add", "change", "unlink"].includes(record.event))).toBe(true)
    }),
    {
      git: true,
      config: (url) => {
        const config = providerCfg(url)
        const model = config.provider.test.models["test-model"]
        return {
          provider: {
            test: {
              ...config.provider.test,
              models: { ...config.provider.test.models, "gpt-hook-test": { ...model, id: "gpt-hook-test" } },
            },
          },
        }
      },
    },
  ),
)

for (const event of ["Stop"] as const) {
  it.live(`${event} asyncRewake shares a bounded chain and resets for a new prompt`, () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm, dir }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const hooks = yield* SessionHooks.Service
        const session = yield* sessions.create({ title: "Bounded Stop rewake audit", permission: [] })
        const marker = path.join(dir, "stops")
        const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
        yield* hooks.add(session.id, {
          event,
          hooks: [
            {
              type: "command",
              async: true,
              asyncRewake: true,
              command: `sleep 0.1; cat >> ${quote(marker)}; n=$(wc -l < ${quote(marker)}); if [ "$n" -le 20 ]; then printf 'hook revision %s' "$n" >&2; exit 2; fi`,
            },
          ],
        })
        for (let i = 0; i < 20; i++) yield* llm.text(`response ${i}`)
        const completedStops = (count: number) =>
          pollWithTimeout(
            Effect.promise(async () => {
              try {
                const lines = (await fs.readFile(marker, "utf8")).trim().split("\n")
                return lines.length >= count ? lines.map((line) => JSON.parse(line)) : undefined
              } catch {
                return undefined
              }
            }),
            `Stop chain did not finish ${count} events`,
            "15 seconds",
          )
        yield* prompt.prompt({ sessionID: session.id, agent: "build", parts: [{ type: "text", text: "start" }] })
        const first = yield* completedStops(SettingsHook.MAX_STOP_CONTINUATIONS + 1)
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 200)))
        expect(yield* llm.calls).toBe(SettingsHook.MAX_STOP_CONTINUATIONS + 1)
        expect(first[0].stop_hook_active).toBe(false)
        expect(first.slice(1).every((event) => event.stop_hook_active === true)).toBe(true)

        yield* prompt.prompt({ sessionID: session.id, agent: "build", parts: [{ type: "text", text: "new input" }] })
        const both = yield* completedStops((SettingsHook.MAX_STOP_CONTINUATIONS + 1) * 2)
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 200)))
        expect(yield* llm.calls).toBe((SettingsHook.MAX_STOP_CONTINUATIONS + 1) * 2)
        expect(both[SettingsHook.MAX_STOP_CONTINUATIONS + 1].stop_hook_active).toBe(false)
        yield* hooks.clear(session.id)
      }),
      { git: true, config: providerCfg },
    ),
  )
}

it.live("StopFailure asyncRewake records the failure but does not start a new model turn", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm, dir }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const hooks = yield* SessionHooks.Service
      const session = yield* sessions.create({ title: "StopFailure audit", permission: [] })
      const marker = path.join(dir, "stop-failure")
      const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
      yield* hooks.add(session.id, {
        event: "StopFailure",
        hooks: [
          {
            type: "command",
            async: true,
            asyncRewake: true,
            command: `printf '%s' 'ignored failure' > ${quote(marker)}; exit 2`,
          },
        ],
      })
      // Every 4xx/5xx is resent by the shared retry layer, so the turn ends in
      // error only after the attempt cap. retry-after-ms: 0 keeps the backoff
      // out of the test's wall clock.
      for (let attempt = 0; attempt <= SessionRetry.RETRY_MAX_RETRIES; attempt++) {
        yield* llm.error(503, { error: { message: "provider failure" } }, { "retry-after-ms": "0" })
      }
      yield* prompt.prompt({ sessionID: session.id, agent: "build", parts: [{ type: "text", text: "start" }] })
      yield* pollWithTimeout(
        Effect.promise(() =>
          fs
            .access(marker)
            .then(() => true as const)
            .catch(() => undefined),
        ),
        "StopFailure hook did not run",
        "15 seconds",
      )
      // Exit 2 is ignored for StopFailure: neither its stderr nor stdout may start another provider turn.
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 200)))
      const messages = JSON.stringify(yield* sessions.messages({ sessionID: session.id }))
      expect(messages).not.toContain("ignored failure")
      // Every queued failure was consumed by the retry cap; the turn did not
      // stop early and no reply was left unconsumed.
      expect(yield* llm.calls).toBe(SessionRetry.RETRY_MAX_RETRIES + 1)
      expect(yield* llm.pending).toBe(0)
      yield* hooks.clear(session.id)
    }),
    { git: true, config: providerCfg },
  ),
)

it.live("a command held in UserPromptExpansion cannot overwrite a variant written before abort", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm, dir }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const hooks = yield* SessionHooks.Service
      const session = yield* sessions.create({ title: "Late command variant", permission: [] })
      const release = path.join(dir, "release-expansion")
      const entered = path.join(dir, "expansion-entered")
      const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
      yield* hooks.add(session.id, {
        event: "UserPromptExpansion",
        once: true,
        hooks: [
          {
            type: "command",
            command: `touch ${quote(entered)}; while [ ! -f ${quote(release)} ]; do sleep 0.01; done; printf '%s' '{}'`,
          },
        ],
      })
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        variant: "xhigh",
        noReply: true,
        parts: [{ type: "text", text: "select xhigh" }],
      })
      expect((yield* sessions.get(session.id)).model?.variant).toBe("xhigh")

      const messageID = MessageID.ascending()
      const running = yield* prompt
        .command({
          sessionID: session.id,
          messageID,
          command: "fixture",
          arguments: "",
          agent: "build",
          variant: "xhigh",
          hookMode: "interactive",
        })
        .pipe(Effect.forkChild)
      yield* pollWithTimeout(
        Effect.promise(() =>
          fs.access(entered).then(
            () => true as const,
            () => undefined,
          ),
        ),
        "command expansion hook never started",
      )
      // The command is still held in expansion: nothing for its messageID was accepted.
      expect(
        (yield* sessions.messages({ sessionID: session.id })).some((message) => message.info.id === messageID),
      ).toBe(false)

      // A later variant write must win over the command that started expanding earlier.
      yield* prompt.setModel({
        sessionID: session.id,
        model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") },
        variant: "high",
        source: "picker",
        hookMode: "interactive",
      })
      expect((yield* sessions.get(session.id)).model?.variant).toBe("high")

      // The real abort must fence the command even though its hook is still held.
      yield* prompt.cancel(session.id)
      expect(
        (yield* sessions.messages({ sessionID: session.id })).some((message) => message.info.id === messageID),
      ).toBe(false)

      yield* Effect.promise(() => fs.writeFile(release, "go"))
      const finished = yield* Fiber.await(running)
      // A cancelled command cannot be accepted late and commit its old variant.
      expect((yield* sessions.get(session.id)).model?.variant).toBe("high")
      expect(Exit.isFailure(finished)).toBe(true)
      expect(
        (yield* sessions.messages({ sessionID: session.id })).some((message) => message.info.id === messageID),
      ).toBe(false)
      expect(yield* llm.calls).toBe(0)
    }),
    {
      git: true,
      config: (url) => ({ ...providerCfg(url), command: { fixture: { template: "fixture" } } }),
    },
  ),
)
it.live("a blocked command expansion records [Hook stopped] without changing the session variant", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const hooks = yield* SessionHooks.Service
      const session = yield* sessions.create({ title: "Blocked command variant", permission: [] })
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        variant: "high",
        noReply: true,
        parts: [{ type: "text", text: "select high" }],
      })
      expect((yield* sessions.get(session.id)).model?.variant).toBe("high")
      yield* hooks.add(session.id, {
        event: "UserPromptExpansion",
        hooks: [
          {
            type: "command",
            command: `printf '%s' '{"decision":"block","reason":"blocked-by-expansion"}'`,
          },
        ],
      })
      const result = yield* prompt.command({
        sessionID: session.id,
        command: "fixture",
        arguments: "",
        agent: "build",
        variant: "xhigh",
        hookMode: "interactive",
      })
      expect(result.info.role).toBe("user")
      if (result.info.role === "user") expect(result.info.model.variant).toBe("high")
      expect(result.parts.some((part) => part.type === "text" && part.text.includes("[Hook stopped]"))).toBe(true)
      expect((yield* sessions.get(session.id)).model?.variant).toBe("high")
    }),
    {
      git: true,
      config: (url) => ({ ...providerCfg(url), command: { fixture: { template: "fixture" } } }),
    },
  ),
)
it.live("a command expanded before a later variant write cannot restore its old variant", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm, dir }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const hooks = yield* SessionHooks.Service
      const session = yield* sessions.create({ title: "Command model fence", permission: [] })
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        variant: "xhigh",
        noReply: true,
        parts: [{ type: "text", text: "select xhigh" }],
      })
      expect((yield* sessions.get(session.id)).model?.variant).toBe("xhigh")
      const release = path.join(dir, "release-command-fence")
      const entered = path.join(dir, "command-fence-entered")
      yield* Effect.addFinalizer(() => Effect.promise(() => fs.writeFile(release, "go")).pipe(Effect.ignore))
      const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
      yield* hooks.add(session.id, {
        event: "UserPromptExpansion",
        once: true,
        hooks: [
          {
            type: "command",
            command: `touch ${quote(entered)}; while [ ! -f ${quote(release)} ]; do sleep 0.01; done; printf '%s' '{}'`,
          },
        ],
      })
      yield* llm.text("command completed")
      const running = yield* prompt
        .command({
          sessionID: session.id,
          command: "fixture",
          arguments: "",
          agent: "build",
          variant: "xhigh",
          hookMode: "interactive",
        })
        .pipe(Effect.forkChild)
      yield* pollWithTimeout(
        Effect.promise(() =>
          fs.access(entered).then(
            () => true as const,
            () => undefined,
          ),
        ),
        "command expansion hook never started",
      )
      yield* awaitWithTimeout(
        prompt.setModel({
          sessionID: session.id,
          model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") },
          variant: "high",
          source: "picker",
          hookMode: "interactive",
        }),
        "later model write did not finish",
        "10 seconds",
      )
      expect((yield* sessions.get(session.id)).model?.variant).toBe("high")
      yield* Effect.promise(() => fs.writeFile(release, "go"))
      const result = yield* awaitWithTimeout(Fiber.join(running), "expanded command did not finish", "10 seconds")
      expect(result.info.role).toBe("assistant")
      if (result.info.role === "assistant") expect(result.info.variant).toBe("xhigh")
      expect((yield* sessions.get(session.id)).model?.variant).toBe("high")
    }),
    {
      git: true,
      config: (url) => ({ ...providerCfg(url), command: { fixture: { template: "fixture" } } }),
    },
  ),
)
it.live("successive commands use the model selection current when each one starts", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm, dir }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const hooks = yield* SessionHooks.Service
      const session = yield* sessions.create({ title: "Successive command fence", permission: [] })
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        variant: "xhigh",
        noReply: true,
        parts: [{ type: "text", text: "select xhigh" }],
      })
      const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
      const releaseA = path.join(dir, "release-command-a")
      const releaseB = path.join(dir, "release-command-b")
      const enteredA = path.join(dir, "command-a-entered")
      const enteredB = path.join(dir, "command-b-entered")
      const gate = (entered: string, release: string) => ({
        type: "command" as const,
        command: `touch ${quote(entered)}; while [ ! -f ${quote(release)} ]; do sleep 0.01; done; printf '%s' '{}'`,
      })
      yield* hooks.add(session.id, {
        event: "UserPromptExpansion",
        matcher: "fixturea",
        once: true,
        hooks: [gate(enteredA, releaseA)],
      })
      yield* hooks.add(session.id, {
        event: "UserPromptExpansion",
        matcher: "fixtureb",
        once: true,
        hooks: [gate(enteredB, releaseB)],
      })
      yield* llm.text("command A completed")
      yield* llm.text("command B completed")

      const runningA = yield* prompt
        .command({
          sessionID: session.id,
          command: "fixturea",
          arguments: "a",
          agent: "build",
          variant: "xhigh",
          hookMode: "interactive",
        })
        .pipe(Effect.forkChild)
      yield* pollWithTimeout(
        Effect.promise(() =>
          fs.access(enteredA).then(
            () => true as const,
            () => undefined,
          ),
        ),
        "command A expansion hook never started",
      )
      yield* prompt.setModel({
        sessionID: session.id,
        model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") },
        variant: "high",
        source: "picker",
        hookMode: "interactive",
      })
      yield* Effect.promise(() => fs.writeFile(releaseA, "go"))
      const resultA = yield* Fiber.join(runningA)
      expect(resultA.info.role).toBe("assistant")
      if (resultA.info.role === "assistant") expect(resultA.info.variant).toBe("xhigh")
      expect((yield* sessions.get(session.id)).model?.variant).toBe("high")

      const runningB = yield* prompt
        .command({
          sessionID: session.id,
          command: "fixtureb",
          arguments: "b",
          agent: "build",
          variant: "high",
          hookMode: "interactive",
        })
        .pipe(Effect.forkChild)
      yield* pollWithTimeout(
        Effect.promise(() =>
          fs.access(enteredB).then(
            () => true as const,
            () => undefined,
          ),
        ),
        "command B expansion hook never started",
      )
      yield* Effect.promise(() => fs.writeFile(releaseB, "go"))
      const resultB = yield* Fiber.join(runningB)
      expect(resultB.info.role).toBe("assistant")
      if (resultB.info.role === "assistant") expect(resultB.info.variant).toBe("high")
      expect((yield* sessions.get(session.id)).model?.variant).toBe("high")
    }),
    {
      git: true,
      config: (url) => ({
        ...providerCfg(url),
        command: { fixturea: { template: "fixture" }, fixtureb: { template: "fixture" } },
      }),
    },
  ),
)

it.live("a no-op model write publishes no second ModelSwitched event", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const { db } = yield* Database.Service
      const session = yield* sessions.create({ title: "No-op model switch", permission: [] })
      // Session-aggregate events do not append event-log rows, but every
      // published event still advances the aggregate sequence. The sequence is
      // the observable witness that the first write published once and an
      // identical second write published nothing.
      const seq = () => EventV2.latestSequence(db, session.id)
      const input = {
        sessionID: session.id,
        model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") },
        variant: "high",
        source: "picker",
        hookMode: "interactive",
      } as const
      const baseline = yield* seq()
      yield* prompt.setModel(input)
      expect(yield* seq()).toBe(baseline + 1)
      expect((yield* sessions.get(session.id)).model?.variant).toBe("high")
      yield* prompt.setModel(input)
      expect(yield* seq()).toBe(baseline + 1)
    }),
    { git: true, config: providerCfg },
  ),
)
for (const scenario of ["no-op", "aba"] as const) {
  it.live(`a ${scenario} model write still fences a command expanded before it`, () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm, dir }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const hooks = yield* SessionHooks.Service
        const session = yield* sessions.create({ title: `Command epoch ${scenario}`, permission: [] })
        yield* prompt.prompt({
          sessionID: session.id,
          agent: "build",
          variant: "high",
          noReply: true,
          parts: [{ type: "text", text: "select high" }],
        })
        expect((yield* sessions.get(session.id)).model?.variant).toBe("high")
        const release = path.join(dir, `release-command-epoch-${scenario}`)
        const entered = path.join(dir, `command-epoch-entered-${scenario}`)
        const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
        yield* hooks.add(session.id, {
          event: "UserPromptExpansion",
          once: true,
          hooks: [
            {
              type: "command",
              command: `touch ${quote(entered)}; while [ ! -f ${quote(release)} ]; do sleep 0.01; done; printf '%s' '{}'`,
            },
          ],
        })
        yield* llm.text("command completed")
        const running = yield* prompt
          .command({
            sessionID: session.id,
            command: "fixture",
            arguments: scenario,
            agent: "build",
            variant: "xhigh",
            hookMode: "interactive",
          })
          .pipe(Effect.forkChild)
        yield* pollWithTimeout(
          Effect.promise(() =>
            fs.access(entered).then(
              () => true as const,
              () => undefined,
            ),
          ),
          "command expansion hook never started",
        )
        if (scenario === "aba") {
          yield* prompt.setModel({
            sessionID: session.id,
            model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") },
            variant: "xhigh",
            source: "picker",
            hookMode: "interactive",
          })
        }
        yield* prompt.setModel({
          sessionID: session.id,
          model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") },
          variant: "high",
          source: "picker",
          hookMode: "interactive",
        })
        expect((yield* sessions.get(session.id)).model?.variant).toBe("high")
        yield* Effect.promise(() => fs.writeFile(release, "go"))
        const result = yield* Fiber.join(running)
        expect(result.info.role).toBe("assistant")
        if (result.info.role === "assistant") expect(result.info.variant).toBe("xhigh")
        expect((yield* sessions.get(session.id)).model?.variant).toBe("high")
      }),
      {
        git: true,
        config: (url) => ({ ...providerCfg(url), command: { fixture: { template: "fixture" } } }),
      },
    ),
  )
}

// §12: the session reports dag_mode to UserPromptSubmit, but hook output can
// never change the mode — the field is input-only and the session's stored
// value is untouched even when a hook echoes a conflicting one back.
it.live("UserPromptSubmit receives dag_mode and hook output cannot change the session mode", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm, dir }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const { db } = yield* Database.Service
      const session = yield* sessions.create({ title: "DAG mode payload", permission: [] })
      yield* db.update(SessionTable).set({ dag_mode: "on" }).where(eq(SessionTable.id, session.id))
      const audit = path.join(dir, "dag-mode-input.json")
      const script = path.join(dir, "dag-mode-hook.ts")
      yield* Effect.promise(async () => {
        await fs.writeFile(
          script,
          `const i=JSON.parse(await Bun.stdin.text());await Bun.write(${JSON.stringify(audit)},JSON.stringify(i));console.log(JSON.stringify({dag_mode:"off",hookSpecificOutput:{hookEventName:"UserPromptSubmit",additionalContext:"DAG_MODE_OUTPUT"}}))`,
        )
        await fs.mkdir(path.join(dir, ".agents"), { recursive: true })
        await fs.writeFile(
          path.join(dir, ".agents", "hooks.json"),
          JSON.stringify({
            UserPromptSubmit: [{ hooks: [{ type: "command", command: process.execPath, args: [script] }] }],
          }),
        )
      })
      yield* llm.text("done")
      yield* prompt.prompt({ sessionID: session.id, agent: "build", parts: [{ type: "text", text: "which mode?" }] })

      const received = yield* Effect.promise(() => fs.readFile(audit, "utf8").then((text) => JSON.parse(text)))
      expect(received).toMatchObject({ hook_event_name: "UserPromptSubmit", dag_mode: "on" })
      // The hook echoed `dag_mode: "off"`; the runtime ignores it entirely.
      expect((yield* sessions.get(session.id)).dagMode).toBe("on")
    }),
    { git: true, config: providerCfg },
  ),
)

/**
 * Issue #1019 PR8: UserPromptSubmit gates on admission kind, not on "is this
 * a user tab". Automation entries that still submit a prompt through admission
 * (DAG wake, goal continuation, DAG agent messages, child results) must run
 * hooks; entries that never enter admission (child-run loops, hook rewake,
 * internal delegation) must not. The check lives in `admit.ts` next to the
 * `isRewake`/`internalDelegation` predicate; this matrix pins both sides.
 */
goalIt.live("UserPromptSubmit runs for automation entries and is skipped for internal re-entries", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm, dir }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const goals = yield* Goal.Service
      const hooks = yield* SessionHooks.Service
      const lease = yield* ExclusiveRegistry.Service
      const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
      const audit = (name: string) => path.join(dir, `ups-${name}.txt`)
      const auditText = (file: string) => Effect.promise(() => fs.readFile(file, "utf8").catch(() => undefined))
      const addHook = (sessionID: SessionID, file: string) =>
        hooks.add(sessionID, {
          event: "UserPromptSubmit",
          hooks: [{ type: "command", command: `printf 'ups\\n' >> ${quote(file)}` }],
        })
      const dagToken = (sessionID: SessionID, id: string) =>
        Effect.gen(function* () {
          yield* lease.register(sessionID, { kind: "dag", id })
          return Option.getOrThrow(yield* lease.claim(sessionID, { kind: "dag" }))
        })

      // 1. DAG wake: admission with `continueToolBudget`, dag owner.
      {
        const session = yield* sessions.create({ title: "ups dag wake" })
        const file = audit("dag-wake")
        yield* addHook(session.id, file)
        const token = yield* dagToken(session.id, "dag_wake")
        yield* llm.text("dag wake answer")
        const run = yield* SessionPrompt.admitIdleUnderFence(
          prompt,
          lease,
          token,
          {
            sessionID: session.id,
            agent: "build",
            parts: [{ type: "text", text: "DAG_WAKE_INPUT", synthetic: true }],
          },
          { continueToolBudget: true },
        )
        if (run.tag !== "admitted") throw new Error(`admission did not run: ${run.tag}`)
        yield* run.turn
        expect(yield* auditText(file)).toContain("ups")
      }

      // 2. Goal continuation: same admission shape plus a persist fence.
      {
        const session = yield* sessions.create({ title: "ups goal continuation" })
        const file = audit("goal-continuation")
        yield* addHook(session.id, file)
        const active = yield* goals.set(session.id, "finish work", 5)
        yield* goals.markTurnDriven(session.id)
        const owner = { kind: "goal" as const, id: active.goal_id ?? "legacy" }
        yield* lease.register(session.id, owner)
        const token = Option.getOrThrow(yield* lease.claim(session.id, { kind: "goal", id: owner.id }))
        yield* llm.text("goal continuation answer")
        const run = yield* SessionPrompt.admitIdleUnderFence(
          prompt,
          lease,
          token,
          {
            sessionID: session.id,
            agent: "build",
            parts: [{ type: "text", text: "GOAL_CONTINUATION_INPUT", synthetic: true }],
          },
          { continueToolBudget: true },
          Effect.void,
        )
        if (run.tag !== "admitted") throw new Error(`admission did not run: ${run.tag}`)
        yield* run.turn
        expect(yield* auditText(file)).toContain("ups")
      }

      // 3. DAG agent message: admission without admission options.
      {
        const session = yield* sessions.create({ title: "ups agent message" })
        const file = audit("agent-message")
        yield* addHook(session.id, file)
        const token = yield* dagToken(session.id, "dag_message")
        yield* llm.text("agent message answer")
        const run = yield* SessionPrompt.admitIdleUnderFence(prompt, lease, token, {
          sessionID: session.id,
          agent: "build",
          parts: [
            {
              type: "text",
              text: JSON.stringify({ kind: "dag_agent_message", from: "child", content: "AGENT_MESSAGE_INPUT" }),
              synthetic: true,
            },
          ],
        })
        if (run.tag !== "admitted") throw new Error(`admission did not run: ${run.tag}`)
        yield* run.turn
        expect(yield* auditText(file)).toContain("ups")
      }

      // 4. Child result: the parent prompt submitted by background results.
      {
        const session = yield* sessions.create({ title: "ups child result" })
        const file = audit("child-result")
        yield* addHook(session.id, file)
        yield* llm.text("child result answer")
        yield* prompt.prompt(
          {
            sessionID: session.id,
            agent: "build",
            parts: [{ type: "text", text: "CHILD_RESULT_INPUT", synthetic: true }],
          },
          { continueToolBudget: true },
        )
        expect(yield* auditText(file)).toContain("ups")
      }

      // 5. Child-run loop bypasses admission entirely (DAG spawn/recovery).
      {
        const parent = yield* sessions.create({ title: "ups child-run parent" })
        const session = yield* sessions.create({ parentID: parent.id, title: "ups child run" })
        const file = audit("child-run")
        yield* addHook(session.id, file)
        const childRuns = (yield* prompt.children).forParent(parent.id)
        const run = yield* childRuns.start({
          childSessionID: session.id,
          owner: { kind: "dag_node", workflowID: "wf-ups", nodeID: "child-run", attempt: 0 },
          detached: false,
          permission: { ask: "auto" },
        })
        yield* childRuns.prompt({
          sessionID: session.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "CHILD_RUN_INPUT" }],
        })
        yield* llm.text("child run answer")
        yield* prompt.loop({ sessionID: session.id }, { kind: "child_run" })
        expect(yield* auditText(file)).toBeUndefined()
        yield* run.settle({ type: "completed" })
      }

      // 6. Hook rewake re-enters the session without another UPS round trip.
      {
        const session = yield* sessions.create({ title: "ups rewake" })
        const file = audit("rewake")
        yield* addHook(session.id, file)
        yield* llm.text("rewake answer")
        yield* prompt.prompt({
          sessionID: session.id,
          agent: "build",
          parts: [
            {
              type: "text",
              text: `${HOOK_REWAKE_SENTINEL} (command: test, event: Stop):\nignored rewake\n</system-reminder>`,
            },
          ],
        })
        expect(yield* auditText(file)).toBeUndefined()
      }

      // 7. Internal delegation carries subagent/DAG input, not a user submit.
      {
        const parent = yield* sessions.create({ title: "ups internal parent" })
        const session = yield* sessions.create({ parentID: parent.id, title: "ups internal delegation" })
        const file = audit("internal-delegation")
        yield* addHook(session.id, file)
        const childRuns = (yield* prompt.children).forParent(parent.id)
        const run = yield* childRuns.start({
          childSessionID: session.id,
          owner: { kind: "dag_node", workflowID: "wf-ups", nodeID: "internal", attempt: 0 },
          detached: false,
          permission: { ask: "auto" },
        })
        yield* llm.text("internal delegation answer")
        yield* childRuns.prompt({
          sessionID: session.id,
          agent: "build",
          parts: [{ type: "text", text: "INTERNAL_DELEGATION_INPUT" }],
        })
        expect(yield* auditText(file)).toBeUndefined()
        yield* run.settle({ type: "completed" })
      }
    }),
    { git: true, config: providerCfg },
  ),
)
