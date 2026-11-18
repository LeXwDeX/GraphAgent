// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect } from "bun:test"
import { CrossSpawnSpawner } from "@graphagent/core/cross-spawn-spawner"
import { Database } from "@graphagent/core/database/database"
import { EventV2 } from "@graphagent/core/event"
import { ref } from "@graphagent/core/lifecycle/state"
import { ModelV2 } from "@graphagent/core/model"
import { ProviderV2 } from "@graphagent/core/provider"
import { Ripgrep } from "@graphagent/core/ripgrep"
import { ChildRunTable } from "@graphagent/core/session/child.sql"
import { LifecycleEvent } from "@graphagent/schema/lifecycle-event"
import type { SessionV1 } from "@graphagent/core/v1/session"
import { eq } from "drizzle-orm"
import { Deferred, Effect, Layer, Option, Ref, Stream } from "effect"
import { Agent } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { BackgroundLifecycle } from "@/background/lifecycle"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Lifecycle } from "@/lifecycle/service"
import { AgentScheduler } from "@/session/agent-scheduler"
import * as AgentSchedulerState from "@/session/agent-scheduler-state"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import type { SessionPrompt } from "@/session/prompt"
import { TaskTool, type TaskPromptOps } from "@/tool/task"
import { ToolRegistry } from "@/tool/registry"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { disposeAllInstances } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { resultDelivery } from "../lib/child-results"
import { initTaskTool } from "../lib/child-runs"

/**
 * #1407: three background tasks with a child limit of one. The task tool, the scheduler's child slot, the job registry,
 * the child-run registry and the lifecycle service are the real ones; the model is a prompt the test holds open. What
 * is asked is what a client reads: the lifecycle state of each job (the read behind `POST /lifecycle/states`), the
 * `lifecycle.transitioned` events published for it, the durable `child_run` rows the queue is told from, and the time
 * the result the parent is told of reports.
 */

afterEach(async () => {
  await disposeAllInstances()
})

const ref0 = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

/** One child run at a time, process-wide: the third task waits for the second, which waits for the first. */
const limits: AgentSchedulerState.SchedulerLimits = { ...AgentSchedulerState.DEFAULT_LIMITS, childGlobal: 1 }
const scheduler = AgentScheduler.make(AgentSchedulerState.makeState(limits), () => Effect.succeed(limits))

const layer = Layer.mergeAll(
  Agent.defaultLayer,
  BackgroundJob.defaultLayer,
  EventV2Bridge.defaultLayer,
  EventV2.defaultLayer,
  Config.defaultLayer,
  CrossSpawnSpawner.defaultLayer,
  Session.defaultLayer,
  SessionRunState.defaultLayer,
  SessionStatus.defaultLayer,
  Truncate.defaultLayer,
  ToolRegistry.defaultLayer,
  Database.defaultLayer,
  RuntimeFlags.layer({}),
  Lifecycle.defaultLayer,
  BackgroundLifecycle.defaultLayer,
  Layer.succeed(AgentScheduler.Service, scheduler),
).pipe(Layer.provide(Ripgrep.defaultLayer))

const it = testEffect(layer)

const executeRaw = (execute: Tool.Def["execute"]) =>
  // oxlint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- test shim: invoke the wrapped execute with unrepaired raw args
  execute as unknown as (args: unknown, ctx: Tool.Context) => Effect.Effect<Tool.ExecuteResult>

const seed = Effect.fn("TaskQueueTest.seed")(function* () {
  const session = yield* Session.Service
  const chat = yield* session.create({ title: "Queue" })
  const user = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: chat.id,
    agent: "build",
    model: ref0,
    time: { created: Date.now() },
  })
  const assistant: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: user.id,
    sessionID: chat.id,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref0.modelID,
    providerID: ref0.providerID,
    time: { created: Date.now() },
  }
  yield* session.updateMessage(assistant)
  return { chat, assistant }
})

const reply = (input: SessionPrompt.PromptInput, text: string): SessionV1.WithParts => {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      role: "assistant",
      parentID: input.messageID ?? MessageID.ascending(),
      sessionID: input.sessionID,
      mode: input.agent ?? "general",
      agent: input.agent ?? "general",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: input.model?.modelID ?? ref0.modelID,
      providerID: input.model?.providerID ?? ref0.providerID,
      time: { created: Date.now() },
      finish: "stop",
    },
    parts: [{ id: PartID.ascending(), messageID: id, sessionID: input.sessionID, type: "text", text }],
  }
}

/** Every `lifecycle.transitioned` published from here on, in order. */
const watchLifecycle = Effect.fnUntraced(function* () {
  const service = yield* EventV2.Service
  const seen = yield* Ref.make<EventV2.Payload<typeof LifecycleEvent.Transitioned>[]>([])
  yield* service.all().pipe(
    Stream.filter((event) => event.type === LifecycleEvent.Transitioned.type),
    Stream.runForEach((event) =>
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- filter narrowed the event type but not the payload generic.
      Ref.update(seen, (list) => [...list, event as EventV2.Payload<typeof LifecycleEvent.Transitioned>]),
    ),
    Effect.forkScoped({ startImmediately: true }),
  )
  return seen
})

