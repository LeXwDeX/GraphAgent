// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/* oxlint-disable typescript-eslint/no-unsafe-type-assertion -- JSON responses and ctx.extra are untyped boundaries */
import { BackgroundJob } from "@/background/job"
import { Session } from "@/session/session"
import { Cause, Clock, Duration, Effect, Exit, Option, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import type { ChildProcessSpawner as Spawner } from "effect/process/ChildProcessSpawner"
import type { TaskPromptOps } from "./task"
import * as Tool from "./tool"
import DESCRIPTION from "./watch_pr.txt"

export type Provider = "github" | "gitlab"
export type Outcome = "success" | "failure" | "merged" | "closed" | "review" | "superseded" | "deadline" | "unavailable"

export type Request = {
  provider: Provider
  host: string
  authority: string
  url: string
  number: number
  path: string
}

export type CheckCounts = {
  total: number
  pending: number
  failed: number
  passed: number
}

export type Snapshot = {
  state: "open" | "merged" | "closed"
  head: string
  review: string
  checks: CheckCounts
}

export type CommandResult = { code: number; stdout: string; stderr: string }
export type Runner = (command: string, args: string[]) => Effect.Effect<CommandResult>
export type ReadResult = { ok: true; snapshot: Snapshot } | { ok: false; reason: string }

export type Notice = {
  outcome: Outcome
  request: Request
  snapshot?: Snapshot
  detail?: string
}

export const DEFAULT_DEADLINE_SECONDS = 1800
export const DEFAULT_POLL_SECONDS = 15
export const MIN_DEADLINE_SECONDS = 10
export const MAX_DEADLINE_SECONDS = 3600
export const MIN_POLL_SECONDS = 5
export const MAX_POLL_SECONDS = 300

const GITHUB_HOSTS = ["github.com"]
const GITLAB_HOSTS = ["gitlab.com"]

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

export function allowedHosts(value = process.env.GRAPHAGENT_WATCH_PR_HOSTS) {
  const extra = (value ?? "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean)
  return new Set([...GITHUB_HOSTS, ...GITLAB_HOSTS, ...extra])
}

function normalizedHost(url: URL) {
  return url.hostname.toLowerCase().replace(/^www\./, "")
}

export function parseRequest(raw: string, hosts = allowedHosts()): Request {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error("watch_pr requires a full request URL")
  }
  if (url.protocol !== "https:") throw new Error("watch_pr accepts only https request URLs")
  if (url.username || url.password) throw new Error("watch_pr rejects URLs with embedded credentials")
  const host = normalizedHost(url)
  if (!hosts.has(host)) throw new Error(`watch_pr host is not allowed: ${host}`)
  const authority = url.port ? `${host}:${url.port}` : host
  const origin = `${url.protocol}//${authority}`

  const github = /^\/([^/]+)\/([^/]+)\/pull\/([1-9]\d*)\/?$/.exec(url.pathname)
  if (github) {
    return {
      provider: "github",
      host,
      authority,
      url: `${origin}/${github[1]}/${github[2]}/pull/${github[3]}`,
      number: Number(github[3]),
      path: `${github[1]}/${github[2]}`,
    }
  }

  const gitlab = /^\/(.+)\/-\/merge_requests\/([1-9]\d*)\/?$/.exec(url.pathname)
  if (gitlab && gitlab[1].includes("/")) {
    return {
      provider: "gitlab",
      host,
      authority,
      url: `${origin}/${gitlab[1]}/-/merge_requests/${gitlab[2]}`,
      number: Number(gitlab[2]),
      path: gitlab[1],
    }
  }

  throw new Error("watch_pr accepts only GitHub /pull/N or GitLab /-/merge_requests/N URLs")
}

function counts(checks: Array<"pending" | "success" | "failure">): CheckCounts {
  return {
    total: checks.length,
    pending: checks.filter((state) => state === "pending").length,
    failed: checks.filter((state) => state === "failure").length,
    passed: checks.filter((state) => state === "success").length,
  }
}

function githubCheck(value: unknown): "pending" | "success" | "failure" {
  if (!value || typeof value !== "object") return "pending"
  const check = value as Record<string, unknown>
  const conclusion = typeof check.conclusion === "string" ? check.conclusion.toUpperCase() : ""
  if (
    ["FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"].includes(conclusion) ||
    ["ERROR", "FAILURE"].includes(typeof check.state === "string" ? check.state.toUpperCase() : "")
  )
    return "failure"
  if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes(conclusion) || check.state === "SUCCESS") return "success"
  return "pending"
}

