// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { Deferred, Duration, Effect, Fiber, Layer, Ref, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import * as TestClock from "effect/testing/TestClock"
import { ProjectV2 } from "@graphagent/core/project"
import { Agent } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Session } from "@/session/session"
import { NotFoundError } from "@/storage/storage"
import { SessionCancellation } from "@/session/cancellation"
import { MessageID, SessionID } from "@/session/schema"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import type { SessionV1 } from "@graphagent/core/v1/session"
import {
  classify,
  makeProcessRunner,
  parseGithub,
  parseGitlab,
  parseRequest,
  readSnapshot,
  renderNotice,
  watch,
  WatchPrTool,
  type Notice,
  type Runner,
  type Snapshot,
} from "../../src/tool/watch_pr"
import { it, testEffect } from "../lib/effect"
import type { TaskPromptOps } from "../../src/tool/task"
import { GoalLoop } from "@/goal/loop"

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

const sequenceRunner = (
  sequence: Array<{ code: number; stdout: string; stderr: string }>,
  started?: Deferred.Deferred<void>,
): Runner => {
  let index = 0
  return () =>
    Effect.suspend(() => {
      const result = sequence[Math.min(index, sequence.length - 1)]
      index++
      if (index === 1 && started) {
        return Deferred.succeed(started, undefined).pipe(Effect.as(result))
      }
      return Effect.succeed(result)
    })
}

const collect = (delivered: Ref.Ref<Notice[]>) => (notice: Notice) =>
  Ref.update(delivered, (items) => [...items, notice])

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

describe("watch_pr classification", () => {
  test("prefers head changes over every other transition", () => {
    expect(classify(snapshot({ head: "a" }), snapshot({ head: "b", state: "merged" }))).toBe("superseded")
  })

  test("classifies merge, close, failure, success and review changes", () => {
    const baseline = snapshot({ head: "a" })
    expect(classify(baseline, snapshot({ head: "a", state: "merged" }))).toBe("merged")
    expect(classify(baseline, snapshot({ head: "a", state: "closed" }))).toBe("closed")
    expect(classify(baseline, snapshot({ head: "a", checks: { total: 1, pending: 0, failed: 1, passed: 0 } }))).toBe(
      "failure",
    )
    expect(classify(baseline, snapshot({ head: "a", checks: { total: 1, pending: 0, failed: 0, passed: 1 } }))).toBe(
      "success",
    )
    expect(classify(baseline, snapshot({ head: "a", review: "APPROVED" }))).toBe("review")
    expect(classify(baseline, baseline)).toBeUndefined()
  })

  test("does not treat a missing check rollup as success", () => {
    expect(
      classify(
        snapshot({ head: "a", checks: { total: 0, pending: 0, failed: 0, passed: 0 } }),
        snapshot({ head: "a", checks: { total: 0, pending: 0, failed: 0, passed: 0 } }),
      ),
    ).toBeUndefined()
  })
})

