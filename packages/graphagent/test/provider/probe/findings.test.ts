// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { ProbeFindings } from "@/provider/probe/findings"
import { ProbePlan } from "@/provider/probe/plan"

// Raw chunks are what the endpoint sent, parsed: the findings only ever look at their JSON shape.
const delta = (fields: Record<string, unknown>, rest: Record<string, unknown> = {}) => ({
  choices: [{ index: 0, delta: fields }],
  ...rest,
})
const finish = (reason: unknown, rest: Record<string, unknown> = {}) => ({
  choices: [{ index: 0, delta: {}, finish_reason: reason }],
  ...rest,
})

type Chat = ProbeFindings.ChatAttempt
const chat = (raw: readonly unknown[] = [], extra: Partial<Chat> = {}): Chat => ({ raw, toolCalls: [], ...extra })
const refused = (status = 400, error = "bad request"): Chat => chat([], { httpStatus: status, error })
const down = (code: "timeout" | "network" | "auth" | number): Chat => {
  if (code === "timeout") return chat([], { timedOut: true, error: "The operation timed out." })
  if (code === "network") return chat([], { error: "fetch failed" })
  if (code === "auth") return chat([], { httpStatus: 401, error: "invalid key" })
  return chat([], { httpStatus: code, error: `upstream ${code}` })
}
const echoCall = (input: unknown = { text: "ping" }, extra: Partial<ProbeFindings.ToolCallResult> = {}) => ({
  id: "call_1",
  name: ProbePlan.TOOL_NAME,
  input,
  ...extra,
})
const models = (...entries: unknown[]): ProbeFindings.ModelsAttempt => ({ httpStatus: 200, body: { data: entries } })

describe("ProbeFindings.outcomeOf", () => {
  const cases: Array<[string, ProbeFindings.Attempt, ProbeFindings.Outcome]> = [
    ["a completed request", {}, "ok"],
    ["a timeout", { timedOut: true, error: "aborted" }, "timeout"],
    ["a timeout wins over a status", { timedOut: true, httpStatus: 500 }, "timeout"],
    ["no response", { error: "fetch failed" }, "network"],
    ["401", { httpStatus: 401 }, "auth"],
    ["403", { httpStatus: 403 }, "auth"],
    ["400", { httpStatus: 400 }, "refused"],
    ["422", { httpStatus: 422 }, "refused"],
    ["404", { httpStatus: 404 }, "http_404"],
    ["429", { httpStatus: 429 }, "http_429"],
    ["500", { httpStatus: 500 }, "http_500"],
    ["an unreadable 2xx body", { httpStatus: 200, error: "not json" }, "http_200"],
  ]
  for (const [name, attempt, outcome] of cases) {
    test(name, () => expect(ProbeFindings.outcomeOf(attempt)).toBe(outcome))
  }
})