function githubState(value: unknown): Snapshot["state"] | undefined {
  if (value === "MERGED") return "merged"
  if (value === "CLOSED") return "closed"
  if (value === "OPEN") return "open"
  return undefined
}

export function parseGithub(stdout: string): Snapshot | undefined {
  let value: unknown
  try {
    value = JSON.parse(stdout)
  } catch {
    return undefined
  }
  if (!value || typeof value !== "object") return undefined
  const pr = value as Record<string, unknown>
  const state = githubState(pr.state)
  const head = typeof pr.headRefOid === "string" ? pr.headRefOid : ""
  if (!state || !head) return undefined
  const review = typeof pr.reviewDecision === "string" ? pr.reviewDecision : "NONE"
  const rollup = Array.isArray(pr.statusCheckRollup) ? pr.statusCheckRollup : []
  return { state, head, review, checks: counts(rollup.map(githubCheck)) }
}

function gitlabState(value: unknown): Snapshot["state"] | undefined {
  if (value === "merged") return "merged"
  if (value === "closed") return "closed"
  if (value === "opened") return "open"
  return undefined
}

function gitlabPipelineStatus(status: string): "pending" | "success" | "failure" {
  if (["failed", "canceled"].includes(status)) return "failure"
  if (["success", "skipped"].includes(status)) return "success"
  return "pending"
}

type GitlabDetail = {
  snapshot: Snapshot
  pipeline?: { sha: string; ref?: string; status: string }
  targetBranch?: string
}

function parseGitlabDetail(stdout: string): GitlabDetail | undefined {
  let value: unknown
  try {
    value = JSON.parse(stdout)
  } catch {
    return undefined
  }
  if (!value || typeof value !== "object") return undefined
  const mr = value as Record<string, unknown>
  const state = gitlabState(mr.state)
  const diff = mr.diff_refs && typeof mr.diff_refs === "object" ? (mr.diff_refs as Record<string, unknown>) : undefined
  const pipeline =
    mr.head_pipeline && typeof mr.head_pipeline === "object" ? (mr.head_pipeline as Record<string, unknown>) : undefined
  const pipelineSha = typeof pipeline?.sha === "string" ? pipeline.sha : undefined
  const head =
    (typeof diff?.head_sha === "string" && diff.head_sha) || (typeof mr.sha === "string" && mr.sha) || pipelineSha || ""
  if (!state || !head) return undefined
  const review =
    (typeof mr.detailed_merge_status === "string" && mr.detailed_merge_status) ||
    (typeof mr.merge_status === "string" && mr.merge_status) ||
    "unknown"
  const status = typeof pipeline?.status === "string" ? pipeline.status : "pending"
  const ref = typeof pipeline?.ref === "string" ? pipeline.ref : undefined
  const targetBranch = typeof mr.target_branch === "string" ? mr.target_branch : undefined
  const checks = pipelineSha === head ? counts([gitlabPipelineStatus(status)]) : counts([])
  return {
    snapshot: { state, head, review, checks },
    ...(pipelineSha ? { pipeline: { sha: pipelineSha, ref, status } } : {}),
    ...(targetBranch ? { targetBranch } : {}),
  }
}

export function parseGitlab(stdout: string): Snapshot | undefined {
  return parseGitlabDetail(stdout)?.snapshot
}

function gitlabCommitParents(stdout: string): string[] | undefined {
  let value: unknown
  try {
    value = JSON.parse(stdout)
  } catch {
    return undefined
  }
  if (!value || typeof value !== "object") return undefined
  const parents = (value as Record<string, unknown>).parent_ids
  if (!Array.isArray(parents)) return undefined
  return parents.flatMap((parent) => (typeof parent === "string" ? [parent] : []))
}

function gitlabBranchHead(stdout: string): string | undefined {
  let value: unknown
  try {
    value = JSON.parse(stdout)
  } catch {
    return undefined
  }
  if (!value || typeof value !== "object") return undefined
  const commit = (value as Record<string, unknown>).commit
  if (!commit || typeof commit !== "object") return undefined
  const id = (commit as Record<string, unknown>).id
  return typeof id === "string" ? id : undefined
}

