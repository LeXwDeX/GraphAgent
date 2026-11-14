// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/* oxlint-disable typescript-eslint/no-unsafe-type-assertion -- ctx.extra is an untyped boundary */
import { isTerminalValue } from "@graphagent/core/lifecycle/vocabulary"
import { PrWatchPoller } from "@/pr-watch/poller"
import {
  DEFAULT_DEADLINE_SECONDS,
  HEAD_CHECK_TIMEOUT_MS,
  inspectCommand,
  makeProcessRunner,
  MAX_DEADLINE_SECONDS,
  MIN_DEADLINE_SECONDS,
  parseRequest,
  readSnapshot,
  type Runner,
} from "@/pr-watch/forge"
import { Duration, Effect, Option, Schema } from "effect"
import { ChildProcessSpawner } from "effect/process"
import * as Tool from "./tool"
import DESCRIPTION from "./watch_pr.txt"

/**
 * Durable PR/MR watch management (#1071 PR4). The process-level poller owns
 * polling; this tool only registers, queries and cancels durable watches. The
 * forge half lives in `pr-watch/forge.ts` and is re-exported here for callers
 * that still import the request/response helpers from this module.
 */
export * from "@/pr-watch/forge"

export const Parameters = Schema.Struct({
  action: Schema.Literals(["register", "query", "cancel"]).annotate({
    description:
      "register: start a durable watch for a PR/MR URL. query: show a watch by id or URL, or list this session's live watches. cancel: stop a live watch.",
  }),
  url: Schema.optional(Schema.String).annotate({
    description:
      "Required for action=register. Full GitHub pull request URL (https://github.com/owner/repo/pull/N) or GitLab merge request URL (https://gitlab.com/group/project/-/merge_requests/N)",
  }),
  watch_id: Schema.optional(Schema.String).annotate({
    description:
      "For action=query or action=cancel: the watch ID returned by register, or the watched PR/MR URL. Omit for query to list this session's live watches.",
  }),
  deadline_seconds: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: MIN_DEADLINE_SECONDS, maximum: MAX_DEADLINE_SECONDS })),
  ).annotate({
    description: `Optional register deadline in seconds (default ${DEFAULT_DEADLINE_SECONDS}, min ${MIN_DEADLINE_SECONDS}, max ${MAX_DEADLINE_SECONDS})`,
  }),
})

type WatchInput = Schema.Schema.Type<typeof Parameters>

const deadlineOf = (row: { readonly deadlineAt: number }) => new Date(row.deadlineAt).toISOString()

const stateRefOf = (watchID: string) => ({ domain: "pr_watch" as const, id: watchID })

const renderWatch = (row: {
  readonly id: string
  readonly url: string
  readonly phase: string
  readonly head: string | null
  readonly outcome: string | null
  readonly deadlineAt: number
}) =>
  [
    `${row.id} ${row.url}`,
    `state: ${row.phase}; head: ${row.head ?? "pending first read"}; deadline: ${deadlineOf(row)}`,
    ...(row.outcome ? [`outcome: ${row.outcome}`] : []),
  ].join("\n")

/**
 * The single reuse/registration path. Registering while the same session+URL
 * already has a live watch reuses it — with one exception carried over from
 * the job-era tool: when the caller re-watches a newer head, the stale watch
 * would only report a now-irrelevant change, so it is cancelled and replaced.
 */