describe("ProbeFindings.reasoningOf", () => {
  test("no chunks, no field", () => {
    expect(ProbeFindings.reasoningOf([])).toEqual({ text: "" })
  })

  test("joins the text of the field across chunks", () => {
    const raw = [
      delta({ role: "assistant" }),
      delta({ reasoning_content: "think" }),
      delta({ reasoning_content: "ing" }),
    ]
    expect(ProbeFindings.reasoningOf(raw)).toEqual({ field: "reasoning_content", text: "thinking" })
  })

  test("takes the first of reasoning_content, reasoning and reasoning_details in a chunk", () => {
    const raw = [delta({ reasoning: "b", reasoning_content: "a", reasoning_details: [{ text: "c" }] })]
    expect(ProbeFindings.reasoningOf(raw)).toEqual({ field: "reasoning_content", text: "a" })
  })

  test("reads reasoning", () => {
    expect(ProbeFindings.reasoningOf([delta({ reasoning: "x" })])).toEqual({ field: "reasoning", text: "x" })
  })

  test("reads the string text of each reasoning_details element", () => {
    const raw = [
      delta({
        reasoning_details: [
          { type: "reasoning.text", text: "one " },
          { type: "reasoning.encrypted", data: "z" },
        ],
      }),
      delta({ reasoning_details: [{ type: "reasoning.text", text: "two" }, { text: 3 }] }),
    ]
    expect(ProbeFindings.reasoningOf(raw)).toEqual({ field: "reasoning_details", text: "one two" })
  })

  test("a reasoning_details chunk without any text still names the field", () => {
    const raw = [delta({ reasoning_details: [{ type: "reasoning.encrypted", data: "z" }] })]
    expect(ProbeFindings.reasoningOf(raw)).toEqual({ field: "reasoning_details", text: "" })
  })

  test("ignores empty strings, null and empty arrays", () => {
    const raw = [
      delta({ reasoning_content: "", reasoning: null }),
      delta({ reasoning_details: [] }),
      delta({ content: "hello" }),
    ]
    expect(ProbeFindings.reasoningOf(raw)).toEqual({ text: "" })
  })

  test("the first chunk that has reasoning fixes the field; other fields are not mixed in", () => {
    const raw = [delta({ reasoning: "a" }), delta({ reasoning_content: "b" }), delta({ reasoning: "c" })]
    expect(ProbeFindings.reasoningOf(raw)).toEqual({ field: "reasoning", text: "ac" })
  })

  test("raw chunks of any shape never throw", () => {
    const raw: unknown[] = [
      undefined,
      null,
      "text",
      42,
      true,
      [],
      [1, 2],
      {},
      { choices: null },
      { choices: "x" },
      { choices: [] },
      { choices: [null] },
      { choices: ["x"] },
      { choices: [{}] },
      { choices: [{ delta: null }] },
      { choices: [{ delta: "x" }] },
      { choices: [{ delta: [] }] },
      { choices: [{ delta: { reasoning_content: { nested: 1 } } }] },
    ]
    expect(ProbeFindings.reasoningOf(raw)).toEqual({ text: "" })
  })
})

describe("ProbeFindings.analyze: context", () => {
  const keys = ProbePlan.CONTEXT_KEYS
  test("the six keys are the ones the plan lists", () => {
    expect(keys).toEqual([
      "context_length",
      "context_window",
      "max_model_len",
      "max_context_length",
      "max_input_tokens",
      "input_token_limit",
    ])
  })

  for (const key of keys) {
    test(`found through ${key}`, () => {
      const out = ProbeFindings.analyze({ models: models({ id: "other", [key]: 1 }, { id: "m", [key]: 131_072 }) }, "m")
      expect(out.context).toEqual({ status: "found", tokens: 131_072 })
      expect(out.evidence.context).toContain(key)
      expect(out.evidence.context).toContain("131072")
    })
  }

  test("the first key in plan order wins", () => {
    const out = ProbeFindings.analyze(
      { models: models({ id: "m", input_token_limit: 9, max_model_len: 8, context_window: 7 }) },
      "m",
    )
    expect(out.context).toEqual({ status: "found", tokens: 7 })
  })

  test("a key whose value is not a positive integer is skipped for the next key", () => {
    for (const bad of [0, -5, 1.5, "131072", null, true, NaN, {}, []]) {
      const out = ProbeFindings.analyze(
        { models: models({ id: "m", context_length: bad, context_window: 65_536 }) },
        "m",
      )
      expect({ bad, context: out.context }).toEqual({ bad, context: { status: "found", tokens: 65_536 } })
    }
  })

  test("absent when the entry has no positive integer", () => {
    const out = ProbeFindings.analyze({ models: models({ id: "m", context_length: 0, max_model_len: "big" }) }, "m")
    expect(out.context).toEqual({ status: "absent" })
  })

  test("absent when no entry has the id", () => {
    const out = ProbeFindings.analyze({ models: models({ id: "other", context_length: 4096 }) }, "m")
    expect(out.context).toEqual({ status: "absent" })
    expect(ProbeFindings.analyze({ models: models() }, "m").context).toEqual({ status: "absent" })
  })

  test("absent when the 2xx body is not a models list", () => {
    for (const body of [null, "text", 7, [], {}, { data: "x" }, { data: null }, { data: [null, "x", 1, []] }]) {
      const out = ProbeFindings.analyze({ models: { httpStatus: 200, body } }, "m")
      expect({ body, context: out.context }).toEqual({ body, context: { status: "absent" } })
    }
  })

  test("failed carries the reason code first, then the response text", () => {
    const cases: Array<[ProbeFindings.Attempt, string]> = [
      [{ httpStatus: 404, error: "not found" }, "http_404"],
      [{ httpStatus: 400, error: "bad" }, "http_400"],
      [{ httpStatus: 422, error: "bad" }, "http_422"],
      [{ httpStatus: 401, error: "no key" }, "auth"],
      [{ httpStatus: 403, error: "no access" }, "auth"],
      [{ httpStatus: 429, error: "slow down" }, "http_429"],
      [{ httpStatus: 500, error: "oops" }, "http_500"],
      [{ timedOut: true, error: "aborted" }, "timeout"],
      [{ error: "fetch failed" }, "network"],
      [{ httpStatus: 200, error: "Unexpected token <" }, "http_200"],
    ]
    for (const [attempt, code] of cases) {
      const out = ProbeFindings.analyze({ models: attempt }, "m")
      expect({ code, context: out.context }).toEqual({ code, context: { status: "failed" } })
      expect(out.evidence.context.startsWith(code)).toBe(true)
      if (attempt.error) expect(out.evidence.context).toContain(`${code}: ${attempt.error}`)
    }
  })

  test("skipped when the base URL could not be resolved", () => {
    const out = ProbeFindings.analyze({ models: { skipped: "base_url_unresolved" } }, "m")
    expect(out.context).toEqual({ status: "skipped" })
    expect(out.evidence.context).toBe("base_url_unresolved")
  })
})

