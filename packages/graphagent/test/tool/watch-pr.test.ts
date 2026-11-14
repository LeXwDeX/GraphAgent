// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { isTerminalValue } from "@graphagent/core/lifecycle/vocabulary"
import { Agent } from "@/agent/agent"
import { MessageID, SessionID } from "@/session/schema"
import { PrWatchPoller } from "@/pr-watch/poller"
import { Truncate } from "@/tool/truncate"
import {
  makeProcessRunner,
  parseGithub,
  parseGitlab,
  parseRequest,
  readSnapshot,
  renderNotice,
  WatchPrTool,
  type Runner,
  type Snapshot,
} from "../../src/tool/watch_pr"
import { Parameters as WatchPrParameters } from "../../src/tool/watch_pr"
import { it, testEffect } from "../lib/effect"

/**
 * #1071 PR4: the `watch_pr` tool manages durable watches through the
 * process-level poller. These tests pin the tool contract (register/query/
 * cancel, the StateRef it returns, head-change replacement and reuse) against a
 * recording poller; the durable rows themselves are covered in test/pr-watch.
 */

const githubRequest = parseRequest("https://github.com/acme/widgets/pull/42", new Set(["github.com"]))
const gitlabRequest = parseRequest("https://gitlab.com/acme/widgets/-/merge_requests/7", new Set(["gitlab.com"]))

const snapshot = (input: Partial<Snapshot> & Pick<Snapshot, "head">): Snapshot => ({
  state: "open",
  review: "NONE",
  checks: { total: 1, pending: 1, failed: 0, passed: 0 },
  ...input,
})

const githubResult = (value: Snapshot): { code: number; stdout: string; stderr: string } => ({
  code: 0,
  stdout: JSON.stringify({
    state: value.state === "merged" ? "MERGED" : value.state === "closed" ? "CLOSED" : "OPEN",
    headRefOid: value.head,
    reviewDecision: value.review,
    statusCheckRollup: [
      ...Array.from({ length: value.checks.passed }, () => ({
        __typename: "CheckRun",
        status: "COMPLETED",
        conclusion: "SUCCESS",
      })),
      ...Array.from({ length: value.checks.pending }, () => ({ __typename: "CheckRun", status: "IN_PROGRESS" })),
      ...Array.from({ length: value.checks.failed }, () => ({
        __typename: "CheckRun",
        status: "COMPLETED",
        conclusion: "FAILURE",
      })),
    ],
  }),
  stderr: "",
})

describe("watch_pr request parsing", () => {
  test("normalizes GitHub pull request URLs", () => {
    expect(parseRequest("https://github.com/acme/widgets/pull/42/", new Set(["github.com"]))).toEqual(githubRequest)
    expect(githubRequest).toEqual({
      provider: "github",
      host: "github.com",
      authority: "github.com",
      url: "https://github.com/acme/widgets/pull/42",
      number: 42,
      path: "acme/widgets",
    })
  })

  test("normalizes GitLab merge request URLs, including nested groups", () => {
    expect(
      parseRequest("https://gitlab.com/acme/platform/widgets/-/merge_requests/7", new Set(["gitlab.com"])),
    ).toEqual({
      provider: "gitlab",
      host: "gitlab.com",
      authority: "gitlab.com",
      url: "https://gitlab.com/acme/platform/widgets/-/merge_requests/7",
      number: 7,
      path: "acme/platform/widgets",
    })
    expect(gitlabRequest.number).toBe(7)
  })

  test("accepts an explicitly allowed self-hosted host and keeps its port", () => {
    expect(
      parseRequest("https://gitlab.example.com:8443/acme/widgets/-/merge_requests/3", new Set(["gitlab.example.com"])),
    ).toMatchObject({
      provider: "gitlab",
      host: "gitlab.example.com",
      authority: "gitlab.example.com:8443",
      url: "https://gitlab.example.com:8443/acme/widgets/-/merge_requests/3",
    })
  })

  test("rejects unlisted hosts, credentials, insecure URLs and non-request paths", () => {
    const hosts = new Set(["github.com", "gitlab.com"])
    expect(() => parseRequest("https://evil.example.com/acme/widgets/pull/1", hosts)).toThrow("not allowed")
    expect(() => parseRequest("https://user:pass@github.com/acme/widgets/pull/1", hosts)).toThrow("credentials")
    expect(() => parseRequest("http://github.com/acme/widgets/pull/1", hosts)).toThrow("https")
    expect(() => parseRequest("https://github.com/acme/widgets/issues/1", hosts)).toThrow("only GitHub")
    expect(() => parseRequest("https://gitlab.com/widgets/-/merge_requests/1", hosts)).toThrow("only GitHub")
  })
})

