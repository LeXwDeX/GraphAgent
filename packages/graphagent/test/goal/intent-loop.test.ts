// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- mocked service slices use `as never` shims.
import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect, Layer, Option } from "effect"
import { BackgroundJob } from "@graphagent/core/background-job"
import { Database } from "@graphagent/core/database/database"
import { RuntimeJobTable } from "@graphagent/core/lifecycle/runtime-job.sql"
import { Project } from "@graphagent/core/project"
import { ProjectTable } from "@graphagent/core/project/sql"
import { AbsolutePath } from "@graphagent/core/schema"
import { SessionTable } from "@graphagent/core/session/sql"
import { Session as SessionSchema } from "@graphagent/schema/session"
import { GoalLoop, GoalLoopJudgeLLM } from "@/goal/loop"
import { runtimeJobProcessID } from "@/background/persist"
import { RuntimeJobRecovery } from "@/background/recovery"
import { Goal } from "@/goal/goal"
import { GoalState } from "@/goal/state"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Lifecycle } from "@/lifecycle/service"
import { SessionStatus } from "@/session/status"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { Provider } from "@/provider/provider"
import { SessionID } from "@/session/schema"
import { testEffect, pollWithTimeout } from "../lib/effect"
import { requireInstance } from "../fixture/fixture"
import { withIdleAdmission } from "../lib/session-prompt"

// Loop-level regressions for #989 waits and #1067 two-stage expiry: the first
// expiry dispatches one bounded review turn (not a pause), the next idle
// without a declared intent pauses visibly, and a blocked judge verdict
// downgrades to awaiting the session's running watch instead of pausing.

const promptCalls: { noReply?: boolean; text: string }[] = []
let judgeCalls = 0
let judgeVerdict = "continue"
const runningJobs: BackgroundJob.Info[] = []

const assistant = {
  info: { id: "asst-1", role: "assistant", time: { created: Date.now() } },
  parts: [{ type: "text", text: "Started the watch; waiting for CI." }],
} as never

const recordingPrompt = Layer.succeed(
  SessionPrompt.Service,
  (() => {
    const record = (input: SessionPrompt.PromptInput) =>
      Effect.sync(() => {
        promptCalls.push({
          noReply: input.noReply,
          text: input.parts.map((part) => (part.type === "text" ? part.text : "")).join("\n"),
        })
        return undefined as never
      })
    return withIdleAdmission({
      prompt: record,
      deliver: (input: SessionPrompt.PromptInput) => record(input).pipe(Effect.map(Option.some)),
    }) as never
  })(),
)

const layer = GoalLoop.layer.pipe(
  Layer.provide(Layer.mock(Session.Service, { messages: () => Effect.sync(() => [assistant]) })),
  Layer.provide(recordingPrompt),
  Layer.provide(Layer.mock(Provider.Service, {})),
  Layer.provide(Layer.mock(BackgroundJob.Service, { list: () => Effect.sync(() => [...runningJobs]) })),
  Layer.provide(
    Layer.succeed(GoalLoopJudgeLLM, {
      call: () =>
        Effect.sync(() => {
          judgeCalls += 1
          return JSON.stringify({ verdict: judgeVerdict, reason: "not yet" })
        }),
    }),
  ),
  Layer.provideMerge(Goal.defaultLayer),
  Layer.provideMerge(SessionStatus.defaultLayer),
  Layer.provideMerge(EventV2Bridge.defaultLayer),
  // The same database Goal.defaultLayer builds on: the restart tests seed
  // session and runtime_job rows through it.
  Layer.provideMerge(Database.defaultLayer),
)

// The real restart recovery, on the same database and lifecycle bridge: the
// restart tests let it fail the dead process's jobs before the goal scan runs.
const recovery = RuntimeJobRecovery.layer.pipe(
  Layer.provide(Layer.mergeAll(Database.defaultLayer, Lifecycle.layer.pipe(Layer.provide(EventV2Bridge.defaultLayer)))),
)

const it = testEffect(Layer.merge(layer, recovery))