describe("ProbeFindings.analyze: usage", () => {
  test("reported when a chunk carries prompt_tokens, completion_tokens or both", () => {
    for (const usage of [{ prompt_tokens: 5 }, { completion_tokens: 2 }, { prompt_tokens: 5, completion_tokens: 2 }]) {
      const out = ProbeFindings.analyze({ stream: chat([delta({ content: "ok" }), finish("stop", { usage })]) }, "m")
      expect({ usage, found: out.usage }).toEqual({ usage, found: "reported" })
    }
  })

  test("the evidence names the counts", () => {
    const out = ProbeFindings.analyze(
      { stream: chat([finish("stop", { usage: { prompt_tokens: 12, completion_tokens: 3 } })]) },
      "m",
    )
    expect(out.evidence.usage).toContain("prompt_tokens=12")
    expect(out.evidence.usage).toContain("completion_tokens=3")
  })

  test("absent when no chunk has numeric usage", () => {
    const raw = [
      delta({ content: "ok" }),
      finish("stop", { usage: null }),
      finish("stop", { usage: { prompt_tokens: "5", completion_tokens: null } }),
      finish("stop", { usage: "x" }),
    ]
    expect(ProbeFindings.analyze({ stream: chat(raw) }, "m").usage).toBe("absent")
  })

  test("failed when the request failed and nothing was seen", () => {
    const cases: Array<[Chat, string]> = [
      [down("timeout"), "timeout"],
      [down("network"), "network"],
      [down("auth"), "auth"],
      [down(404), "http_404"],
      [down(500), "http_500"],
      // 400 and 422 only mean something for the tool and replay probes; here they are plain failures.
      [refused(400), "http_400"],
      [refused(422), "http_422"],
    ]
    for (const [attempt, code] of cases) {
      const out = ProbeFindings.analyze({ stream: attempt }, "m")
      expect({ code, usage: out.usage }).toEqual({ code, usage: "failed" })
      expect(out.evidence.usage.startsWith(code)).toBe(true)
    }
  })

  test("what a request that broke off had already sent still counts", () => {
    const partial = chat([finish(null, { usage: { prompt_tokens: 4 } })], { error: "terminated" })
    expect(ProbeFindings.analyze({ stream: partial }, "m").usage).toBe("reported")
  })
})