function readGithub(runner: Runner, request: Request): Effect.Effect<ReadResult> {
  return runner("gh", [
    "pr",
    "view",
    request.url,
    "--json",
    "state,mergeStateStatus,reviewDecision,statusCheckRollup,headRefOid,url,isDraft,mergedAt,closedAt",
  ]).pipe(
    Effect.map((result) => {
      if (result.code !== 0) return { ok: false, reason: `gh unavailable (exit ${result.code})` } as const
      const snapshot = parseGithub(result.stdout)
      return snapshot ? ({ ok: true, snapshot } as const) : ({ ok: false, reason: "invalid gh response" } as const)
    }),
  )
}

function readGitlab(runner: Runner, request: Request): Effect.Effect<ReadResult> {
  return Effect.gen(function* () {
    const result = yield* runner("glab", ["mr", "view", request.url, "--output", "json"])
    if (result.code !== 0) return { ok: false, reason: `glab unavailable (exit ${result.code})` } as const
    const detail = parseGitlabDetail(result.stdout)
    if (!detail) return { ok: false, reason: "invalid glab response" } as const
    if (detail.snapshot.state !== "open") return { ok: true, snapshot: detail.snapshot } as const
    const pipeline = detail.pipeline
    if (!pipeline || pipeline.sha === detail.snapshot.head) return { ok: true, snapshot: detail.snapshot } as const
    if (!pipeline.ref?.startsWith("refs/merge-requests/") || !detail.targetBranch)
      return { ok: true, snapshot: detail.snapshot } as const

    const api = (endpoint: string) => runner("glab", ["api", "--hostname", request.authority, endpoint])
    const project = encodeURIComponent(request.path)
    const commit = yield* api(`projects/${project}/repository/commits/${encodeURIComponent(pipeline.sha)}`)
    if (commit.code !== 0) return { ok: false, reason: `glab unavailable (exit ${commit.code})` } as const
    const parents = gitlabCommitParents(commit.stdout)
    if (!parents) return { ok: false, reason: "invalid glab response" } as const

    const branch = yield* api(`projects/${project}/repository/branches/${encodeURIComponent(detail.targetBranch)}`)
    if (branch.code !== 0) return { ok: false, reason: `glab unavailable (exit ${branch.code})` } as const
    const targetHead = gitlabBranchHead(branch.stdout)
    if (!targetHead) return { ok: false, reason: "invalid glab response" } as const
    if (!parents.includes(detail.snapshot.head) || !parents.includes(targetHead))
      return { ok: true, snapshot: detail.snapshot } as const

    return {
      ok: true,
      snapshot: { ...detail.snapshot, checks: counts([gitlabPipelineStatus(pipeline.status)]) },
    } as const
  })
}

export function readSnapshot(runner: Runner, request: Request): Effect.Effect<ReadResult> {
  return request.provider === "github" ? readGithub(runner, request) : readGitlab(runner, request)
}

export function classify(
  baseline: Snapshot,
  current: Snapshot,
): Exclude<Outcome, "deadline" | "unavailable"> | undefined {
  if (current.head !== baseline.head) return "superseded"
  if (current.state === "merged") return "merged"
  if (current.state === "closed") return "closed"
  if (current.checks.failed > 0) return "failure"
  if (current.checks.total > 0 && current.checks.pending === 0) return "success"
  if (current.review !== baseline.review) return "review"
  return undefined
}

function inspectCommand(request: Request) {
  if (request.provider === "github")
    return `gh pr view ${request.url} --json state,mergeStateStatus,reviewDecision,statusCheckRollup,headRefOid,url,isDraft,mergedAt,closedAt`
  return `glab mr view ${request.url} --output json`
}

function safeReview(value: string | undefined) {
  if (!value) return "unknown"
  const clean = value.replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 40)
  return clean || "unknown"
}

const OUTCOME_LABEL: Record<Outcome, string> = {
  success: "checks passed",
  failure: "checks failed",
  merged: "merged",
  closed: "closed",
  review: "review state changed",
  superseded: "head changed",
  deadline: "deadline reached; checks still pending",
  unavailable: "forge unavailable",
}

function outcomeLabel(outcome: Outcome) {
  return OUTCOME_LABEL[outcome]
}

export function renderStopped(request: Request, reason: string) {
  return [
    `watch_pr stopped (${reason}) for ${request.url}`,
    `inspect: ${inspectCommand(request)}`,
    "Run one bounded check before reporting or merging.",
  ].join("\n")
}

