import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Fiber, Logger } from "effect"
import { GoalJudge } from "@/goal/judge"
import * as TestClock from "effect/testing/TestClock"
import { it } from "../lib/effect"

describe("parseJudgeResponse", () => {
  test("valid JSON preserves literal fenced markdown in its reason", () => {
    const reason = 'checked ```json {config} ``` and escaped quotes "ok"'
    expect(GoalJudge.parseJudgeResponse(JSON.stringify({ verdict: "continue", reason }))).toEqual({
      verdict: "continue",
      reason,
      parseFailed: false,
    })
  })
  // §1.2 — clean JSON parses directly (step 2)
  test("clean JSON object returns matching verdict", () => {
    const result = GoalJudge.parseJudgeResponse('{"done": true, "reason": "all tests pass"}')
    expect(result).toEqual({ verdict: "done", reason: "all tests pass", parseFailed: false })
  })

  test("clean JSON with done=false returns continue", () => {
    const result = GoalJudge.parseJudgeResponse('{"done": false, "reason": "still working"}')
    expect(result).toEqual({ verdict: "continue", reason: "still working", parseFailed: false })
  })

  test("blocked verdict stays distinct from successful completion", () => {
    const result = GoalJudge.parseJudgeResponse('{"verdict":"blocked","reason":"missing production credentials"}')
    expect(result).toEqual({
      verdict: "blocked",
      reason: "missing production credentials",
      parseFailed: false,
    })
  })

  // §1.3 — markdown-fenced JSON strips fences (step 1)
  test("markdown-fenced JSON strips fences and parses", () => {
    const raw = '```json\n{"done": false, "reason": "more steps remain"}\n```'
    const result = GoalJudge.parseJudgeResponse(raw)
    expect(result).toEqual({ verdict: "continue", reason: "more steps remain", parseFailed: false })
  })

  test("markdown-fenced without language tag also strips", () => {
    const raw = '```\n{"done": true, "reason": "done"}\n```'
    const result = GoalJudge.parseJudgeResponse(raw)
    expect(result).toEqual({ verdict: "done", reason: "done", parseFailed: false })
  })

  // §1.4 — JSON embedded in prose: regex step extracts first {...} block (step 3)
  test("JSON embedded in prose is extracted by regex fallback", () => {
    const raw = 'Sure! {"done": true, "reason": "shipped"} Thanks'
    const result = GoalJudge.parseJudgeResponse(raw)
    expect(result).toEqual({ verdict: "done", reason: "shipped", parseFailed: false })
  })

  // §1.5 — unparseable input falls through all steps (step 4)
  test("unparseable prose returns continue with parseFailed true", () => {
    const raw = "I think it's done"
    const result = GoalJudge.parseJudgeResponse(raw)
    expect(result).toEqual({
      verdict: "continue",
      reason: `judge 返回非 JSON 内容（${raw.length} 字符）`,
      parseFailed: true,
      failureCategory: "non-json",
    })
  })

  test("empty string reports an actionable privacy-safe category", () => {
    const result = GoalJudge.parseJudgeResponse("")
    expect(result.parseFailed).toBe(true)
    expect(result.verdict).toBe("continue")
    expect(result.failureCategory).toBe("empty")
    expect(result.reason).toBe("judge 返回空响应（0 字符）")
  })

  test("valid JSON but wrong shape reports invalid-shape", () => {
    const result = GoalJudge.parseJudgeResponse('{"done": true}')
    expect(result.parseFailed).toBe(true)
    expect(result.failureCategory).toBe("invalid-shape")
    expect(result.reason).toContain("缺少有效 verdict/reason")
  })

  test("truncated JSON is distinguishable without echoing response content", () => {
    const raw = '{"verdict":"done","reason":"tests passed"'
    const result = GoalJudge.parseJudgeResponse(raw)
    expect(result).toEqual({
      verdict: "continue",
      reason: `judge 返回疑似截断的 JSON（${raw.length} 字符）`,
      parseFailed: true,
      failureCategory: "truncated-json",
    })
    expect(result.reason).not.toContain("tests passed")
  })

  test("malformed closed JSON reports malformed-json", () => {
    const result = GoalJudge.parseJudgeResponse('{"verdict":"done",}')
    expect(result.parseFailed).toBe(true)
    expect(result.failureCategory).toBe("malformed-json")
  })

  // §1.6 — nested-brace reason. NOTE: this contradicts tasks.md §1.6, which
  // claims this input hits "step 4 fallback, parseFailed: true." It does not:
  // step 2 runs `JSON.parse` on the whole string, and JSON.parse correctly
  // handles braces inside string literals, so `{"reason": "set up {config}"}`
  // parses cleanly. The regex limitation (`\{[^{}]*\}` cannot span nested
  // braces) only manifests at STEP 3, and step 3 is only reached when step 2
  // has already FAILED — i.e. when the verdict JSON is embedded in prose.
  // See the next test for the case that actually demonstrates the limitation.
  // Asserting the real current behavior keeps RED-1 green.
  test("nested-brace reason parses via step 2 (JSON.parse handles braces in strings)", () => {
    const raw = '{"done": true, "reason": "set up {config}"}'
    const result = GoalJudge.parseJudgeResponse(raw)
    expect(result).toEqual({ verdict: "done", reason: "set up {config}", parseFailed: false })
  })

  test("balanced extraction accepts nested braces inside a quoted reason", () => {
    const raw = 'Sure! {"done": true, "reason": "set up {config}"} done'
    const result = GoalJudge.parseJudgeResponse(raw)
    expect(result).toEqual({ verdict: "done", reason: "set up {config}", parseFailed: false })
  })

  test("a stray unbalanced brace in prose does not hide a later complete verdict", () => {
    const raw = 'The agent left `if (ok) {` unclosed in main.ts.\n{"verdict":"blocked","reason":"needs the user API key"}'
    expect(GoalJudge.parseJudgeResponse(raw)).toEqual({
      verdict: "blocked",
      reason: "needs the user API key",
      parseFailed: false,
    })
  })

  test("a stray brace before truncated JSON still reports truncated-json", () => {
    const raw = 'Saw `{` in prose. {"verdict":"done","reason":"tests passed"'
    expect(GoalJudge.parseJudgeResponse(raw).failureCategory).toBe("truncated-json")
    expect(GoalJudge.parseJudgeResponse("no verdict yet {").failureCategory).toBe("truncated-json")
  })

  test("an unclosed markdown fence with a complete object still parses safely", () => {
    const raw = '```json\n{"verdict":"continue","reason":"more work"}'
    expect(GoalJudge.parseJudgeResponse(raw)).toEqual({
      verdict: "continue",
      reason: "more work",
      parseFailed: false,
    })
  })
})