describe("ProbeFindings.analyze: toolCall", () => {
  test("supported: probe_echo, not invalid, with a string text", () => {
    for (const input of [{ text: "ping" }, { text: "" }, { text: "x", extra: 1 }]) {
      const out = ProbeFindings.analyze({ tool: chat([finish("tool_calls")], { toolCalls: [echoCall(input)] }) }, "m")
      expect({ input, toolCall: out.toolCall }).toEqual({ input, toolCall: "supported" })
    }
  })

  test("supported when any call qualifies", () => {
    const calls = [echoCall({ text: "a" }, { name: "other" }), echoCall({ text: "b" })]
    expect(ProbeFindings.analyze({ tool: chat([], { toolCalls: calls }) }, "m").toolCall).toBe("supported")
  })

  test("unsupported when the endpoint refuses the request (400, 422)", () => {
    for (const status of [400, 422]) {
      const out = ProbeFindings.analyze({ tool: refused(status, "tools are not supported") }, "m")
      expect({ status, toolCall: out.toolCall }).toEqual({ status, toolCall: "unsupported" })
      expect(out.evidence.toolCall).toContain(String(status))
    }
  })

  test("inconclusive when the response is fine but there is no usable call", () => {
    const cases: Array<[string, Chat]> = [
      ["a text answer", chat([delta({ content: "ping" }), finish("stop")])],
      ["the output limit", chat([delta({ content: "I will" }), finish("length")])],
      ["another tool", chat([], { toolCalls: [echoCall({ text: "x" }, { name: "other" })] })],
      ["an invalid call", chat([], { toolCalls: [echoCall("{bad", { invalid: true })] })],
      ["a missing text", chat([], { toolCalls: [echoCall({})] })],
      ["a numeric text", chat([], { toolCalls: [echoCall({ text: 5 })] })],
      ["a null input", chat([], { toolCalls: [echoCall(null)] })],
    ]
    for (const [name, attempt] of cases) {
      const out = ProbeFindings.analyze({ tool: attempt }, "m")
      expect({ name, toolCall: out.toolCall }).toEqual({ name, toolCall: "inconclusive" })
    }
  })

  test("failed with the reason code first", () => {
    const cases: Array<[Chat, string]> = [
      [down("timeout"), "timeout"],
      [down("network"), "network"],
      [down("auth"), "auth"],
      [down(500), "http_500"],
      [down(404), "http_404"],
    ]
    for (const [attempt, code] of cases) {
      const out = ProbeFindings.analyze({ tool: attempt }, "m")
      expect({ code, toolCall: out.toolCall }).toEqual({ code, toolCall: "failed" })
      expect(out.evidence.toolCall.startsWith(code)).toBe(true)
    }
  })
})

describe("ProbeFindings.analyze: reasoningField", () => {
  const streamWith = (field: string, text = "t") => chat([delta({ [field]: text }), finish("stop")])

  test("the field name is the result, for each of the three fields", () => {
    for (const field of ProbePlan.REASONING_FIELDS) {
      const value = field === "reasoning_details" ? [{ text: "t" }] : "t"
      const out = ProbeFindings.analyze({ stream: chat([delta({ [field]: value }), finish("stop")]) }, "m")
      expect({ field, found: out.reasoningField }).toEqual({ field, found: field })
    }
  })

  test("the stream request is scanned first, then the tool request", () => {
    const both = ProbeFindings.analyze({ stream: streamWith("reasoning"), tool: streamWith("reasoning_content") }, "m")
    expect(both.reasoningField).toBe("reasoning")
    const onlyTool = ProbeFindings.analyze(
      { stream: chat([finish("stop")]), tool: streamWith("reasoning_content") },
      "m",
    )
    expect(onlyTool.reasoningField).toBe("reasoning_content")
  })

  test("absent when a request succeeded and neither carries reasoning", () => {
    const out = ProbeFindings.analyze(
      { stream: chat([delta({ content: "ok" }), finish("stop")]), tool: down("auth") },
      "m",
    )
    expect(out.reasoningField).toBe("absent")
  })

  test("failed when neither request succeeded", () => {
    const out = ProbeFindings.analyze({ stream: down("auth"), tool: refused(400) }, "m")
    expect(out.reasoningField).toBe("failed")
    expect(out.evidence.reasoningField.startsWith("auth")).toBe(true)
  })

  test("a request that broke off after sending reasoning still names the field", () => {
    const out = ProbeFindings.analyze(
      { stream: chat([delta({ reasoning_content: "x" })], { error: "terminated" }) },
      "m",
    )
    expect(out.reasoningField).toBe("reasoning_content")
  })
})