const reset = () => {
  promptCalls.length = 0
  judgeCalls = 0
  judgeVerdict = "continue"
  runningJobs.length = 0
}

const awaitWatch = (deadline: number): GoalState.Intent => ({
  kind: "await",
  wait: {
    source: "watch_pr",
    wait_id: "job_1",
    deadline,
    max_wakes: GoalState.nni(1),
    wakes: GoalState.nni(0),
  },
})

describe("GoalLoop — waits", () => {
  it.instance("an expired wait dispatches one bounded review turn before pausing", () =>
    Effect.gen(function* () {
      reset()
      const loop = yield* GoalLoop.Service
      const goal = yield* Goal.Service
      const events = yield* EventV2Bridge.Service
      yield* loop.init()
      const sid = SessionID.descending()
      yield* goal.set(sid, "merge the PR", 10)
      yield* goal.setIntent(sid, awaitWatch(Date.now() - 1))
      yield* Effect.yieldNow

      yield* events.publish(SessionStatus.Event.Status, { sessionID: sid, status: { type: "idle" } })
      yield* pollWithTimeout(
        Effect.gen(function* () {
          const state = yield* goal.load(sid)
          return state?.status === "active" && state.intent?.kind === "blocked" && promptCalls.length > 0
            ? true
            : undefined
        }),
        "the expired wait never dispatched its review turn",
        "5 seconds",
      )

      // #1067 stage one: the expiry marker returns the goal to active and
      // asks for one bounded check instead of pausing immediately.
      const reviewed = yield* goal.load(sid)
      expect(reviewed?.paused_reason).toBeUndefined()
      expect(reviewed?.last_reason).toContain("job_1")
      expect(promptCalls).toEqual([{ noReply: undefined, text: expect.stringContaining("[等待超时复核]") }])
      expect(promptCalls[0]?.text).toContain("有界检查")
      expect(judgeCalls).toBe(0)

      // Stage two: the review turn declared nothing, so the next idle pauses.
      for (let i = 0; i < 10; i++) yield* Effect.yieldNow
      yield* events.publish(SessionStatus.Event.Status, { sessionID: sid, status: { type: "idle" } })
      yield* pollWithTimeout(
        Effect.gen(function* () {
          return (yield* goal.load(sid))?.status === "paused" ? true : undefined
        }),
        "the review turn without a new intent never paused the goal",
        "5 seconds",
      )

      expect(String((yield* goal.load(sid))?.paused_reason)).toContain("watch_pr:job_1")
      expect(promptCalls.some((call) => call.noReply === true && call.text.includes("⏸ 目标已暂停"))).toBe(true)
      expect(judgeCalls).toBe(0)
    }),
  )

  it.instance("a judge-blocked verdict awaits this session's running watch instead of pausing", () =>
    Effect.gen(function* () {
      reset()
      judgeVerdict = "blocked"
      const loop = yield* GoalLoop.Service
      const goal = yield* Goal.Service
      const events = yield* EventV2Bridge.Service
      yield* loop.init()
      const sid = SessionID.descending()
      yield* goal.set(sid, "merge the PR", 10)
      const deadlineAt = Date.now() + 120_000
      runningJobs.push({
        id: "job_watch_1",
        type: "watch_pr",
        title: "watch https://example.test/pr/1",
        status: "running",
        started_at: Date.now(),
        metadata: { sessionID: sid, url: "https://example.test/pr/1", deadlineAt },
      })
      yield* Effect.yieldNow

      yield* events.publish(SessionStatus.Event.Status, { sessionID: sid, status: { type: "idle" } })
      yield* pollWithTimeout(
        Effect.sync(() => (promptCalls.some((call) => call.text.includes("已改为等待该任务完成")) ? true : undefined)),
        "the blocked verdict never downgraded to a wait",
        "5 seconds",
      )

      const state = yield* goal.load(sid)
      expect(state?.status).toBe("waiting")
      expect(state?.intent).toMatchObject({
        kind: "await",
        wait: { source: "watch_pr", wait_id: "job_watch_1" },
      })
      expect(state?.intent?.kind === "await" ? state.intent.wait.deadline : 0).toBe(deadlineAt + 60_000)
      expect(promptCalls.every((call) => !call.text.includes("⏸ 目标已暂停"))).toBe(true)
      const downgrade = promptCalls.find((call) => call.text.includes("已改为等待该任务完成"))
      expect(downgrade?.noReply).toBe(true)
      expect(judgeCalls).toBe(1)
    }),
  )

  it.instance("idle boundaries while waiting never dispatch or spend turns", () =>
    Effect.gen(function* () {
      reset()
      const loop = yield* GoalLoop.Service
      const goal = yield* Goal.Service
      const events = yield* EventV2Bridge.Service
      yield* loop.init()
      const sid = SessionID.descending()
      yield* goal.set(sid, "merge the PR", 10)
      yield* goal.setIntent(sid, {
        kind: "await",
        wait: {
          source: "background_job",
          wait_id: "ses_child",
          deadline: Date.now() + 60_000,
          max_wakes: GoalState.nni(1),
          wakes: GoalState.nni(0),
        },
      })
      yield* Effect.yieldNow

      for (let i = 0; i < 5; i++) {
        yield* events.publish(SessionStatus.Event.Status, { sessionID: sid, status: { type: "idle" } })
        for (let j = 0; j < 10; j++) yield* Effect.yieldNow
      }
      yield* Effect.sleep("50 millis")

      const state = yield* goal.load(sid)
      expect(state?.status).toBe("waiting")
      expect(Number(state?.turns_used)).toBe(0)
      expect(promptCalls).toHaveLength(0)
      expect(judgeCalls).toBe(0)
    }),
  )

  it.instance("a waiting goal that survives a restart is not dispatched by the startup scan", () =>
    Effect.gen(function* () {
      reset()
      const loop = yield* GoalLoop.Service
      const goal = yield* Goal.Service
      const sid = SessionID.descending()
      // Durable row written before this process's GoalLoop boots.
      yield* goal.set(sid, "merge the PR", 10)
      yield* goal.setIntent(sid, awaitWatch(Date.now() + 60_000))

      yield* loop.init()
      for (let i = 0; i < 20; i++) yield* Effect.yieldNow
      yield* Effect.sleep("50 millis")

      const state = yield* goal.load(sid)
      expect(state?.status).toBe("waiting")
      expect(Number(state?.turns_used)).toBe(0)
      expect(promptCalls).toHaveLength(0)
      expect(judgeCalls).toBe(0)
    }),
  )

  // #1069 acceptance 5b: after a restart, recovery fails the job the dead
  // process left running, and the startup scan ends the wait of the goal
  // waiting on it instead of leaving it parked until the deadline. The wait ends
  // like a timed-out one: one bounded review turn whose prompt names the lost
  // job, and a visible pause if that turn declares nothing.
  it.instance("a waiting goal whose job did not survive the restart gets a review turn that names the job", () =>
    Effect.gen(function* () {
      reset()
      const loop = yield* GoalLoop.Service
      const goal = yield* Goal.Service
      const events = yield* EventV2Bridge.Service
      const { db } = yield* Database.Service
      const instance = yield* requireInstance
      const alive = SessionID.descending()
      const lost = SessionID.descending()
      const seedSession = (id: string) =>
        Effect.gen(function* () {
          yield* db
            .insert(ProjectTable)
            .values({ id: Project.ID.global, worktree: AbsolutePath.make(instance.directory), sandboxes: [] })
            .onConflictDoNothing()
            .run()
          yield* db
            .insert(SessionTable)
            .values({
              id: SessionSchema.ID.make(id),
              project_id: Project.ID.global,
              slug: id,
              directory: AbsolutePath.make(instance.directory),
              title: id,
              version: "test",
            })
            .run()
        })
      yield* seedSession(alive)
      yield* seedSession(lost)
      const awaitRow = (jobID: string): GoalState.Intent => ({
        kind: "await",
        wait: {
          source: "watch_pr",
          wait_id: jobID,
          ref: { domain: "job", id: jobID },
          deadline: Date.now() + 60_000,
          max_wakes: GoalState.nni(1),
          wakes: GoalState.nni(0),
        },
      })
      // Durable state written by the previous process: one job it left running,
      // plus a running job owned by this very process.
      const watchTitle = "watch https://github.com/acme/widgets/pull/42"
      yield* db
        .insert(RuntimeJobTable)
        .values([
          {
            id: "job_restart_lost",
            type: "watch_pr",
            title: watchTitle,
            process_id: "proc_dead",
            session_id: lost,
            status: "running",
            started_at: 1,
            updated_at: 1,
          },
          {
            id: "job_restart_alive",
            type: "watch_pr",
            process_id: runtimeJobProcessID,
            session_id: alive,
            status: "running",
            started_at: 1,
            updated_at: 1,
          },
        ])
        .run()
      yield* goal.set(lost, "merge the PR", 10)
      yield* goal.setIntent(lost, awaitRow("job_restart_lost"))
      yield* goal.set(alive, "merge the other PR", 10)
      yield* goal.setIntent(alive, awaitRow("job_restart_alive"))

      // Process start order: recovery first, then the instance boots its goal loop.
      expect(yield* (yield* RuntimeJobRecovery.Service).recoverOnce()).toBe(1)
      const failed = yield* db.select().from(RuntimeJobTable).where(eq(RuntimeJobTable.id, "job_restart_lost")).get()
      expect(failed).toMatchObject({ status: "error", error: "process_restart" })

      yield* loop.init()
      yield* pollWithTimeout(
        Effect.sync(() => (promptCalls.some((call) => !call.noReply) ? true : undefined)),
        "the orphaned wait never got its review turn",
        "5 seconds",
      )

      // One review prompt, and the agent can read in it which job was lost and why.
      const prompts = promptCalls.filter((call) => !call.noReply)
      expect(prompts).toHaveLength(1)
      const review = prompts[0]?.text ?? ""
      expect(review).toContain("[等待任务丢失复核]")
      expect(review).toContain("目标：merge the PR")
      for (const part of [
        "等待的后台任务",
        watchTitle,
        "job_restart_lost",
        "因进程重启已终止（状态 error：process_restart）",
        "请决定重跑或放弃",
        "本轮结束仍未声明进展时，目标将暂停",
      ]) {
        expect(review).toContain(part)
      }
      expect(review).not.toContain("job_restart_alive")
      // The wait ended as a timed-out one does: active with the review marker,
      // no turn spent, no judge call. A wait on a live job of this process stays.
      const marked = yield* goal.load(lost)
      expect(marked?.status).toBe("active")
      expect(marked?.intent?.kind).toBe("blocked")
      expect(marked?.last_reason).toContain("process_restart")
      expect(Number(marked?.turns_used)).toBe(0)
      expect(judgeCalls).toBe(0)
      const kept = yield* goal.load(alive)
      expect(kept?.status).toBe("waiting")
      expect(Number(kept?.turns_used)).toBe(0)

      // The review turn ends without a declared intent: the goal pauses visibly.
      for (let i = 0; i < 10; i++) yield* Effect.yieldNow
      yield* events.publish(SessionStatus.Event.Status, { sessionID: lost, status: { type: "idle" } })
      yield* pollWithTimeout(
        Effect.gen(function* () {
          return (yield* goal.load(lost))?.status === "paused" ? true : undefined
        }),
        "the review turn without a new intent never paused the goal",
        "5 seconds",
      )
      const paused = yield* goal.load(lost)
      expect(String(paused?.paused_reason)).toContain("job_restart_lost")
      expect(String(paused?.paused_reason)).toContain("复核回合未取得进展")
      expect(
        promptCalls.some(
          (call) =>
            call.noReply === true && call.text.includes("⏸ 目标已暂停") && call.text.includes("job_restart_lost"),
        ),
      ).toBe(true)
      expect(promptCalls.filter((call) => !call.noReply)).toHaveLength(1)
      expect((yield* goal.load(alive))?.status).toBe("waiting")
    }),
  )

  it.instance("only the registered watch wakes the goal, and a state-only wake defers to the next idle", () =>
    Effect.gen(function* () {
      reset()
      const loop = yield* GoalLoop.Service
      const goal = yield* Goal.Service
      const events = yield* EventV2Bridge.Service
      yield* loop.init()
      const sid = SessionID.descending()
      yield* goal.set(sid, "merge the PR", 10)
      yield* goal.setIntent(sid, awaitWatch(Date.now() + 60_000))
      yield* Effect.yieldNow

      expect(yield* Effect.scoped(loop.wake(sid, { source: "watch_pr", ids: ["job_9", "https://x/pr/2"] }))).toBe(false)
      expect(yield* Effect.scoped(loop.wake(sid, { source: "background_job", ids: ["job_1"] }))).toBe(false)
      expect((yield* goal.load(sid))?.status).toBe("waiting")

      const woke = yield* Effect.scoped(
        loop.wake(sid, { source: "watch_pr", ids: ["job_1"] }, "checks passed", { evaluate: false }),
      )
      expect(woke).toBe(true)
      for (let i = 0; i < 20; i++) yield* Effect.yieldNow
      expect(promptCalls).toHaveLength(0)
      expect((yield* goal.load(sid))?.intent?.kind).toBe("progress")

      // The notice turn ends: its idle event continues the goal without a judge call.
      yield* events.publish(SessionStatus.Event.Status, { sessionID: sid, status: { type: "idle" } })
      yield* pollWithTimeout(
        Effect.sync(() => (promptCalls.some((call) => !call.noReply) ? true : undefined)),
        "the woken goal never continued",
        "5 seconds",
      )
      expect(judgeCalls).toBe(0)
      const state = yield* goal.load(sid)
      expect(state?.status).toBe("active")
      expect(state?.intent).toBeUndefined()
    }),
  )

  it.instance("a progress intent spends one turn per continuation and respects the budget", () =>
    Effect.gen(function* () {
      reset()
      const loop = yield* GoalLoop.Service
      const goal = yield* Goal.Service
      const events = yield* EventV2Bridge.Service
      yield* loop.init()
      const sid = SessionID.descending()
      yield* goal.set(sid, "ship it", 1)
      yield* goal.setIntent(sid, { kind: "progress" })
      yield* Effect.yieldNow

      yield* events.publish(SessionStatus.Event.Status, { sessionID: sid, status: { type: "idle" } })
      yield* pollWithTimeout(
        Effect.gen(function* () {
          const state = yield* goal.load(sid)
          return state && state.status !== "active" ? state : promptCalls.length > 0 ? state : undefined
        }),
        "the progress intent never reached a budget decision",
        "5 seconds",
      )
      for (let i = 0; i < 20; i++) yield* Effect.yieldNow

      // Budget 1: the first progress boundary spends the only turn and the
      // goal pauses visibly instead of dispatching unbounded work.
      const state = yield* goal.load(sid)
      expect(judgeCalls).toBe(0)
      expect(Number(state?.turns_used)).toBe(1)
      expect(state?.status).toBe("paused")
      expect(promptCalls.every((call) => call.noReply)).toBe(true)
    }),
  )

  it.instance("a wake that evaluates immediately survives the caller's scope", () =>
    Effect.gen(function* () {
      reset()
      const loop = yield* GoalLoop.Service
      const goal = yield* Goal.Service
      yield* loop.init()
      const sid = SessionID.descending()
      yield* goal.set(sid, "merge the PR", 10)
      yield* goal.setIntent(sid, awaitWatch(Date.now() + 60_000))
      yield* Effect.yieldNow

      // Callers wrap the wake in Effect.scoped; no notice prompt follows.
      expect(
        yield* Effect.scoped(loop.wake(sid, { source: "watch_pr", ids: ["job_1"] }, "watch exited without a notice")),
      ).toBe(true)
      yield* pollWithTimeout(
        Effect.sync(() => (promptCalls.some((call) => !call.noReply) ? true : undefined)),
        "the woken goal was never evaluated",
        "5 seconds",
      )
      expect(Number((yield* goal.load(sid))?.turns_used)).toBe(1)
    }),
  )
})