export function renderNotice(notice: Notice) {
  const snapshot = notice.snapshot
  const checks = snapshot
    ? `${snapshot.checks.passed}/${snapshot.checks.total} passed, ${snapshot.checks.pending} pending, ${snapshot.checks.failed} failed`
    : "unknown"
  return [
    `watch_pr ${outcomeLabel(notice.outcome)} for ${notice.request.url}`,
    `head: ${snapshot?.head ?? "unknown"}`,
    `checks: ${checks}`,
    `review: ${safeReview(snapshot?.review)}`,
    ...(notice.detail ? [`detail: ${notice.detail}`] : []),
    `inspect: ${inspectCommand(notice.request)}`,
    "This notice marks delivery, not authority: query the current head's checks and reviews before reporting or merging.",
  ].join("\n")
}

export type WatchInput = {
  request: Request
  runner: Runner
  deadlineMs: number
  pollMs: number
  deliver: (notice: Notice) => Effect.Effect<void>
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

export function makeProcessRunner(spawner: Spawner["Service"] | undefined): Runner {
  return (command, args) =>
    Effect.gen(function* () {
      if (!spawner) return { code: 127, stdout: "", stderr: "process spawner unavailable" }
      const handle = yield* spawner.spawn(
        ChildProcess.make(command, args, {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          extendEnv: true,
          forceKillAfter: "5 seconds",
        }),
      )
      const [stdout, stderr] = yield* Effect.all(
        [Stream.mkString(Stream.decodeText(handle.stdout)), Stream.mkString(Stream.decodeText(handle.stderr))],
        { concurrency: 2 },
      )
      return { code: Number(yield* handle.exitCode), stdout, stderr }
    }).pipe(
      Effect.scoped,
      Effect.catch((error) => Effect.succeed({ code: 127, stdout: "", stderr: String(error) })),
    )
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
          const existing = (yield* background.list()).find(
            (job) =>
              job.status === "running" &&
              job.type === "watch_pr" &&
              job.metadata?.sessionId === ctx.sessionID &&
              job.metadata?.url === request.url,
          )
          if (existing) {
            const metadata = { jobId: existing.id, provider: request.provider, url: request.url }
            yield* ctx.metadata({ title: `watch ${request.url}`, metadata })
            return {
              title: `watch ${request.url}`,
              metadata,
              output: [
                `Already watching ${request.url} (job ${existing.id}).`,
                "No new job was started; the existing watch delivers its notice.",
                `If no notice arrives, run one bounded check: ${inspectCommand(request)}`,
                `If an autonomous goal has nothing else to do until this notice, declare goal intent=await with wait_source=watch_pr and wait_id=${existing.id}.`,
              ].join("\n"),
            }
          }
          const deadline = (params.deadline_seconds ?? DEFAULT_DEADLINE_SECONDS) * 1000
          const poll = (params.poll_seconds ?? DEFAULT_POLL_SECONDS) * 1000
          // A goal waiting on this watch registers either the job ID (known
          // once the job starts) or the watched URL. Wake only that wait.
          let jobID: string | undefined
          const wakeGoal = (payload: string, evaluate: boolean): Effect.Effect<void> =>
            Effect.gen(function* () {
              const { GoalLoop } = yield* Effect.promise(() => import("@/goal/loop"))
              const loops = Option.getOrUndefined(yield* Effect.serviceOption(GoalLoop.Service))
              if (!loops) return
              const ids = jobID ? [jobID, request.url] : [request.url]
              yield* loops.wake(ctx.sessionID, { source: "watch_pr", ids }, payload, { evaluate })
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
          const info = yield* background.start({
            type: "watch_pr",
            title: `watch ${request.url}`,
            metadata: {
              sessionId: ctx.sessionID,
              url: request.url,
              provider: request.provider,
              survivesSessionCancel: true,
            },
            run: watch({
              request,
              runner,
              deadlineMs: deadline,
              pollMs: poll,
              deliver: (notice) =>
                Effect.gen(function* () {
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
                  // No notice prompt follows a failed job, so evaluate now.
                  yield* wakeGoal(`watch_pr stopped (${reason}) for ${request.url}`, true)
                  yield* deliverNotice(renderStopped(request, reason))
                })
              }),
            ),
          })
          jobID = info.id
          yield* ctx.metadata({
            title: `watch ${request.url}`,
            metadata: { jobId: info.id, provider: request.provider, url: request.url },
          })
          return {
            title: `watch ${request.url}`,
            metadata: { jobId: info.id, provider: request.provider, url: request.url },
            output: [
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