describe("ProbeFindings.analyze: finishReasons", () => {
  test("the raw values in order of first appearance across the chat requests, without duplicates", () => {
    const out = ProbeFindings.analyze(
      {
        stream: chat([finish("stop")]),
        tool: chat([finish("tool_calls")]),
        replayWith: chat([finish("stop")]),
        replayWithout: refused(400),
        length: chat([finish(null), finish("length"), finish("stop")]),
      },
      "m",
    )
    expect(out.finishReasons).toEqual(["stop", "tool_calls", "length"])
  })

  test("keeps vendor values as they are and skips what is not a non-empty string", () => {
    const out = ProbeFindings.analyze(
      {
        stream: chat([finish("eos_token"), finish(""), finish(7), finish(undefined), finish({})]),
        length: chat([finish("MAX_TOKENS")]),
      },
      "m",
    )
    expect(out.finishReasons).toEqual(["eos_token", "MAX_TOKENS"])
  })

  test("the known values are the OpenAI ones", () => {
    expect(ProbePlan.KNOWN_FINISH_REASONS).toEqual(["stop", "length", "tool_calls", "content_filter", "function_call"])
  })

  test("nothing seen is an empty list, and a failed length probe is named in the evidence", () => {
    const out = ProbeFindings.analyze({ length: down(500) }, "m")
    expect(out.finishReasons).toEqual([])
    expect(out.evidence.finishReasons).toContain("http_500")
  })
})

describe("ProbeFindings.analyze: replay", () => {
  type Leg = "ok" | "refused" | "failed"
  const leg = (kind: Leg): Chat =>
    kind === "ok" ? chat([finish("stop")]) : kind === "refused" ? refused(400) : down(500)
  const expected: Record<Leg, Record<Leg, ProbeFindings.Findings["replay"]>> = {
    // with: ok
    ok: { ok: "accepted", refused: "required", failed: "failed" },
    // with: refused
    refused: { ok: "rejected", refused: "inconclusive", failed: "failed" },
    // with: failed
    failed: { ok: "failed", refused: "failed", failed: "failed" },
  }
  const legs: Leg[] = ["ok", "refused", "failed"]
  for (const withLeg of legs) {
    for (const withoutLeg of legs) {
      test(`with ${withLeg}, without ${withoutLeg} is ${expected[withLeg][withoutLeg]}`, () => {
        const out = ProbeFindings.analyze({ replayWith: leg(withLeg), replayWithout: leg(withoutLeg) }, "m")
        expect(out.replay).toBe(expected[withLeg][withoutLeg])
        if (out.replay === "failed") expect(out.evidence.replay).toMatch(/^(timeout|network|auth|http_\d+)/)
      })
    }
  }

  test("the evidence says what each request got", () => {
    const out = ProbeFindings.analyze(
      { replayWith: leg("ok"), replayWithout: refused(422, "reasoning_content is unknown") },
      "m",
    )
    expect(out.replay).toBe("required")
    expect(out.evidence.replay).toContain("with")
    expect(out.evidence.replay).toContain("without")
    expect(out.evidence.replay).toContain("422")
  })

  test("skipped with no_tool_turn when the tool probe found no usable call", () => {
    for (const tool of [refused(400), down(500), chat([delta({ content: "no" }), finish("stop")]), undefined]) {
      const out = ProbeFindings.analyze(
        { stream: chat([delta({ reasoning_content: "r" }), finish("stop")]), tool },
        "m",
      )
      expect(out.replay).toBe("skipped")
      expect(out.evidence.replay).toBe("no_tool_turn")
    }
  })

  test("skipped with no_reasoning when a tool call exists but there is no reasoning text", () => {
    const tool = chat([finish("tool_calls")], { toolCalls: [echoCall()] })
    const out = ProbeFindings.analyze({ stream: chat([finish("stop")]), tool }, "m")
    expect(out.toolCall).toBe("supported")
    expect(out.replay).toBe("skipped")
    expect(out.evidence.replay).toBe("no_reasoning")
  })
})