describe("watch_pr watch loop", () => {
  it.effect("delivers one success notice after checks settle", () =>
    Effect.gen(function* () {
      const delivered = yield* Ref.make<Notice[]>([])
      const started = yield* Deferred.make<void>()
      const runner = sequenceRunner(
        [
          githubResult(snapshot({ head: "a" })),
          githubResult(snapshot({ head: "a", checks: { total: 2, pending: 0, failed: 0, passed: 2 } })),
        ],
        started,
      )
      const fiber = yield* watch({
        request: githubRequest,
        runner,
        deadlineMs: 10_000,
        pollMs: 1_000,
        deliver: collect(delivered),
      }).pipe(Effect.forkChild)
      yield* Deferred.await(started)
      yield* TestClock.adjust(Duration.seconds(1))
      const notice = yield* Fiber.join(fiber)
      expect(notice.outcome).toBe("success")
      expect(yield* Ref.get(delivered)).toHaveLength(1)
    }),
  )

  it.effect("delivers a deadline notice when checks stay pending", () =>
    Effect.gen(function* () {
      const delivered = yield* Ref.make<Notice[]>([])
      const started = yield* Deferred.make<void>()
      const fiber = yield* watch({
        request: githubRequest,
        runner: sequenceRunner([githubResult(snapshot({ head: "a" }))], started),
        deadlineMs: 5_000,
        pollMs: 1_000,
        deliver: collect(delivered),
      }).pipe(Effect.forkChild)
      yield* Deferred.await(started)
      yield* TestClock.adjust(Duration.seconds(6))
      expect(yield* Fiber.join(fiber)).toMatchObject({ outcome: "deadline" })
      expect(yield* Ref.get(delivered)).toHaveLength(1)
    }),
  )

  it.effect("times out a hung forge query at the deadline", () =>
    Effect.gen(function* () {
      const delivered = yield* Ref.make<Notice[]>([])
      const fiber = yield* watch({
        request: githubRequest,
        runner: () => Effect.never,
        deadlineMs: 5_000,
        pollMs: 1_000,
        deliver: collect(delivered),
      }).pipe(Effect.forkChild)
      yield* TestClock.adjust(Duration.seconds(6))
      expect(yield* Fiber.join(fiber)).toMatchObject({
        outcome: "deadline",
        detail: "deadline reached while querying the forge",
      })
      expect(yield* Ref.get(delivered)).toHaveLength(1)
    }),
  )

  it.effect("reports a changed head as superseded", () =>
    Effect.gen(function* () {
      const delivered = yield* Ref.make<Notice[]>([])
      const started = yield* Deferred.make<void>()
      const fiber = yield* watch({
        request: githubRequest,
        runner: sequenceRunner([githubResult(snapshot({ head: "a" })), githubResult(snapshot({ head: "b" }))], started),
        deadlineMs: 10_000,
        pollMs: 1_000,
        deliver: collect(delivered),
      }).pipe(Effect.forkChild)
      yield* Deferred.await(started)
      yield* TestClock.adjust(Duration.seconds(1))
      const notice = yield* Fiber.join(fiber)
      expect(notice.outcome).toBe("superseded")
      expect(notice.detail).toContain("b")
      expect(yield* Ref.get(delivered)).toHaveLength(1)
    }),
  )

  it.effect("reports an unavailable forge on the first read", () =>
    Effect.gen(function* () {
      const delivered = yield* Ref.make<Notice[]>([])
      const notice = yield* watch({
        request: githubRequest,
        runner: () => Effect.succeed({ code: 127, stdout: "", stderr: "not found" }),
        deadlineMs: 10_000,
        pollMs: 1_000,
        deliver: collect(delivered),
      })
      expect(notice).toMatchObject({ outcome: "unavailable", detail: "gh unavailable (exit 127)" })
      expect(yield* Ref.get(delivered)).toHaveLength(1)
    }),
  )

  it.effect("interrupts without delivering when the session is cancelled", () =>
    Effect.gen(function* () {
      const delivered = yield* Ref.make<Notice[]>([])
      const started = yield* Deferred.make<void>()
      const fiber = yield* watch({
        request: githubRequest,
        runner: sequenceRunner([githubResult(snapshot({ head: "a" }))], started),
        deadlineMs: 10_000,
        pollMs: 1_000,
        deliver: collect(delivered),
      }).pipe(Effect.forkChild)
      yield* Deferred.await(started)
      yield* Fiber.interrupt(fiber)
      expect(yield* Ref.get(delivered)).toHaveLength(0)
    }),
  )
})

