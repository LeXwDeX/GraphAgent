// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/* oxlint-disable typescript-eslint/no-unsafe-type-assertion -- JSON responses are untyped boundaries */

import { Effect, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import type { ChildProcessSpawner as Spawner } from "effect/process/ChildProcessSpawner"

/**
 * Forge access for PR/MR watches (#1071): URL parsing, bounded `gh`/`glab`
 * reads, snapshot classification and notice rendering. Pure functions only —
 * the process-level poller (pr-watch/poller.ts) and the `watch_pr` tool's head
 * check share them, so both observe the same forge the same way.
 */

export type Provider = "github" | "gitlab"
export type Outcome = "success" | "failure" | "merged" | "closed" | "review" | "deadline"

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
  /** The followed head when the notice is rendered from a durable row that no longer carries the whole snapshot. */
  head?: string
  detail?: string
}

export const DEFAULT_DEADLINE_SECONDS = 1800
export const DEFAULT_POLL_SECONDS = 15
export const MIN_DEADLINE_SECONDS = 10
export const MAX_DEADLINE_SECONDS = 3600
export const MIN_POLL_SECONDS = 5
export const MAX_POLL_SECONDS = 300

// One bounded forge read is allowed before reusing an existing watch, so a
// re-watch after a head change replaces the stale watch instead of being
// deduplicated away. A slow or unavailable forge falls back to reuse.
export const HEAD_CHECK_TIMEOUT_MS = 15_000

const GITHUB_HOSTS = ["github.com"]
const GITLAB_HOSTS = ["gitlab.com"]

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

/** The only baseline a poll decision reads: which commit and which review state the watch follows. */
export type Baseline = Pick<Snapshot, "head" | "review">

export type PollDecision =
  | { readonly kind: "observe"; readonly outcome: Exclude<Outcome, "deadline"> }
  | { readonly kind: "rebaseline"; readonly head: string; readonly review: string }
  | { readonly kind: "continue" }

/**
 * Poller classification (#1071): a head change is not terminal. The caller
 * rebaselines the durable row onto the new head and keeps watching, so a push
 * to the PR does not silently orphan the watch.
 *
 * Merge/close wins over a head change: a PR merged on top of new commits is
 * done, not merely rebaselined. A rebaseline deliberately reports no outcome
 * on the snapshot that carried the change — the following poll evaluates the
 * new head's checks and review against the new baseline.
 */
export function classifyPoll(baseline: Baseline, current: Snapshot): PollDecision {
  if (current.state === "merged") return { kind: "observe", outcome: "merged" }
  if (current.state === "closed") return { kind: "observe", outcome: "closed" }
  if (current.head !== baseline.head) return { kind: "rebaseline", head: current.head, review: current.review }
  if (current.checks.failed > 0) return { kind: "observe", outcome: "failure" }
  if (current.checks.total > 0 && current.checks.pending === 0) return { kind: "observe", outcome: "success" }
  if (current.review !== baseline.review) return { kind: "observe", outcome: "review" }
  return { kind: "continue" }
}

export function inspectCommand(request: Request) {
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
  deadline: "deadline reached; checks still pending",
}

function outcomeLabel(outcome: Outcome) {
  return OUTCOME_LABEL[outcome]
}

export function renderNotice(notice: Notice) {
  const snapshot = notice.snapshot
  const checks = snapshot
    ? `${snapshot.checks.passed}/${snapshot.checks.total} passed, ${snapshot.checks.pending} pending, ${snapshot.checks.failed} failed`
    : "unknown"
  return [
    `watch_pr ${outcomeLabel(notice.outcome)} for ${notice.request.url}`,
    `head: ${snapshot?.head ?? notice.head ?? "unknown"}`,
    `checks: ${checks}`,
    `review: ${safeReview(snapshot?.review)}`,
    ...(notice.detail ? [`detail: ${notice.detail}`] : []),
    `inspect: ${inspectCommand(notice.request)}`,
    "This notice marks delivery, not authority: query the current head's checks and reviews before reporting or merging.",
  ].join("\n")
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