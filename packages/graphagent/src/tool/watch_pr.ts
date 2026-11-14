// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/* oxlint-disable typescript-eslint/no-unsafe-type-assertion -- ctx.extra is an untyped boundary */
import { BackgroundJob } from "@/background/job"
import {
  classify,
  DEFAULT_DEADLINE_SECONDS,
  DEFAULT_POLL_SECONDS,
  HEAD_CHECK_TIMEOUT_MS,
  inspectCommand,
  MAX_DEADLINE_SECONDS,
  MAX_POLL_SECONDS,
  makeProcessRunner,
  MIN_DEADLINE_SECONDS,
  MIN_POLL_SECONDS,
  parseRequest,
  readSnapshot,
  renderNotice,
  renderStopped,
  type Notice,
  type Request,
  type Runner,
  type Snapshot,
} from "@/pr-watch/forge"
import { sessionIDOf } from "@/background/session-metadata"
import { Session } from "@/session/session"
import { Cause, Clock, Deferred, Duration, Effect, Exit, Option, Schema } from "effect"
import { ChildProcessSpawner } from "effect/process"
import type { TaskPromptOps } from "./task"
import * as Tool from "./tool"
import DESCRIPTION from "./watch_pr.txt"

/**
 * The one-shot foreground watch. The forge half of this tool lives in
 * `pr-watch/forge.ts` (#1071 PR2) and is re-exported here so existing callers
 * and tests keep one import path until PR4 rewrites the tool itself.
 */
export * from "@/pr-watch/forge"

export const Parameters = Schema.Struct({
  url: Schema.String.annotate({
    description:
      "Full GitHub pull request URL (https://github.com/owner/repo/pull/N) or GitLab merge request URL (https://gitlab.com/group/project/-/merge_requests/N)",
  }),
  deadline_seconds: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: MIN_DEADLINE_SECONDS, maximum: MAX_DEADLINE_SECONDS })),
  ).annotate({
    description: `Optional watch deadline in seconds (default ${DEFAULT_DEADLINE_SECONDS}, min ${MIN_DEADLINE_SECONDS}, max ${MAX_DEADLINE_SECONDS})`,
  }),
  poll_seconds: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: MIN_POLL_SECONDS, maximum: MAX_POLL_SECONDS })),
  ).annotate({
    description: `Optional poll interval in seconds (default ${DEFAULT_POLL_SECONDS}, min ${MIN_POLL_SECONDS}, max ${MAX_POLL_SECONDS})`,
  }),
})

export type WatchInput = {
  request: Request
  runner: Runner
  deadlineMs: number
  pollMs: number
  deliver: (notice: Notice) => Effect.Effect<void>
  /**
   * Reports the first successful snapshot and the absolute deadline to the
   * caller once. The tool records both in the job metadata so a later
   * watch_pr call can tell which head an existing watch follows.
   */
  onBaseline?: (baseline: Snapshot, deadlineAt: number) => Effect.Effect<void>
}

export function watch(input: WatchInput): Effect.Effect<Notice> {
  return Effect.gen(function* () {
    const started = yield* Clock.currentTimeMillis
    const deadline = started + input.deadlineMs
    const finish = (notice: Notice) => input.deliver(notice).pipe(Effect.as(notice))
    const missing = (baseline: Snapshot | undefined, reason: string) =>
      finish({ outcome: "unavailable", request: input.request, snapshot: baseline, detail: reason })
    const deadlineNotice = (snapshot: Snapshot | undefined, detail?: string) =>
      finish({ outcome: "deadline", request: input.request, snapshot, ...(detail ? { detail } : {}) })
    const readWithin = (remaining: number) =>
      readSnapshot(input.runner, input.request).pipe(Effect.timeoutOption(Duration.millis(Math.max(1, remaining))))

    const first = yield* readWithin(deadline - started)
    if (Option.isNone(first)) return yield* deadlineNotice(undefined, "deadline reached while querying the forge")
    if (!first.value.ok) return yield* missing(undefined, first.value.reason)
    const baseline = first.value.snapshot
    if (input.onBaseline) yield* input.onBaseline(baseline, deadline)
    let current = baseline
    const initial = classify(baseline, baseline)
    if (initial) return yield* finish({ outcome: initial, request: input.request, snapshot: current })

    while (true) {
      const now = yield* Clock.currentTimeMillis
      if (now >= deadline) return yield* deadlineNotice(current)
      yield* Effect.sleep(Duration.millis(Math.min(input.pollMs, deadline - now)))
      const beforeRead = yield* Clock.currentTimeMillis
      if (beforeRead >= deadline) return yield* deadlineNotice(current)
      const next = yield* readWithin(deadline - beforeRead)
      if (Option.isNone(next)) return yield* deadlineNotice(current, "deadline reached while querying the forge")
      if (!next.value.ok) return yield* missing(current, next.value.reason)
      current = next.value.snapshot
      if (current.head !== baseline.head)
        return yield* finish({
          outcome: "superseded",
          request: input.request,
          snapshot: current,
          detail: `new head ${current.head}; start a new watch for this head.`,
        })
      const outcome = classify(baseline, current)
      if (outcome) return yield* finish({ outcome, request: input.request, snapshot: current })
    }
  })
}