describe("ProbeFindings.echoCall and reasoningAcross", () => {
  test("echoCall is the qualifying call of a request that was accepted", () => {
    const call = echoCall({ text: "ping" })
    expect(ProbeFindings.echoCall(chat([], { toolCalls: [echoCall("{bad", { invalid: true }), call] }))).toEqual(call)
    expect(ProbeFindings.echoCall(chat([], { toolCalls: [echoCall({})] }))).toBeUndefined()
    expect(ProbeFindings.echoCall(refused(400))).toBeUndefined()
    expect(ProbeFindings.echoCall(undefined)).toBeUndefined()
  })

  test("reasoningAcross takes the tool request text for the field the stream request named", () => {
    const stream = chat([delta({ reasoning_content: "from stream" })])
    const tool = chat([delta({ reasoning_content: "from " }), delta({ reasoning_content: "tool" })])
    expect(ProbeFindings.reasoningAcross(stream, tool)).toEqual({ field: "reasoning_content", text: "from tool" })
  })

  test("reasoningAcross falls back to the stream text when the tool request has none", () => {
    const stream = chat([delta({ reasoning_content: "from stream" })])
    expect(ProbeFindings.reasoningAcross(stream, chat([finish("tool_calls")]))).toEqual({
      field: "reasoning_content",
      text: "from stream",
    })
  })

  test("reasoningAcross ignores text under another field name", () => {
    const stream = chat([delta({ reasoning_content: "named" })])
    const tool = chat([delta({ reasoning: "other field" })])
    expect(ProbeFindings.reasoningAcross(stream, tool)).toEqual({ field: "reasoning_content", text: "named" })
  })

  test("reasoningAcross takes the tool request field when the stream request had none", () => {
    expect(ProbeFindings.reasoningAcross(chat([]), chat([delta({ reasoning: "r" })]))).toEqual({
      field: "reasoning",
      text: "r",
    })
    expect(ProbeFindings.reasoningAcross(undefined, undefined)).toEqual({ text: "" })
  })
})

describe("ProbeFindings.analyze: evidence and robustness", () => {
  test("the evidence is the original text: not truncated and not redacted", () => {
    const long = `fixture-key ${"x".repeat(500)}`
    const out = ProbeFindings.analyze({ stream: chat([], { httpStatus: 500, error: long }) }, "m")
    expect(out.evidence.usage).toBe(`http_500: ${long}`)
  })

  test("a failed item without an error text is just the code", () => {
    const out = ProbeFindings.analyze({ stream: chat([], { httpStatus: 401 }) }, "m")
    expect(out.evidence.usage).toBe("auth")
  })

  test("raw chunks of any shape never throw", () => {
    const raw: unknown[] = [
      undefined,
      null,
      "x",
      1,
      [],
      {},
      { choices: [null] },
      { choices: [{ finish_reason: 5, delta: "x" }] },
      { usage: 3 },
    ]
    const results = {
      models: { httpStatus: 200, body: undefined },
      stream: chat(raw),
      tool: chat(raw, { toolCalls: [] }),
      replayWith: chat(raw),
      replayWithout: chat(raw),
      length: chat(raw),
    }
    const out = ProbeFindings.analyze(results, "m")
    expect(out.usage).toBe("absent")
    expect(out.reasoningField).toBe("absent")
    expect(out.finishReasons).toEqual([])
  })

  test("nothing run yet is not a crash", () => {
    const out = ProbeFindings.analyze({}, "m")
    expect(out.context.status).toBe("skipped")
    expect(out.usage).toBe("failed")
    expect(out.toolCall).toBe("failed")
    expect(out.reasoningField).toBe("failed")
    expect(out.replay).toBe("skipped")
    expect(out.finishReasons).toEqual([])
  })
})
