// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { BackgroundJob } from "@/background/job"
import { DagStore } from "@graphagent/core/dag/store"
import { HookTurnContext } from "@/hook/turn-context"

test("Stop task context includes only current-session active work and bounds descriptions", async () => {
  const long = "x".repeat(1_017)
  const tasks = await Effect.runPromise(
    Effect.gen(function* () {
      return yield* HookTurnContext.backgroundTasks("current", {
        jobs: yield* BackgroundJob.Service,
        workflows: yield* DagStore.Service,
      })
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(BackgroundJob.Service, {
            list: () =>
              Effect.succeed<BackgroundJob.Info[]>([
                {
                  id: "owned",
                  type: "bash",
                  status: "running",
                  started_at: 0,
                  title: long,
                  metadata: { sessionID: "current", command: long },
                },
                {
                  id: "child",
                  type: "task",
                  status: "running",
                  started_at: 0,
                  metadata: { parentSessionID: "current", agent: "review", command: "wrong kind" },
                },
                { id: "other", type: "bash", status: "running", started_at: 0, metadata: { sessionID: "other" } },
                { id: "done", type: "bash", status: "completed", started_at: 0, metadata: { sessionID: "current" } },
              ]),
          }),
          Layer.mock(DagStore.Service, {
            listBySession: () =>
              Effect.succeed<DagStore.WorkflowRow[]>([
                {
                  id: "workflow",
                  status: "running",
                  title: "Current workflow",
                  projectId: "project",
                  sessionId: "current",
                  directory: process.cwd(),
                  targetFingerprint: { kind: "none" },
                  pauseReason: null,
                  config: "{}",
                  seq: 0,
                  wakeReported: false,
                  graphRev: 0,
                  startedAt: null,
                  completedAt: null,
                  timeCreated: 0,
                  timeUpdated: 0,
                },
                {
                  id: "done-workflow",
                  status: "completed",
                  title: "Finished workflow",
                  projectId: "project",
                  sessionId: "current",
                  directory: process.cwd(),
                  targetFingerprint: { kind: "none" },
                  pauseReason: null,
                  config: "{}",
                  seq: 0,
                  wakeReported: false,
                  graphRev: 0,
                  startedAt: null,
                  completedAt: null,
                  timeCreated: 0,
                  timeUpdated: 0,
                },
              ]),
          }),
        ),
      ),
    ),
  )
  expect(tasks.map((task) => task.id)).toEqual(["owned", "child", "workflow"])
  expect(tasks[0]).toMatchObject({
    type: "shell",
    status: "running",
    description: `${"x".repeat(1_000)}… [+17 chars]`,
    command: `${"x".repeat(1_000)}… [+17 chars]`,
  })
  expect(tasks[1]).toMatchObject({ type: "subagent", agent_type: "review" })
  expect(tasks[1]).not.toHaveProperty("command")
  expect(tasks[2]).toMatchObject({ type: "workflow", name: "Current workflow" })
  expect(JSON.stringify(tasks)).not.toContain("other")
})

test("StopFailure classifies the raw cause but only sends an already displayed message", () => {
  const cause = { reason: { _tag: "RateLimit", message: "upstream secret", http: { response: { status: 429 } } } }
  expect(HookTurnContext.failure(cause)).toEqual({ error: "rate_limit" })
  expect(HookTurnContext.failure(cause, "Rate limit reached")).toEqual({
    error: "rate_limit",
    errorDetails: "Rate limit reached",
    lastAssistantMessage: "Rate limit reached",
  })
  expect(HookTurnContext.failure({ message: "model_not_found" }, "Shown model error").error).toBe("model_not_found")
})

test("StopFailure reports a spent quota on a 429 as billing_error, not rate_limit", () => {
  const stored = (statusCode: number, responseBody: string, message = `status ${statusCode}`) => ({
    name: "APIError",
    data: { message, isRetryable: false, statusCode, responseBody },
  })
  // OpenAI-style balance exhaustion and a Zhipu code with its limit message both arrive as a 429.
  expect(HookTurnContext.failure(stored(429, '{"error":{"code":"insufficient_quota"}}')).error).toBe("billing_error")
  expect(HookTurnContext.failure(stored(429, '{"error":{"code":"1113","message":"您的账户已欠费"}}')).error).toBe(
    "billing_error",
  )
  expect(
    HookTurnContext.failure(
      stored(429, '{"error":{"code":"1308","message":"已达到 5 小时的使用上限"}}', "已达到 5 小时的使用上限"),
    ).error,
  ).toBe("billing_error")
  // A real rate limit, and the per-minute allocation DashScope reports as a quota, stay rate limits.
  expect(HookTurnContext.failure(stored(429, '{"error":{"code":"rate_limit_exceeded"}}')).error).toBe("rate_limit")
  expect(
    HookTurnContext.failure(
      stored(
        429,
        '{"error":{"code":"insufficient_quota","message":"Allocated quota exceeded, please increase your quota limit."}}',
      ),
    ).error,
  ).toBe("rate_limit")
  // The vocabulary outside the quota case is untouched.
  expect(HookTurnContext.failure(stored(402, "{}")).error).toBe("billing_error")
  expect(HookTurnContext.failure(stored(401, "{}")).error).toBe("authentication_failed")
})