/** The edges published for one job, as `from>to` (`-` for the creation). */
const edgesOf = (seen: Ref.Ref<EventV2.Payload<typeof LifecycleEvent.Transitioned>[]>, id: string) =>
  Ref.get(seen).pipe(
    Effect.map((list) =>
      list
        .filter((event) => event.data.domain === "job" && event.data.stateID === id)
        .map((event) => `${event.data.from ?? "-"}>${event.data.to}`),
    ),
  )

describe("background tasks with a limit of one", () => {
  it.instance("the first runs, the others are queued, and each begins when the one before it ends", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const lifecycle = yield* Lifecycle.Service
      const { db } = yield* Database.Service
      const { chat, assistant } = yield* seed()
      const def = yield* initTaskTool(yield* TaskTool)
      const seen = yield* watchLifecycle()
      const delivery = yield* resultDelivery()

      // The model of each child is a prompt the test holds open until it releases that child.
      const gates = new Map<string, Deferred.Deferred<void>>()
      const gateOf = (id: string) => {
        const held = gates.get(id)
        if (held) return held
        const made = Deferred.makeUnsafe<void>()
        gates.set(id, made)
        return made
      }
      const entered: string[] = []
      const promptOps: TaskPromptOps = {
        cancel: () => Effect.void,
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) =>
          Effect.gen(function* () {
            entered.push(input.sessionID)
            yield* Deferred.await(gateOf(input.sessionID))
            return reply(input, `done ${input.sessionID}`)
          }),
      }
      const launch = (name: string) =>
        executeRaw(def.execute)(
          { description: name, prompt: `work on ${name}`, subagent_type: "general", background: true },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        ).pipe(Effect.map((result) => SessionID.make(result.metadata.sessionID)))

      const stateOf = (id: SessionID) =>
        lifecycle.get(ref("job", id)).pipe(Effect.map((observed) => Option.getOrUndefined(observed)))
      const rowOf = (id: SessionID) =>
        db.select().from(ChildRunTable).where(eq(ChildRunTable.child_session_id, id)).get().pipe(Effect.orDie)
      const edges = (id: SessionID, count: number) =>
        pollWithTimeout(
          edgesOf(seen, id).pipe(Effect.map((list) => (list.length >= count ? list : undefined))),
          `job ${id} never published ${count} transitions`,
        )

      // Three tasks started one after the other; the model of the first is still working.
      const first = yield* launch("first")
      const second = yield* launch("second")
      const third = yield* launch("third")
      yield* pollWithTimeout(
        Effect.sync(() => (entered.includes(first) ? true : undefined)),
        "the first never ran",
      )
      // Real time has to pass while the others wait: the time the queue took is what the results are checked against,
      // and timestamps have a millisecond grain (a fixed wait is the test here, not a readiness hack).
      yield* Effect.sleep("30 millis")

      // The state a client reads: the first runs, the second and third wait; none of them is "running" by guess.
      expect(entered).toEqual([first])
      const running = yield* stateOf(first)
      expect(running).toMatchObject({ value: "running", phase: "running", terminal: false, source: "live" })
      const waiting = [yield* stateOf(second), yield* stateOf(third)]
      for (const state of waiting) {
        expect(state).toMatchObject({ value: "queued", phase: "pending", terminal: false, settled: false })
        expect(state?.since).toBeTypeOf("number")
      }
      // The source of the queue is the run's own state, as the durable row has it.
      expect((yield* rowOf(first))?.state).toBe("running")
      expect((yield* rowOf(second))?.state).toBe("queued")
      expect((yield* rowOf(third))?.state).toBe("queued")
      // The registry still calls them all running: the queue is the lifecycle's refinement, not a new job status.
      for (const id of [first, second, third]) expect((yield* jobs.get(id))?.status).toBe("running")

      // The events say it as they happen: each job was queued first, and only the first has left the queue.
      expect(yield* edges(first, 2)).toEqual(["->queued", "queued>running"])
      expect(yield* edgesOf(seen, second)).toEqual(["->queued"])
      expect(yield* edgesOf(seen, third)).toEqual(["->queued"])

      // The first ends. The second takes the slot and begins before it has done anything a client could see.
      const firstEnded = Date.now()
      yield* Deferred.succeed(gateOf(first), undefined)
      yield* pollWithTimeout(
        stateOf(second).pipe(Effect.map((state) => (state?.value === "running" ? state : undefined))),
        "the second never began",
      )
      const began = yield* stateOf(second)
      expect(began).toMatchObject({ value: "running", phase: "running" })
      // It is timed from the moment it began, after the first ended: not from the moment it was started.
      expect(began?.since).toBeGreaterThanOrEqual(firstEnded)
      expect(began?.since).toBeGreaterThan(waiting[0]?.since ?? Number.POSITIVE_INFINITY)
      expect((yield* stateOf(third))?.value).toBe("queued")
      expect((yield* stateOf(first))?.value).toBe("completed")
      expect((yield* rowOf(second))?.state).toBe("running")
      expect((yield* rowOf(third))?.state).toBe("queued")
      expect(entered).toEqual([first, second])
      expect(yield* edgesOf(seen, second)).toEqual(["->queued", "queued>running"])
      expect(yield* edgesOf(seen, third)).toEqual(["->queued"])
      expect(yield* edgesOf(seen, first)).toEqual(["->queued", "queued>running", "running>completed"])

      // The second ends and the third begins; then the third ends.
      yield* Deferred.succeed(gateOf(second), undefined)
      yield* pollWithTimeout(
        stateOf(third).pipe(Effect.map((state) => (state?.value === "running" ? state : undefined))),
        "the third never began",
      )
      yield* Deferred.succeed(gateOf(third), undefined)
      for (const id of [first, second, third]) {
        yield* pollWithTimeout(
          rowOf(id).pipe(Effect.map((row) => (row?.state === "ended" ? row : undefined))),
          `the run of ${id} never ended`,
        )
      }
      expect(yield* edgesOf(seen, third)).toEqual(["->queued", "queued>running", "running>completed"])

      // The results the parent is told of time each run from the moment it began: the wait is not part of the run.
      expect(yield* delivery.claim(chat.id)).toBe(true)
      const results = delivery.admitted.flatMap((admitted) => {
        const part = admitted.input.parts[0]
        const metadata = part?.type === "text" ? part.metadata?.backgroundResult : undefined
        return typeof metadata === "object" && metadata !== null ? [metadata] : []
      })
      expect(results).toHaveLength(3)
      const resultOf = (id: SessionID) => {
        const found = results.find((result) => "childSessionID" in result && result.childSessionID === id)
        if (!found || !("startedAt" in found) || !("endedAt" in found)) throw new Error(`no result for ${id}`)
        return found
      }
      const secondResult = resultOf(second)
      expect(secondResult).toMatchObject({ status: "completed", runningAt: began?.since })
      if (!("runningAt" in secondResult) || typeof secondResult.runningAt !== "number") throw new Error("no runningAt")
      if (typeof secondResult.startedAt !== "number" || typeof secondResult.endedAt !== "number")
        throw new Error("no times")
      // Queued for at least the 30 ms the test waited: the run took less than the span from its start.
      expect(secondResult.runningAt - secondResult.startedAt).toBeGreaterThanOrEqual(30)
      expect(secondResult.endedAt - secondResult.runningAt).toBeLessThan(secondResult.endedAt - secondResult.startedAt)
      // The first never waited: it began as it was started, so its time is the span of its own.
      const firstResult = resultOf(first)
      expect(firstResult).toMatchObject({ status: "completed" })
      if (!("runningAt" in firstResult) || typeof firstResult.runningAt !== "number") throw new Error("no runningAt")
      expect(firstResult.runningAt - Number(firstResult.startedAt)).toBeLessThan(30)
      // The ledger row is what it always was: the time the run began rides on the result, not in the row.
      const row = yield* rowOf(second)
      expect(row?.outcome).toEqual({ type: "completed", report: { title: "second", text: `done ${second}` } })
    }),
  )

  it.instance("a task cancelled in the queue ends queued: it never began", () =>
    Effect.gen(function* () {
      const lifecycle = yield* Lifecycle.Service
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const def = yield* initTaskTool(yield* TaskTool)
      const seen = yield* watchLifecycle()

      const hold = Deferred.makeUnsafe<void>()
      const entered: string[] = []
      const promptOps: TaskPromptOps = {
        cancel: () => Effect.void,
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) =>
          Effect.gen(function* () {
            entered.push(input.sessionID)
            yield* Deferred.await(hold)
            return reply(input, "done")
          }),
      }
      const launch = (name: string) =>
        executeRaw(def.execute)(
          { description: name, prompt: `work on ${name}`, subagent_type: "general", background: true },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        ).pipe(Effect.map((result) => SessionID.make(result.metadata.sessionID)))

      const first = yield* launch("first")
      const second = yield* launch("second")
      yield* pollWithTimeout(
        Effect.sync(() => (entered.includes(first) ? true : undefined)),
        "the first never ran",
      )
      expect(Option.getOrUndefined(yield* lifecycle.get(ref("job", second)))?.value).toBe("queued")

      // The main agent cancels the task that waits: it ends cancelled, from the queue.
      const cancel = executeRaw(def.execute)(
        { action: "cancel", task_id: second },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )
      yield* cancel
      yield* pollWithTimeout(
        jobs.get(second).pipe(Effect.map((job) => (job?.status === "cancelled" ? job : undefined))),
        "the queued job was never cancelled",
      )
      expect(Option.getOrUndefined(yield* lifecycle.get(ref("job", second)))).toMatchObject({
        value: "cancelled",
        phase: "cancelled",
        terminal: true,
      })
      expect(
        yield* pollWithTimeout(
          edgesOf(seen, second).pipe(Effect.map((list) => (list.length >= 2 ? list : undefined))),
          "the cancelled job never published its end",
        ),
      ).toEqual(["->queued", "queued>cancelled"])
      // It never held a slot: only the first ever entered a prompt.
      expect(entered).toEqual([first])
      yield* Deferred.succeed(hold, undefined)
    }),
  )
})