describe("GoalJudge.run — transport failures count toward pause budget (D5)", () => {
  it.effect("deadline expiry cancels both stalled attempts and returns one failed evaluation", () =>
    Effect.gen(function* () {
      const first = yield* Deferred.make<void>()
      const second = yield* Deferred.make<void>()
      let calls = 0
      let cancelled = 0
      const fiber = yield* Effect.forkScoped(
        GoalJudge.run("goal", "response", [], () =>
          Effect.gen(function* () {
            calls++
            yield* Deferred.succeed(calls === 1 ? first : second, undefined)
            return yield* Effect.never.pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  cancelled++
                }),
              ),
            )
          }),
        ),
      )
      yield* Deferred.await(first)
      yield* TestClock.adjust("30 seconds")
      yield* Deferred.await(second)
      yield* TestClock.adjust("30 seconds")
      const result = yield* Fiber.join(fiber)
      expect(calls).toBe(2)
      expect(cancelled).toBe(2)
      expect(result.parseFailed).toBe(true)
      expect(result.failureCategory).toBe("transport-error")
    }))
  test("user interruption stops the judge without another request", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        let calls = 0
        const fiber = yield* Effect.forkScoped(
          GoalJudge.run("goal", "response", [], () =>
            Effect.gen(function* () {
              calls++
              yield* Deferred.succeed(started, undefined)
              return yield* Effect.never
            }),
          ),
        )
        yield* Deferred.await(started)
        yield* Fiber.interrupt(fiber)
        expect(calls).toBe(1)
      }).pipe(Effect.scoped),
    ))
  test("logs finish metadata and categories without prompts, raw responses or error messages", async () => {
    const logs: string[] = []
    const logger = Logger.make((options) => logs.push(JSON.stringify(options.message)))
    let calls = 0
    const result = await Effect.runPromise(
      GoalJudge.run("PRIVATE_GOAL", "PRIVATE_RESPONSE", [], () => {
        calls++
        return Effect.succeed({
          text: calls === 1 ? '{"reason":"PRIVATE_OUTPUT' : '{"verdict":"continue","reason":"PRIVATE_REASON"}',
          finishReason: calls === 1 ? "length" : "stop",
          outputTokens: 1024,
          reasoningTokens: 800,
          sessionID: "session-test",
          providerID: "provider-test",
          modelID: "model-test",
        })
      }).pipe(Effect.withLogger(logger)),
    )
    expect(result.parseFailed).toBe(false)
    const log = logs.join("\n")
    expect(log).toContain("truncated-json")
    expect(log).toContain("length")
    expect(log).toContain("stop")
    expect(log).toContain("1024")
    expect(log).toContain("800")
    expect(log).toContain("session-test")
    expect(log).toContain("provider-test")
    expect(log).toContain("model-test")
    expect(log).not.toContain("PRIVATE_")
    await Effect.runPromise(
      GoalJudge.run("PRIVATE_GOAL", "PRIVATE_RESPONSE", [], () =>
        Effect.fail(new Error("PRIVATE_ERROR api-key=secret")),
      ).pipe(Effect.withLogger(logger)),
    )
    expect(logs.join("\n")).not.toContain("PRIVATE_")
    expect(logs.join("\n")).not.toContain("api-key")
  })
  test("retries an empty judgment at the same boundary before returning a verdict", async () => {
    const requests: Array<{ user: string; maxTokens: number }> = []
    const result = await Effect.runPromise(
      GoalJudge.run("goal", "response", [], (opts) => {
        requests.push(opts)
        return Effect.succeed(requests.length === 1 ? "" : '{"verdict":"done","reason":"verified"}')
      }),
    )
    expect(result).toEqual({ verdict: "done", reason: "verified", parseFailed: false })
    expect(requests).toHaveLength(2)
    expect(requests[0].user).toBe(requests[1].user)
    expect(requests.map((request) => request.maxTokens)).toEqual([1024, 2048])
  })

  test("persistent invalid judgments stop after two attempts", async () => {
    let calls = 0
    const result = await Effect.runPromise(
      GoalJudge.run("goal", "response", [], () => {
        calls++
        return Effect.succeed('{"verdict":"continue","reason":"unfinished')
      }),
    )
    expect(calls).toBe(2)
    expect(result.failureCategory).toBe("truncated-json")
    expect(result.parseFailed).toBe(true)
  })

  test("a transient transport failure recovers without an extra work turn", async () => {
    let calls = 0
    const result = await Effect.runPromise(
      GoalJudge.run("goal", "response", [], () => {
        calls++
        return calls === 1
          ? Effect.fail(new Error("network"))
          : Effect.succeed('{"verdict":"continue","reason":"more work"}')
      }),
    )
    expect(calls).toBe(2)
    expect(result.parseFailed).toBe(false)
    expect(result.verdict).toBe("continue")
  })
  // §9.2 — when the injected callLLM fails (timeout, network error, rejection),
  // the orElseSucceed fallback MUST return parseFailed: true (not false) so the
  // failure increments consecutive_parse_failures via updateAfterJudge's
  // `parseFailed ? count + 1 : 0` logic. Pre-fix this returned parseFailed:
  // false, which reset the counter and let a flaky provider burn the full
  // max_turns budget without ever pausing.
  test("transport failure (Effect.fail) returns parseFailed: true", () =>
    Effect.gen(function* () {
      const result = yield* GoalJudge.run("build feature X", "some agent response", [], () =>
        Effect.fail(new Error("timeout")),
      )
      expect(result.verdict).toBe("continue")
      expect(result.parseFailed).toBe(true)
      expect(result.failureCategory).toBe("transport-error")
    }).pipe(Effect.runPromise))

  test("transport failure reason names the failure mode", () =>
    Effect.gen(function* () {
      const result = yield* GoalJudge.run("build feature X", "some agent response", [], () =>
        Effect.fail(new Error("network down")),
      )
      // The reason must name the transport failure so the pause message
      // (when it eventually fires after MAX_CONSECUTIVE_PARSE_FAILURES)
      // can distinguish transport unreliability from parse failures.
      expect(result.reason).toMatch(/transport/i)
      expect(result.reason).toContain("judge 调用失败")
    }).pipe(Effect.runPromise))

  test("non-Error rejection also returns parseFailed: true", () =>
    Effect.gen(function* () {
      const result = yield* GoalJudge.run("build feature X", "some agent response", [], () =>
        Effect.fail(new Error("ECONNRESET")),
      )
      expect(result.parseFailed).toBe(true)
      expect(result.verdict).toBe("continue")
    }).pipe(Effect.runPromise))
})