describe("watch_pr notice and tool", () => {
  it.effect("bounds a real process runner kill and works without an ambient spawner service", () =>
    Effect.gen(function* () {
      const encoder = new TextEncoder()
      let killAfter: unknown
      const spawner = ChildProcessSpawner.make((command) => {
        const standard = ChildProcess.isStandardCommand(command) ? command : undefined
        killAfter = standard?.options?.forceKillAfter
        return Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(0),
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- fake sink fields are never used
            stdin: {} as any,
            stdout: Stream.make(encoder.encode('{"state":"OPEN","headRefOid":"a"}')),
            stderr: Stream.empty,
            all: Stream.empty,
            // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- fake fd getters are never used
            getInputFd: () => ({}) as any,
            getOutputFd: () => Stream.empty,
            unref: Effect.succeed(Effect.void),
          }),
        )
      })
      const result = yield* makeProcessRunner(spawner)("gh", ["pr", "view", githubRequest.url])
      expect(result.code).toBe(0)
      expect(killAfter).toBe("5 seconds")
      const missing = yield* makeProcessRunner(undefined)("gh", ["pr", "view", githubRequest.url])
      expect(missing.code).toBe(127)
    }),
  )

  test("renders bounded status without copying review text", () => {
    const notice: Notice = {
      outcome: "failure",
      request: githubRequest,
      snapshot: snapshot({
        head: "abc123",
        review: "CHANGES_REQUESTED\nuntrusted text",
        checks: { total: 2, pending: 0, failed: 1, passed: 1 },
      }),
    }
    const text = renderNotice(notice)
    expect(text).toContain("watch_pr checks failed for https://github.com/acme/widgets/pull/42")
    expect(text).toContain("checks: 1/2 passed, 0 pending, 1 failed")
    expect(text).toContain("review: CHANGES_REQUESTEDuntrustedtext")
    expect(text).toContain("inspect: gh pr view")
    expect(text).toContain("delivery, not authority")
    expect(text).not.toContain("\nuntrusted text")
  })

  const summary = {
    sessionID: SessionID.make("ses_watch_pr"),
    messageID: MessageID.make("msg_watch_pr"),
    agent: "build",
    abort: AbortSignal.any([]),
    messages: [],
    metadata: () => Effect.void,
    ask: () => Effect.void,
  }

  let sessionAgent: string | undefined = "build"
  const sessionInfo = (agent: string | undefined) =>
    ({
      id: summary.sessionID,
      slug: "watch-pr",
      projectID: ProjectV2.ID.global,
      directory: "/tmp",
      title: "watch_pr test",
      version: "1.0.0",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 0, updated: 0 },
      agent,
    }) satisfies Session.Info
  let sessionMessages: Array<{
    info: { role: "user" | "assistant"; time: { created: number }; error?: { name: string } }
    parts: []
  }> = []
  let sessionMissing = false
  const sessionLayer = Layer.mock(Session.Service, {
    get: () =>
      sessionMissing
        ? Effect.fail(new NotFoundError({ message: "session not found" }))
        : Effect.sync(() => sessionInfo(sessionAgent)),
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- test fixture narrows message history to the fields the watch reads
    messages: () => Effect.sync(() => sessionMessages as never),
  })

  const promptOps: TaskPromptOps = {
    cancel: () => Effect.void,
    resolvePromptParts: () => Effect.succeed([]),
    prompt: () => Effect.die("prompt is not used by this test"),
  }

  const started: BackgroundJob.StartInput[] = []
  const running: BackgroundJob.Info[] = []
  const cancelled: string[] = []
  const layer = Layer.mock(BackgroundJob.Service, {
    list: () => Effect.sync(() => running),
    cancel: (id) =>
      Effect.sync(() => {
        cancelled.push(id)
        const info = running.find((job) => job.id === id)
        if (info) info.status = "cancelled"
        return info
      }),
    start: (input) =>
      Effect.sync(() => {
        started.push(input)
        const info = {
          id: "job_test",
          type: input.type,
          status: "running",
          started_at: 0,
          metadata: input.metadata,
        } satisfies BackgroundJob.Info
        running.push(info)
        return info
      }),
  })
  const reset = () => {
    started.length = 0
    running.length = 0
    cancelled.length = 0
    sessionMessages = []
    sessionMissing = false
  }
  const withBackground = testEffect(Layer.mergeAll(layer, Truncate.defaultLayer, Agent.defaultLayer, sessionLayer))

  const withRealBackground = testEffect(BackgroundJob.defaultLayer)
  withBackground.instance("returns a job ID without waiting for the watch", () =>
    Effect.gen(function* () {
      const tool = yield* (yield* WatchPrTool).init()
      const result = yield* tool.execute({ url: "https://github.com/acme/widgets/pull/42" }, {
        ...summary,
        extra: {
          promptOps,
          watchPrRunner: (() => Effect.die("the mocked job does not run its effect")) as Runner,
        },
      } as Tool.Context)
      expect(result.output).toContain("job_test")
      expect(result.output).toContain("read-only background watch")
      expect(result.metadata).toMatchObject({ jobId: "job_test", provider: "github" })
      expect(started).toHaveLength(1)
      expect(started[0]?.metadata).toMatchObject({
        sessionId: "ses_watch_pr",
        url: "https://github.com/acme/widgets/pull/42",
        provider: "github",
        survivesSessionCancel: true,
      })
    }),
  )

  withBackground.instance("reuses a running watch for the same session and URL", () =>
    Effect.gen(function* () {
      reset()
      const deadlineAt = Date.now() + 90_000
      running.push({
        id: "job_existing",
        type: "watch_pr",
        status: "running",
        started_at: 0,
        metadata: { sessionId: summary.sessionID, url: githubRequest.url, provider: "github", head: "aaa", deadlineAt },
      })
      const tool = yield* (yield* WatchPrTool).init()
      const result = yield* tool.execute({ url: githubRequest.url }, {
        ...summary,
        extra: {
          promptOps,
          watchPrRunner: (() => Effect.succeed(githubResult(snapshot({ head: "aaa" })))) as Runner,
        },
      } as Tool.Context)
      expect(result.metadata).toMatchObject({ jobId: "job_existing", head: "aaa", deadlineAt })
      expect(result.output).toContain("Already watching")
      expect(result.output).toContain("head: aaa")
      expect(result.output).toContain(new Date(deadlineAt).toISOString())
      expect(result.output).toMatch(/\d+s remaining/)
      expect(started).toHaveLength(0)
      expect(cancelled).toHaveLength(0)
    }),
  )

  withBackground.instance("a re-watch after a head change cancels the stale watch and starts a new one", () =>
    Effect.gen(function* () {
      reset()
      running.push({
        id: "job_existing",
        type: "watch_pr",
        status: "running",
        started_at: 0,
        metadata: {
          sessionId: summary.sessionID,
          url: githubRequest.url,
          provider: "github",
          head: "aaa",
          deadlineAt: Date.now() + 90_000,
        },
      })
      const tool = yield* (yield* WatchPrTool).init()
      const result = yield* tool.execute({ url: githubRequest.url }, {
        ...summary,
        extra: {
          promptOps,
          watchPrRunner: (() => Effect.succeed(githubResult(snapshot({ head: "bbb" })))) as Runner,
        },
      } as Tool.Context)
      expect(cancelled).toEqual(["job_existing"])
      expect(started).toHaveLength(1)
      expect(result.metadata).toMatchObject({ jobId: "job_test" })
      expect(result.output).toContain("Replaced job job_existing")
      expect(result.output).toContain("watched head aaa")
      expect(result.output).toContain("current head bbb")
    }),
  )

  withBackground.instance("a re-watch from the terminal notice turn starts a new job", () =>
    Effect.gen(function* () {
      reset()
      const tool = yield* (yield* WatchPrTool).init()
      let rewatching = false
      let secondOutput: string | undefined
      yield* tool.execute({ url: githubRequest.url, deadline_seconds: 10, poll_seconds: 5 }, {
        ...summary,
        extra: {
          promptOps: {
            ...promptOps,
            prompt: () =>
              Effect.gen(function* () {
                if (rewatching) {
                  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- prompt acknowledgement is unused
                  return {} as unknown as SessionV1.WithParts
                }
                rewatching = true
                const again = yield* tool.execute({ url: githubRequest.url }, {
                  ...summary,
                  extra: {
                    promptOps,
                    watchPrRunner: (() => Effect.die("the re-watch is deduped or replaced without polling")) as Runner,
                  },
                } as Tool.Context)
                secondOutput = again.output
                // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- prompt acknowledgement is unused
                return {} as unknown as SessionV1.WithParts
              }),
          },
          watchPrRunner: (() => Effect.succeed(githubResult(snapshot({ head: "a" })))) as Runner,
        },
      } as Tool.Context)
      expect(started).toHaveLength(1)
      // The first job's terminal notice is being delivered while the registry
      // still reports it as running; the finishing marker must let the
      // re-watch start a replacement instead of being deduplicated away.
      const run = started[0]?.run
      if (!run) throw new Error("expected a started job")
      const fiber = yield* Effect.forkChild(run)
      yield* TestClock.adjust(Duration.seconds(11))
      yield* Fiber.join(fiber)
      expect(rewatching).toBe(true)
      expect(started).toHaveLength(2)
      expect(secondOutput).toContain("job_test")
    }).pipe(Effect.provide(TestClock.layer())),
  )

  withBackground.instance("delivers a stopped notice when the job defects", () =>
    Effect.gen(function* () {
      reset()
      const prompts: string[] = []
      const tool = yield* (yield* WatchPrTool).init()
      yield* tool.execute({ url: githubRequest.url, deadline_seconds: 60, poll_seconds: 5 }, {
        ...summary,
        extra: {
          promptOps: {
            ...promptOps,
            prompt: (input: Parameters<TaskPromptOps["prompt"]>[0]) =>
              Effect.sync(() => {
                prompts.push(input.parts?.[0]?.type === "text" ? input.parts[0].text : "")
                // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- prompt acknowledgement is unused
                return {} as unknown as SessionV1.WithParts
              }),
          },
          watchPrRunner: (() => Effect.die("boom")) as Runner,
        },
      } as Tool.Context)
      const run = started[0]?.run
      if (!run) throw new Error("expected a started job")
      yield* run.pipe(Effect.catchCause(() => Effect.void))
      expect(prompts.some((text) => text.includes("watch_pr stopped"))).toBe(true)
    }),
  )

  withBackground.instance("marks an aborted-turn notice noReply until a newer user message", () =>
    Effect.gen(function* () {
      const calls: Array<boolean | undefined> = []
      const tool = yield* (yield* WatchPrTool).init()
      const runWith = (messages: typeof sessionMessages) =>
        Effect.gen(function* () {
          reset()
          sessionMessages = messages
          const read = yield* Deferred.make<void>()
          yield* tool.execute({ url: githubRequest.url, deadline_seconds: 60, poll_seconds: 5 }, {
            ...summary,
            extra: {
              promptOps: {
                ...promptOps,
                prompt: (input: Parameters<TaskPromptOps["prompt"]>[0]) =>
                  Effect.sync(() => {
                    calls.push(input.noReply)
                    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- prompt acknowledgement is unused
                    return {} as unknown as SessionV1.WithParts
                  }),
              },
              watchPrRunner: sequenceRunner(
                [
                  githubResult(snapshot({ head: "a" })),
                  githubResult(snapshot({ head: "a", checks: { total: 1, pending: 0, failed: 0, passed: 1 } })),
                ],
                read,
              ),
            },
          } as Tool.Context)
          const run = started[0]?.run
          if (!run) throw new Error("expected a started job")
          const fiber = yield* Effect.forkChild(run)
          yield* Deferred.await(read)
          yield* TestClock.adjust(Duration.seconds(5))
          yield* Fiber.join(fiber)
        }).pipe(Effect.provide(TestClock.layer()))
      yield* runWith([
        { info: { role: "assistant", time: { created: 1 }, error: { name: "MessageAbortedError" } }, parts: [] },
      ])
      yield* runWith([
        { info: { role: "assistant", time: { created: 1 }, error: { name: "MessageAbortedError" } }, parts: [] },
        { info: { role: "user", time: { created: 2 } }, parts: [] },
      ])
      expect(calls).toEqual([true, false])
    }),
  )

  withBackground.instance("does not deliver to a deleted session", () =>
    Effect.gen(function* () {
      reset()
      sessionMissing = true
      const prompts: string[] = []
      const tool = yield* (yield* WatchPrTool).init()
      yield* tool.execute({ url: githubRequest.url, deadline_seconds: 60, poll_seconds: 5 }, {
        ...summary,
        extra: {
          promptOps: {
            ...promptOps,
            prompt: (input: Parameters<TaskPromptOps["prompt"]>[0]) =>
              Effect.sync(() => {
                prompts.push(input.sessionID)
                // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- prompt acknowledgement is unused
                return {} as unknown as SessionV1.WithParts
              }),
          },
          watchPrRunner: sequenceRunner([
            githubResult(snapshot({ head: "a" })),
            githubResult(snapshot({ head: "a", checks: { total: 1, pending: 0, failed: 0, passed: 1 } })),
          ]),
        },
      } as Tool.Context)
      const run = started[0]?.run
      if (!run) throw new Error("expected a started job")
      const fiber = yield* Effect.forkChild(run)
      yield* TestClock.adjust(Duration.seconds(5))
      yield* Fiber.join(fiber)
      expect(prompts).toHaveLength(0)
    }).pipe(Effect.provide(TestClock.layer())),
  )

  withBackground.instance("delivers with the session's current agent", () =>
    Effect.gen(function* () {
      reset()
      sessionAgent = "build"
      const prompts: Array<string | undefined> = []
      const read = yield* Deferred.make<void>()
      const tool = yield* (yield* WatchPrTool).init()
      yield* tool.execute({ url: githubRequest.url, deadline_seconds: 60, poll_seconds: 5 }, {
        ...summary,
        extra: {
          promptOps: {
            ...promptOps,
            prompt: (input: Parameters<TaskPromptOps["prompt"]>[0]) =>
              Effect.sync(() => {
                prompts.push(input.agent)
                // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- prompt acknowledgement is unused
                return {} as unknown as SessionV1.WithParts
              }),
          },
          watchPrRunner: sequenceRunner(
            [
              githubResult(snapshot({ head: "a" })),
              githubResult(snapshot({ head: "a", checks: { total: 1, pending: 0, failed: 0, passed: 1 } })),
            ],
            read,
          ),
        },
      } as Tool.Context)
      const run = started[0]?.run
      if (!run) throw new Error("expected a started job")
      const fiber = yield* Effect.forkChild(run)
      yield* Deferred.await(read)
      sessionAgent = "plan"
      yield* TestClock.adjust(Duration.seconds(5))
      yield* Fiber.join(fiber)
      expect(prompts).toEqual(["plan"])
    }).pipe(Effect.provide(TestClock.layer())),
  )

  const events: string[] = []
  const withGoal = testEffect(
    Layer.mergeAll(
      layer,
      Truncate.defaultLayer,
      Agent.defaultLayer,
      sessionLayer,
      Layer.succeed(
        GoalLoop.Service,
        GoalLoop.Service.of({
          init: () => Effect.void,
          wake: (_sessionID, match, _payload, options) =>
            Effect.sync(() => {
              events.push(`wake ${match.source} ${match.ids.join(",")} evaluate=${options?.evaluate}`)
              return true
            }),
        }),
      ),
    ),
  )
  withGoal.instance("a notice wakes only this watch's goal wait before the notice prompt", () =>
    Effect.gen(function* () {
      reset()
      events.length = 0
      const read = yield* Deferred.make<void>()
      const tool = yield* (yield* WatchPrTool).init()
      const result = yield* tool.execute({ url: githubRequest.url, deadline_seconds: 60, poll_seconds: 5 }, {
        ...summary,
        extra: {
          promptOps: {
            ...promptOps,
            prompt: () =>
              Effect.sync(() => {
                events.push("prompt")
                // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- prompt acknowledgement is unused
                return {} as unknown as SessionV1.WithParts
              }),
          },
          watchPrRunner: sequenceRunner(
            [
              githubResult(snapshot({ head: "a" })),
              githubResult(snapshot({ head: "a", checks: { total: 1, pending: 0, failed: 0, passed: 1 } })),
            ],
            read,
          ),
        },
      } as Tool.Context)
      expect(result.output).toContain("wait_id=job_test")
      const run = started[0]?.run
      if (!run) throw new Error("expected a started job")
      const fiber = yield* Effect.forkChild(run)
      yield* Deferred.await(read)
      yield* TestClock.adjust(Duration.seconds(5))
      yield* Fiber.join(fiber)
      expect(events).toEqual([`wake watch_pr job_test,${githubRequest.url} evaluate=false`, "prompt"])
    }).pipe(Effect.provide(TestClock.layer())),
  )

  withBackground.instance("falls back to the tool context agent when the session has none", () =>
    Effect.gen(function* () {
      reset()
      sessionAgent = undefined
      const prompts: Array<string | undefined> = []
      const read = yield* Deferred.make<void>()
      const tool = yield* (yield* WatchPrTool).init()
      yield* tool.execute({ url: githubRequest.url, deadline_seconds: 60, poll_seconds: 5 }, {
        ...summary,
        extra: {
          promptOps: {
            ...promptOps,
            prompt: (input: Parameters<TaskPromptOps["prompt"]>[0]) =>
              Effect.sync(() => {
                prompts.push(input.agent)
                // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- prompt acknowledgement is unused
                return {} as unknown as SessionV1.WithParts
              }),
          },
          watchPrRunner: sequenceRunner(
            [
              githubResult(snapshot({ head: "a" })),
              githubResult(snapshot({ head: "a", checks: { total: 1, pending: 0, failed: 0, passed: 1 } })),
            ],
            read,
          ),
        },
      } as Tool.Context)
      const run = started[0]?.run
      if (!run) throw new Error("expected a started job")
      const fiber = yield* Effect.forkChild(run)
      yield* Deferred.await(read)
      yield* TestClock.adjust(Duration.seconds(5))
      yield* Fiber.join(fiber)
      expect(prompts).toEqual(["build"])
      sessionAgent = "build"
    }).pipe(Effect.provide(TestClock.layer())),
  )

  const withRealTool = testEffect(
    Layer.mergeAll(BackgroundJob.defaultLayer, Truncate.defaultLayer, Agent.defaultLayer, sessionLayer),
  )
  withRealTool.instance("cancels a real watch execution without delivering a notice", () =>
    Effect.gen(function* () {
      const tool = yield* (yield* WatchPrTool).init()
      const sessionID = SessionID.make("ses_watch_tool_cancel")
      const started = yield* Deferred.make<void>()
      let first = true
      const runner: Runner = () =>
        Effect.suspend(() => {
          const result = githubResult(snapshot({ head: "a" }))
          if (!first) return Effect.succeed(result)
          first = false
          return Deferred.succeed(started, undefined).pipe(Effect.as(result))
        })
      const result = yield* tool.execute({ url: githubRequest.url, deadline_seconds: 60, poll_seconds: 5 }, {
        ...summary,
        sessionID,
        extra: {
          promptOps: {
            ...promptOps,
            prompt: () => Effect.die("a cancelled watch must not deliver"),
          },
          watchPrRunner: runner,
        },
      } as Tool.Context)
      yield* Deferred.await(started)
      const cancellation = SessionCancellation.begin(sessionID)
      yield* Effect.all(cancellation.owners, { discard: true })
      cancellation.finish()
      const background = yield* BackgroundJob.Service
      const waited = yield* background.wait({ id: result.metadata.jobId, timeout: 1_000 })
      expect(waited.info?.status).toBe("cancelled")
    }),
  )
})