export const WatchPrTool = Tool.define(
  "watch_pr",
  Effect.gen(function* () {
    const background = yield* BackgroundJob.Service
    const sessions = yield* Session.Service
    const spawner = Option.getOrUndefined(yield* Effect.serviceOption(ChildProcessSpawner.ChildProcessSpawner))
    const processRunner = makeProcessRunner(spawner)
    return {
      description: DESCRIPTION,
      effects: "read",
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const request = parseRequest(params.url)
          yield* ctx.ask({
            permission: "watch_pr",
            patterns: [request.url],
            always: ["*"],
            metadata: {
              url: request.url,
              provider: request.provider,
              deadline_seconds: params.deadline_seconds,
              poll_seconds: params.poll_seconds,
            },
          })
          const ops = ctx.extra?.promptOps as TaskPromptOps | undefined
          if (!ops) return yield* Effect.fail(new Error("watch_pr requires promptOps in ctx.extra"))
          const runner = (ctx.extra?.watchPrRunner as Runner | undefined) ?? processRunner
          // A watch that is delivering its terminal notice is settling, not
          // running: it must not swallow a re-watch from the notice turn.
          const findRunningWatch = (jobs: ReadonlyArray<BackgroundJob.Info>) =>
            jobs.find(
              (job) =>
                job.status === "running" &&
                job.type === "watch_pr" &&
                sessionIDOf(job.metadata) === ctx.sessionID &&
                job.metadata?.url === request.url,
            )
          let existing = findRunningWatch(yield* background.list())
          let replaced: { id: string; watchedHead: string; currentHead: string } | undefined
          if (existing) {
            const watchedHead =
              typeof existing.metadata?.head === "string" && existing.metadata.head ? existing.metadata.head : undefined
            let currentHead: string | undefined
            let checkFailure: string | undefined
            if (watchedHead) {
              const checked = yield* readSnapshot(runner, request).pipe(
                Effect.timeoutOption(Duration.millis(HEAD_CHECK_TIMEOUT_MS)),
              )
              if (Option.isSome(checked)) {
                if (checked.value.ok) currentHead = checked.value.snapshot.head
                else checkFailure = checked.value.reason
              } else checkFailure = "head check timed out"
            }
            if (watchedHead && currentHead && currentHead !== watchedHead) {
              // The caller is re-watching a newer head; the old watch would
              // only report `superseded` later, so replace it now.
              yield* background.cancel(existing.id)
              replaced = { id: existing.id, watchedHead, currentHead }
              existing = undefined
            } else {
              const deadlineAt =
                typeof existing.metadata?.deadlineAt === "number" ? existing.metadata.deadlineAt : undefined
              const remaining = deadlineAt === undefined ? undefined : Math.max(0, deadlineAt - Date.now())
              const metadata = {
                jobId: existing.id,
                provider: request.provider,
                url: request.url,
                ...(watchedHead ? { head: watchedHead } : {}),
                ...(deadlineAt !== undefined ? { deadlineAt } : {}),
              }
              yield* ctx.metadata({ title: `watch ${request.url}`, metadata })
              return {
                title: `watch ${request.url}`,
                metadata,
                output: [
                  `Already watching ${request.url} (job ${existing.id}).`,
                  `head: ${watchedHead ?? "unknown"}; deadline: ${
                    deadlineAt === undefined ? "unknown" : new Date(deadlineAt).toISOString()
                  }${remaining === undefined ? "" : ` (${Math.ceil(remaining / 1000)}s remaining)`}.`,
                  ...(checkFailure
                    ? [`Could not verify the current head (${checkFailure}); reusing the existing watch.`]
                    : []),
                  "No new job was started; the existing watch delivers its notice.",
                  `If no notice arrives, run one bounded check: ${inspectCommand(request)}`,
                  `If an autonomous goal has nothing else to do until this notice, declare goal intent=await with wait_source=watch_pr and wait_id=${existing.id}.`,
                ].join("\n"),
              }
            }
          }
          const deadline = (params.deadline_seconds ?? DEFAULT_DEADLINE_SECONDS) * 1000
          const poll = (params.poll_seconds ?? DEFAULT_POLL_SECONDS) * 1000
          // The job ID is known only after `start` returns while the run may
          // already be delivering. The deferred closes that gap: settling,
          // goal wake and the notice all wait for the actual job ID.
          const jobReady = yield* Deferred.make<string>()
          const settledJob = Effect.gen(function* () {
            const id = yield* Deferred.await(jobReady)
            yield* background.beginSettling(id)
            return id
          })
          const wakeGoal = (payload: string, evaluate: boolean): Effect.Effect<void> =>
            Effect.gen(function* () {
              const { GoalLoop } = yield* Effect.promise(() => import("@/goal/loop"))
              const loops = Option.getOrUndefined(yield* Effect.serviceOption(GoalLoop.Service))
              if (!loops) return
              const id = yield* Deferred.await(jobReady)
              yield* loops.wake(ctx.sessionID, { source: "watch_pr", ids: [id, request.url] }, payload, { evaluate })
            }).pipe(Effect.ignore)
          const shouldNotifyWithoutReply = Effect.gen(function* () {
            const messages = yield* sessions.messages({ sessionID: ctx.sessionID }).pipe(Effect.orDie)
            let lastUserAt = -1
            let lastAssistantAt = -1
            let lastAssistantAborted = false
            for (const message of messages) {
              const createdAt = message.info.time?.created
              if (typeof createdAt !== "number") continue
              if (message.info.role === "user") lastUserAt = Math.max(lastUserAt, createdAt)
              if (message.info.role === "assistant" && createdAt >= lastAssistantAt) {
                lastAssistantAt = createdAt
                lastAssistantAborted = message.info.error?.name === "MessageAbortedError"
              }
            }
            return lastAssistantAborted && lastUserAt <= lastAssistantAt
          })
          const deliverNotice = (text: string) =>
            Effect.gen(function* () {
              // The session may have been deleted while the watch ran.
              const current = yield* sessions.get(ctx.sessionID).pipe(Effect.option)
              if (Option.isNone(current)) return
              const noReply = yield* shouldNotifyWithoutReply
              yield* ops.prompt(
                {
                  sessionID: ctx.sessionID,
                  agent: current.value.agent ?? ctx.agent,
                  noReply,
                  parts: [{ type: "text", synthetic: true, text }],
                },
                { continueToolBudget: true },
              )
            }).pipe(
              // A delivery failure must not turn into a stopped notice loop.
              Effect.catch((error) =>
                Effect.logError("watch_pr notice delivery failed", {
                  sessionID: ctx.sessionID,
                  url: request.url,
                  error: String(error),
                }),
              ),
            )
          // The job metadata object is owned by this watch and mutated as the
          // watch advances; background snapshots copy its current fields, so a
          // re-watch sees the watched head and the absolute deadline.
          const jobMetadata: Record<string, unknown> = {
            sessionID: ctx.sessionID,
            url: request.url,
            provider: request.provider,
            survivesSessionCancel: true,
          }
          const info = yield* background.start({
            type: "watch_pr",
            title: `watch ${request.url}`,
            metadata: jobMetadata,
            run: watch({
              request,
              runner,
              deadlineMs: deadline,
              pollMs: poll,
              onBaseline: (baseline, deadlineAt) =>
                Effect.sync(() => {
                  jobMetadata.head = baseline.head
                  jobMetadata.deadlineAt = deadlineAt
                }),
              deliver: (notice) =>
                Effect.gen(function* () {
                  // Delivery is the terminal side effect of this watch: mark
                  // the job settling first so a re-watch issued from the
                  // notice turn starts a new job instead of being deduped.
                  yield* settledJob
                  // Flip the goal back to active before the notice turn; that
                  // turn's idle event drives the next goal evaluation, so the
                  // goal neither races the notice nor runs a turn without it.
                  yield* wakeGoal(renderNotice(notice), false)
                  yield* deliverNotice(renderNotice(notice))
                }),
            }).pipe(
              Effect.map(renderNotice),
              Effect.onExit((exit) => {
                if (!Exit.isFailure(exit)) return Effect.void
                const reason = Cause.hasInterruptsOnly(exit.cause) ? "cancelled" : Cause.pretty(exit.cause)
                return Effect.gen(function* () {
                  // The failed job settles only after this handler, so mark it
                  // settling too — a stopped notice must not swallow a
                  // re-watch while the job still reads as running.
                  yield* settledJob
                  // No notice prompt follows a failed job, so evaluate now.
                  yield* wakeGoal(`watch_pr stopped (${reason}) for ${request.url}`, true)
                  yield* deliverNotice(renderStopped(request, reason))
                })
              }),
            ),
          })
          yield* Deferred.succeed(jobReady, info.id)
          yield* ctx.metadata({
            title: `watch ${request.url}`,
            metadata: { jobId: info.id, provider: request.provider, url: request.url },
          })
          return {
            title: `watch ${request.url}`,
            metadata: { jobId: info.id, provider: request.provider, url: request.url },
            output: [
              ...(replaced
                ? [
                    `Replaced job ${replaced.id} (watched head ${replaced.watchedHead}, current head ${replaced.currentHead}); the replacement follows the current head.`,
                  ]
                : []),
              `Started a read-only background watch (job ${info.id}) for ${request.url}.`,
              "Continue with other work; do not sleep or poll in the foreground.",
              "A notice will report checks settled, a failure, merge/close, a review change, a head change, the deadline, or forge unavailability.",
              `A new head needs a new watch. If no notice arrives by the deadline, run one bounded check: ${inspectCommand(request)}`,
              "The job ID is the start confirmation. A notice is delivery, not evidence: query the current head before reporting or merging.",
              `If an autonomous goal has nothing else to do until this notice, declare goal intent=await with wait_source=watch_pr and wait_id=${info.id}.`,
            ].join("\n"),
          }
        }).pipe(Effect.orDie),
    }
  }),
)