describe("watch_pr response mapping", () => {
  test("maps GitHub checks, review and state", () => {
    const parsed = parseGithub(
      JSON.stringify({
        state: "OPEN",
        headRefOid: "abc123",
        reviewDecision: "REVIEW_REQUIRED",
        statusCheckRollup: [
          { __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" },
          { __typename: "StatusContext", state: "PENDING" },
          { __typename: "CheckRun", status: "COMPLETED", conclusion: "FAILURE" },
        ],
      }),
    )
    expect(parsed).toEqual({
      state: "open",
      head: "abc123",
      review: "REVIEW_REQUIRED",
      checks: { total: 3, pending: 1, failed: 1, passed: 1 },
    })
  })

  test("maps GitLab pipeline and merge status", () => {
    const parsed = parseGitlab(
      JSON.stringify({
        state: "opened",
        diff_refs: { head_sha: "def456" },
        detailed_merge_status: "checking",
        head_pipeline: { status: "running", sha: "def456" },
      }),
    )
    expect(parsed).toEqual({
      state: "open",
      head: "def456",
      review: "checking",
      checks: { total: 1, pending: 1, failed: 0, passed: 0 },
    })
  })

  test("does not attribute a stale pipeline to a newer head", () => {
    const parsed = parseGitlab(
      JSON.stringify({
        state: "opened",
        diff_refs: { head_sha: "new" },
        merge_commit_sha: "merge-new",
        detailed_merge_status: "checking",
        head_pipeline: { status: "success", sha: "old" },
      }),
    )
    expect(parsed?.checks).toEqual({ total: 0, pending: 0, failed: 0, passed: 0 })
  })

  it.effect("accepts a merged-results pipeline after verifying its parents", () =>
    Effect.gen(function* () {
      const result = yield* readSnapshot((command, args) => {
        if (command !== "glab") return Effect.die("unexpected command")
        if (args[0] === "mr")
          return Effect.succeed({
            code: 0,
            stdout: JSON.stringify({
              state: "opened",
              diff_refs: { head_sha: "new" },
              detailed_merge_status: "checking",
              target_branch: "main",
              head_pipeline: { status: "success", sha: "merge-new", ref: "refs/merge-requests/7/merge" },
            }),
            stderr: "",
          })
        if (args[0] !== "api" || args[1] !== "--hostname" || args[2] !== "gitlab.com")
          return Effect.die("api call lost its host")
        if (args[3]?.includes("/commits/"))
          return Effect.succeed({
            code: 0,
            stdout: JSON.stringify({ parent_ids: ["target", "new"] }),
            stderr: "",
          })
        if (args[3]?.includes("/branches/"))
          return Effect.succeed({ code: 0, stdout: JSON.stringify({ commit: { id: "target" } }), stderr: "" })
        return Effect.die("unexpected api call")
      }, gitlabRequest)
      expect(result).toEqual({
        ok: true,
        snapshot: {
          state: "open",
          head: "new",
          review: "checking",
          checks: { total: 1, pending: 0, failed: 0, passed: 1 },
        },
      })
    }),
  )

  it.effect("rejects a merged-results pipeline whose parents do not include the current head", () =>
    Effect.gen(function* () {
      const result = yield* readSnapshot((command, args) => {
        if (command !== "glab") return Effect.die("unexpected command")
        if (args[0] === "mr")
          return Effect.succeed({
            code: 0,
            stdout: JSON.stringify({
              state: "opened",
              diff_refs: { head_sha: "new" },
              detailed_merge_status: "checking",
              target_branch: "main",
              head_pipeline: { status: "success", sha: "old-merge", ref: "refs/merge-requests/7/merge" },
            }),
            stderr: "",
          })
        if (args[0] !== "api" || args[1] !== "--hostname" || args[2] !== "gitlab.com")
          return Effect.die("api call lost its host")
        if (args[3]?.includes("/commits/"))
          return Effect.succeed({
            code: 0,
            stdout: JSON.stringify({ parent_ids: ["target", "old"] }),
            stderr: "",
          })
        if (args[3]?.includes("/branches/"))
          return Effect.succeed({ code: 0, stdout: JSON.stringify({ commit: { id: "target" } }), stderr: "" })
        return Effect.die("unexpected api call")
      }, gitlabRequest)
      expect(result).toMatchObject({ ok: true, snapshot: { checks: { total: 0, pending: 0, failed: 0, passed: 0 } } })
    }),
  )

  it.effect("returns a closed MR without extra pipeline queries", () =>
    Effect.gen(function* () {
      let calls = 0
      const result = yield* readSnapshot((command, args) => {
        calls++
        if (command !== "glab" || args[0] !== "mr") return Effect.die("unexpected api call")
        return Effect.succeed({
          code: 0,
          stdout: JSON.stringify({
            state: "closed",
            diff_refs: { head_sha: "new" },
            target_branch: "main",
            head_pipeline: { status: "failed", sha: "merge-new", ref: "refs/merge-requests/7/merge" },
          }),
          stderr: "",
        })
      }, gitlabRequest)
      expect(calls).toBe(1)
      expect(result).toMatchObject({ ok: true, snapshot: { state: "closed" } })
    }),
  )

  it.effect("binds merged-results API calls to the request host and port", () =>
    Effect.gen(function* () {
      const request = parseRequest(
        "https://gitlab.example.com:8443/acme/widgets/-/merge_requests/3",
        new Set(["gitlab.example.com"]),
      )
      const hosts: string[] = []
      const result = yield* readSnapshot((command, args) => {
        if (command !== "glab") return Effect.die("unexpected command")
        if (args[0] === "mr")
          return Effect.succeed({
            code: 0,
            stdout: JSON.stringify({
              state: "opened",
              diff_refs: { head_sha: "new" },
              detailed_merge_status: "checking",
              target_branch: "main",
              head_pipeline: { status: "success", sha: "merge-new", ref: "refs/merge-requests/3/merge" },
            }),
            stderr: "",
          })
        if (args[0] !== "api" || args[1] !== "--hostname") return Effect.die("api call lost its host")
        if (args[2]) hosts.push(args[2])
        if (args[3]?.includes("/commits/"))
          return Effect.succeed({
            code: 0,
            stdout: JSON.stringify({ parent_ids: ["new", "target"] }),
            stderr: "",
          })
        if (args[3]?.includes("/branches/"))
          return Effect.succeed({ code: 0, stdout: JSON.stringify({ commit: { id: "target" } }), stderr: "" })
        return Effect.die("unexpected api call")
      }, request)
      expect(hosts).toEqual(["gitlab.example.com:8443", "gitlab.example.com:8443"])
      expect(result).toMatchObject({ ok: true, snapshot: { checks: { total: 1, passed: 1 } } })
    }),
  )

  test("rejects invalid forge output", () => {
    expect(parseGithub("not json")).toBeUndefined()
    expect(parseGithub(JSON.stringify({ state: "OPEN" }))).toBeUndefined()
    expect(parseGitlab(JSON.stringify({ state: "opened" }))).toBeUndefined()
  })
})

describe("watch_pr notice rendering", () => {
  test("renders bounded status without copying review text", () => {
    const text = renderNotice({
      outcome: "failure",
      request: githubRequest,
      snapshot: snapshot({
        head: "abc123",
        review: "CHANGES_REQUESTED\nuntrusted text",
        checks: { total: 2, pending: 0, failed: 1, passed: 1 },
      }),
    })
    expect(text).toContain("watch_pr checks failed for https://github.com/acme/widgets/pull/42")
    expect(text).toContain("checks: 1/2 passed, 0 pending, 1 failed")
    expect(text).toContain("review: CHANGES_REQUESTEDuntrustedtext")
    expect(text).toContain("inspect: gh pr view")
    expect(text).toContain("delivery, not authority")
    expect(text).not.toContain("\nuntrusted text")
  })
})

type Params = Schema.Schema.Type<typeof WatchPrParameters>
type WatchInfo = PrWatchPoller.WatchInfo

const summary = {
  sessionID: SessionID.make("ses_watch_pr"),
  messageID: MessageID.make("msg_watch_pr"),
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const watch = ({ id, url, ...rest }: Partial<WatchInfo> & { id: string; url?: string }): WatchInfo => ({
  id,
  url: url ?? githubRequest.url,
  phase: "watching",
  head: null,
  outcome: null,
  deadlineAt: Date.now() + 600_000,
  delivery: null,
  ...rest,
})

const harness = (seed: ReadonlyArray<WatchInfo> = []) => {
  let watches = [...seed]
  const registered: PrWatchPoller.RegisterInput[] = []
  const cancelled: string[] = []
  let sequence = 0
  const service: PrWatchPoller.Interface = {
    register: (input) =>
      Effect.sync(() => {
        registered.push(input)
        const existing = watches.find((row) => row.url === input.request.url)
        if (existing && !isTerminalValue("pr_watch", existing.phase)) return { id: existing.id, created: false }
        sequence += 1
        const id = `watch_${sequence}`
        watches = [
          ...watches.filter((row) => row.url !== input.request.url),
          watch({ id, url: input.request.url, head: input.head ?? null }),
        ]
        return { id, created: true }
      }),
    query: ({ ref }) =>
      Effect.sync(() =>
        ref === undefined
          ? watches.filter((row) => !isTerminalValue("pr_watch", row.phase))
          : watches.filter((row) => row.id === ref || row.url === ref),
      ),
    cancel: ({ ref }) =>
      Effect.sync(() => {
        const found = watches.find((row) => row.id === ref || row.url === ref)
        if (!found || isTerminalValue("pr_watch", found.phase)) return undefined
        cancelled.push(found.id)
        const next = { ...found, phase: "cancelled" }
        watches = watches.map((row) => (row.id === found.id ? next : row))
        return next
      }),
    pollOnce: () => Effect.succeed(0),
    recoverOnce: () => Effect.succeed(0),
    init: () => Effect.void,
  }
  return { registered, cancelled, layer: Layer.succeed(PrWatchPoller.Service, service) }
}

const execute = (h: ReturnType<typeof harness>, params: Params, runner?: Runner) =>
  Effect.gen(function* () {
    const tool = yield* (yield* WatchPrTool).init()
    return yield* tool
      .execute(params, {
        ...summary,
        extra: {
          watchPrRunner: runner ?? (() => Effect.succeed(githubResult(snapshot({ head: "a" })))),
        },
      })
      .pipe(Effect.provide(h.layer))
  })

describe("watch_pr tool", () => {
  // The Tool wrapper resolves Agent and Truncate after every execute, and
  // Agent.get needs an instance; `instance` supplies the tmpdir InstanceRef.
  const suite = testEffect(Layer.mergeAll(Truncate.defaultLayer, Agent.defaultLayer))
  const it = { effect: suite.instance }

  it.effect("registers a watch and returns its StateRef", () =>
    Effect.gen(function* () {
      const h = harness()
      const result = yield* execute(h, { action: "register", url: githubRequest.url })
      expect(result.output).toContain("Started a durable watch (watch_1)")
      expect(result.metadata).toMatchObject({
        watchID: "watch_1",
        stateRef: { domain: "pr_watch", id: "watch_1" },
        provider: "github",
        url: githubRequest.url,
      })
      expect(h.registered).toHaveLength(1)
      expect(h.registered[0]).toMatchObject({
        sessionID: summary.sessionID,
        request: { url: githubRequest.url },
      })
    }),
  )

  it.effect("reuses a live watch for the same session and URL", () =>
    Effect.gen(function* () {
      const h = harness([watch({ id: "watch_existing", head: "aaa", deadlineAt: Date.now() + 90_000 })])
      const result = yield* execute(h, { action: "register", url: githubRequest.url }, () =>
        Effect.succeed(githubResult(snapshot({ head: "aaa" }))),
      )
      expect(result.output).toContain("Already watching")
      expect(result.output).toContain("head: aaa")
      expect(result.output).toMatch(/\d+s remaining/)
      expect(result.metadata).toMatchObject({ watchID: "watch_existing" })
      expect(h.registered).toHaveLength(0)
      expect(h.cancelled).toHaveLength(0)
    }),
  )

  it.effect("replaces a stale watch when the caller re-watches a newer head", () =>
    Effect.gen(function* () {
      const h = harness([watch({ id: "watch_existing", head: "aaa" })])
      const result = yield* execute(h, { action: "register", url: githubRequest.url }, () =>
        Effect.succeed(githubResult(snapshot({ head: "bbb" }))),
      )
      expect(h.cancelled).toEqual(["watch_existing"])
      expect(h.registered).toHaveLength(1)
      // The replacement follows the head the caller just observed.
      expect(h.registered[0]).toMatchObject({ head: "bbb" })
      expect(result.output).toContain("Replaced watch watch_existing")
      expect(result.output).toContain("watched head aaa")
      expect(result.output).toContain("current head bbb")
      expect(result.metadata).toMatchObject({ watchID: "watch_1" })
    }),
  )

  it.effect("does not compete with a watch whose notice is being delivered", () =>
    Effect.gen(function* () {
      const h = harness([watch({ id: "watch_delivering", phase: "delivering", outcome: "success" })])
      const result = yield* execute(h, { action: "register", url: githubRequest.url })
      expect(result.output).toContain("already observed its outcome (success)")
      expect(h.registered).toHaveLength(0)
      expect(result.metadata).toMatchObject({ watchID: "watch_delivering" })
    }),
  )

  it.effect("replaces a terminal row for the same URL", () =>
    Effect.gen(function* () {
      const h = harness([watch({ id: "watch_old", phase: "succeeded", outcome: "success" })])
      const result = yield* execute(h, { action: "register", url: githubRequest.url })
      expect(h.registered).toHaveLength(1)
      expect(result.output).toContain("Started a durable watch (watch_1)")
    }),
  )

  it.effect("queries one watch by id or URL and lists live watches", () =>
    Effect.gen(function* () {
      const h = harness([
        watch({ id: "watch_live", head: "aaa" }),
        watch({ id: "watch_done", phase: "succeeded", outcome: "success" }),
      ])
      const listed = yield* execute(h, { action: "query" })
      expect(listed.output).toContain("watch_live")
      expect(listed.output).not.toContain("watch_done")
      const one = yield* execute(h, { action: "query", watch_id: "watch_done" })
      expect(one.output).toContain("state: succeeded")
      expect(one.output).toContain("outcome: success")
    }),
  )

  it.effect("cancels a live watch and refuses a terminal one", () =>
    Effect.gen(function* () {
      const h = harness([watch({ id: "watch_live" })])
      const cancelled = yield* execute(h, { action: "cancel", watch_id: "watch_live" })
      expect(cancelled.output).toContain("Cancelled watch watch_live")
      expect(h.cancelled).toEqual(["watch_live"])

      const missing = yield* execute(h, { action: "cancel", watch_id: "watch_missing" })
      expect(missing.output).toContain("No watch matches")

      const done = harness([watch({ id: "watch_done", phase: "succeeded" })])
      const refused = yield* execute(done, { action: "cancel", watch_id: "watch_done" })
      expect(refused.output).toContain("already ended (succeeded)")
      expect(done.cancelled).toHaveLength(0)
    }),
  )

  it.effect("rejects register without a URL", () =>
    Effect.gen(function* () {
      const exit = yield* execute(harness(), { action: "register" }).pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
    }),
  )

  it.effect("reports a missing spawner as an unavailable runner", () =>
    Effect.gen(function* () {
      const result = yield* makeProcessRunner(undefined)("gh", ["pr", "view", githubRequest.url])
      expect(result.code).toBe(127)
    }),
  )
})