const register = (
  poller: PrWatchPoller.Interface,
  runner: Runner,
  sessionID: string,
  params: WatchInput,
  ctx: Tool.Context,
) =>
  Effect.gen(function* () {
    if (!params.url)
      throw new Tool.InvalidArgumentsError({
        tool: "watch_pr",
        detail: "`url` is required when action is `register`.",
      })
    const request = parseRequest(params.url)
    yield* ctx.ask({
      permission: "watch_pr",
      patterns: [request.url],
      always: ["*"],
      metadata: {
        url: request.url,
        provider: request.provider,
        deadline_seconds: params.deadline_seconds,
      },
    })
    const [existing] = yield* poller.query({ sessionID, ref: request.url })
    let replaced: { readonly id: string; readonly watchedHead: string; readonly currentHead: string } | undefined
    let baseline: { readonly head: string; readonly baselineReview?: string } | undefined
    let reuse = existing !== undefined && !isTerminalValue("pr_watch", existing.phase) ? existing : undefined
    if (reuse?.phase === "delivering") {
      // The outcome was already observed and its notice is owed; a new watch
      // would compete with that delivery. The notice turn runs after the row
      // settles, so a re-watch there takes the terminal path below.
      return result(`watch ${request.url} is already delivered or delivering`, [
        `Watch ${reuse.id} already observed its outcome (${reuse.outcome ?? "unknown"}) for ${request.url}.`,
        "Its notice is delivered at the next turn boundary; nothing new was started.",
        "After the notice arrives, register a new watch only if more waiting is needed.",
        `Inspect: ${inspectCommand(request)}`,
      ], { watchID: reuse.id, url: request.url, provider: request.provider })
    }
    if (reuse) {
      const watchedHead = reuse.head ?? undefined
      let checkFailure: string | undefined
      if (watchedHead) {
        const checked = yield* readSnapshot(runner, request).pipe(
          Effect.timeoutOption(Duration.millis(HEAD_CHECK_TIMEOUT_MS)),
        )
        if (Option.isSome(checked)) {
          if (checked.value.ok) {
            const current = checked.value.snapshot
            if (current.head !== watchedHead) {
              // The caller is re-watching a newer head; the old watch would
              // only report a now-irrelevant change, so replace it now.
              baseline = { head: current.head, baselineReview: current.review }
              const cancelled = yield* poller.cancel({ sessionID, ref: reuse.id })
              if (cancelled) replaced = { id: reuse.id, watchedHead, currentHead: current.head }
              // Either the cancel won (replace now) or a concurrent one did
              // (the terminal path below registers); never reuse the row.
              reuse = undefined
            }
          } else checkFailure = checked.value.reason
        } else checkFailure = "head check timed out"
      }
      if (reuse) {
        const remaining = Math.max(0, reuse.deadlineAt - Date.now())
        return result(`watch ${request.url}`, [
          `Already watching ${request.url} (watch ${reuse.id}).`,
          `head: ${watchedHead ?? "pending first read"}; deadline: ${deadlineOf(reuse)} (${Math.ceil(remaining / 1000)}s remaining).`,
          ...(checkFailure
            ? [`Could not verify the current head (${checkFailure}); reusing the existing watch.`]
            : []),
          "No new watch was started; the existing one delivers its notice.",
          `If no notice arrives, run one bounded check: ${inspectCommand(request)}`,
          `If an autonomous goal has nothing else to do until this notice, declare goal intent=await with wait_source=watch_pr and wait_id=${reuse.id}.`,
        ], { watchID: reuse.id, url: request.url, provider: request.provider })
      }
    }
    const registered = yield* poller.register({
      sessionID,
      request,
      ...(params.deadline_seconds === undefined ? {} : { deadlineSeconds: params.deadline_seconds }),
      ...(baseline ? baseline : {}),
    })
    const output = [
      ...(replaced
        ? [
            `Replaced watch ${replaced.id} (watched head ${replaced.watchedHead}, current head ${replaced.currentHead}); the replacement follows the current head.`,
          ]
        : []),
      `Started a durable watch (${registered.id}) for ${request.url}.`,
      "The poller runs outside this turn; a notice is delivered at a turn boundary (after the current turn ends).",
      "A notice reports checks settled, a failure, merge/close, a review change, or the deadline; a pushed head rebaselines the watch silently.",
      "This tool never pushes, merges, or changes platform state.",
      `If no notice arrives by the deadline, run one bounded check: ${inspectCommand(request)}`,
      "The watch ID is a StateRef, not evidence: query the current head before reporting or merging.",
      `If an autonomous goal has nothing else to do until this notice, declare goal intent=await with wait_source=watch_pr and wait_id=${registered.id}.`,
    ].join("\n")
    yield* ctx.metadata({ title: `watch ${request.url}`, metadata: { watchID: registered.id, url: request.url } })
    return result(`watch ${request.url}`, output, {
      watchID: registered.id,
      stateRef: stateRefOf(registered.id),
      provider: request.provider,
      url: request.url,
    })
  })

function result(title: string, output: string | ReadonlyArray<string>, metadata: Record<string, unknown>) {
  return { title, output: typeof output === "string" ? output : output.join("\n"), metadata }
}

export const WatchPrTool = Tool.define(
  "watch_pr",
  Effect.gen(function* () {
    const spawner = Option.getOrUndefined(yield* Effect.serviceOption(ChildProcessSpawner.ChildProcessSpawner))
    const processRunner = makeProcessRunner(spawner)
    return {
      description: DESCRIPTION,
      effects: "read",
      parameters: Parameters,
      execute: (params: WatchInput, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const poller = Option.getOrUndefined(yield* Effect.serviceOption(PrWatchPoller.Service))
          if (!poller)
            return result("watch_pr unavailable", "The PR watch service is not available in this runtime.", {})

          if (params.action === "query") {
            const rows = yield* poller.query({
              sessionID: ctx.sessionID,
              ...(params.watch_id === undefined ? {} : { ref: params.watch_id }),
            })
            if (rows.length === 0)
              return result(
                "no watches",
                params.watch_id === undefined
                  ? "No live PR/MR watch in this session. Register one with action=register and the request URL."
                  : `No watch matches \`${params.watch_id}\` in this session.`,
                { watches: [] },
              )
            return result(
              `${rows.length} watch${rows.length === 1 ? "" : "es"}`,
              rows.map(renderWatch).join("\n\n"),
              { watches: rows.map((row) => ({ ...row, stateRef: stateRefOf(row.id) })) },
            )
          }

          if (params.action === "cancel") {
            if (!params.watch_id)
              throw new Tool.InvalidArgumentsError({
                tool: "watch_pr",
                detail: "`watch_id` is required when action is `cancel`.",
              })
            const [found] = yield* poller.query({ sessionID: ctx.sessionID, ref: params.watch_id })
            if (!found)
              return result("no watch", `No watch matches \`${params.watch_id}\` in this session.`, {})
            if (isTerminalValue("pr_watch", found.phase))
              return result(
                "watch already ended",
                `Watch ${found.id} for ${found.url} already ended (${found.phase}); nothing to cancel.`,
                { watchID: found.id, url: found.url, state: found.phase },
              )
            const cancelled = yield* poller.cancel({ sessionID: ctx.sessionID, ref: found.id })
            if (!cancelled)
              return result(
                "watch changed",
                `Watch ${found.id} changed before the cancellation landed (state ${found.phase}); nothing was cancelled.`,
                { watchID: found.id, url: found.url, state: found.phase },
              )
            return result(`cancelled ${cancelled.id}`, [
              `Cancelled watch ${cancelled.id} for ${cancelled.url} (was ${found.phase}).`,
              "No notice will be delivered for it.",
            ], { watchID: cancelled.id, url: cancelled.url, state: cancelled.phase })
          }

          return yield* register(
            poller,
            (ctx.extra?.watchPrRunner as Runner | undefined) ?? processRunner,
            ctx.sessionID,
            params,
            ctx,
          )
        }),
    }
  }),
)