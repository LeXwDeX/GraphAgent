// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { jsonSchema, tool } from "ai"
import type { ModelMessage } from "ai"
import { isRecord } from "@/util/record"
import { ProbePlan } from "@/provider/probe/plan"
import { ProbeReport } from "@/provider/probe/report"
import { ProbeRun } from "@/provider/probe/run"
import { ProbeTransport } from "@/provider/probe/transport"
import {
  API_KEY,
  BASE_URL,
  MODEL_ID,
  PROVIDER_NAME,
  chunk,
  crash,
  end,
  fakeEndpoint,
  hang,
  json,
  sse,
  status,
  type Recorded,
  type Reply,
  type Script,
} from "./fake-endpoint"

const ctx: ProbePlan.Context = {
  providerID: "relay",
  modelID: MODEL_ID,
  apiID: MODEL_ID,
  interleaved: false,
  secrets: [API_KEY],
}

const MODELS_OK = json({
  data: [
    { id: "other", context_length: 1 },
    { id: MODEL_ID, context_length: 131_072 },
  ],
})

const streamReply = (opts: { field?: string; text?: string; usage?: boolean } = {}): Reply =>
  sse([
    chunk({ role: "assistant" }),
    ...(opts.field ? [chunk({ [opts.field]: opts.text ?? "thinking about it" })] : []),
    chunk({ content: "ok" }),
    end("stop", opts.usage === false ? {} : { usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } }),
  ])

const toolReply = (opts: { field?: string; text?: string; args?: string; name?: string } = {}): Reply =>
  sse([
    chunk({ role: "assistant" }),
    ...(opts.field ? [chunk({ [opts.field]: opts.text ?? "I should call the tool" })] : []),
    chunk({
      tool_calls: [
        {
          index: 0,
          id: "call_probe_1",
          type: "function",
          function: { name: opts.name ?? "probe_echo", arguments: opts.args ?? '{"text":"ping"}' },
        },
      ],
    }),
    end("tool_calls"),
  ])

const textReply = (finish = "stop"): Reply => sse([chunk({ role: "assistant", content: "ok" }), end(finish)])
const refusal: Reply = status(400, { error: { message: "unknown field reasoning_content" } })

/** The script of a model whose endpoint demands the reasoning back: the with-request passes, the without one is refused. */
const REQUIRED: Script = {
  models: MODELS_OK,
  chat: [
    streamReply({ field: "reasoning_content" }),
    toolReply({ field: "reasoning_content" }),
    textReply(),
    refusal,
    textReply("length"),
  ],
}

async function probe(
  script: Script,
  opts: {
    timeoutMs?: number
    baseURL?: string | undefined
    headers?: Record<string, string>
    apiKey?: string
    providerOptions?: ProbeTransport.ProviderOptions
  } = {},
) {
  const endpoint = fakeEndpoint(script)
  const announced: Array<{ count: number; tokens: number; requestsBefore: number }> = []
  const transport = ProbeTransport.make({
    language: endpoint.language(),
    baseURL: "baseURL" in opts ? opts.baseURL : BASE_URL,
    apiKey: "apiKey" in opts ? opts.apiKey : API_KEY,
    headers: opts.headers ?? {},
    providerOptions: opts.providerOptions,
    fetch: endpoint.fetch,
    timeoutMs: opts.timeoutMs,
  })
  const result = await ProbeRun.run(transport, ctx, (count, tokens) =>
    announced.push({ count, tokens, requestsBefore: endpoint.requests.length }),
  )
  return { ...result, requests: endpoint.requests, announced }
}

const record = (value: unknown): Record<string, unknown> => {
  if (!isRecord(value)) throw new Error(`expected an object, got ${JSON.stringify(value)}`)
  return value
}
const records = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value.map(record) : [])

// What a recorded chat request asked, in the words of the probe table.
const askOf = (request: Recorded) => {
  expect(request.method).toBe("POST")
  const body = record(request.body)
  return {
    stream: body.stream,
    maxTokens: body.max_tokens,
    hasTools: Array.isArray(body.tools),
    /** The function descriptor of each offered tool. */
    tools: records(body.tools).map((item) => record(item.function)),
    messages: records(body.messages),
  }
}
const chats = (requests: readonly Recorded[]) => requests.filter((request) => request.method === "POST")

describe("ProbeRun.run: the plan", () => {
  test("six probes in table order, and the limits the issue states", () => {
    expect(ProbePlan.PROBES).toEqual(["models", "stream", "tool", "replay_with", "replay_without", "length"])
    expect(ProbePlan.PROBES).toHaveLength(6)
    expect(ProbePlan.MAX_REQUESTS).toBe(6)
    expect(ProbePlan.MAX_OUTPUT_TOKENS).toBe(256)
    expect(ProbePlan.LENGTH_PROBE_TOKENS).toBe(16)
    expect(ProbePlan.REQUEST_TIMEOUT_MS).toBe(60_000)
    expect(ProbePlan.EVIDENCE_MAX).toBe(200)
    expect(ProbePlan.TOOL_NAME).toBe("probe_echo")
  })

  test("announces 6 requests and 256 output tokens before the first request", async () => {
    const out = await probe(REQUIRED)
    expect(out.announced).toEqual([{ count: 6, tokens: 256, requestsBefore: 0 }])
  })

  test("sends the requests in the order of PROBES", async () => {
    const out = await probe(REQUIRED)
    expect(out.requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      `GET ${BASE_URL}/models`,
      ...Array<string>(5).fill(`POST ${BASE_URL}/chat/completions`),
    ])
    const [stream, tool, withReasoning, withoutReasoning, length] = chats(out.requests).map(askOf)
    expect(stream.messages).toEqual([{ role: "user", content: "Reply with the single word: ok" }])
    expect(stream.hasTools).toBe(false)
    expect(tool.messages).toEqual([{ role: "user", content: 'Call probe_echo with text "ping".' }])
    expect(tool.tools.map((fn) => fn.name)).toEqual(["probe_echo"])
    expect(withReasoning.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"])
    expect(withoutReasoning.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"])
    expect(length.messages).toEqual([{ role: "user", content: "Count from 1 to 200, one number per line." }])
    expect(length.hasTools).toBe(false)
  })

  test("the tool is probe_echo with a required string text", async () => {
    const out = await probe(REQUIRED)
    const tool = askOf(chats(out.requests)[1]).tools[0]
    expect(tool.name).toBe("probe_echo")
    expect(tool.description).toBe("Echo the given text.")
    expect(tool.parameters).toMatchObject({
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    })
  })

  test("never more than 6 requests, 256 output tokens each (16 for the length probe), all streamed", async () => {
    const out = await probe(REQUIRED)
    expect(out.requests.length).toBeLessThanOrEqual(ProbePlan.MAX_REQUESTS)
    const bodies = chats(out.requests).map(askOf)
    expect(bodies.map((body) => body.maxTokens)).toEqual([256, 256, 256, 256, 16])
    expect(bodies.every((body) => body.stream === true)).toBe(true)
  })

  test("every chat request carries the provider options; the replay still rides on the assistant message", async () => {
    const out = await probe(REQUIRED, { providerOptions: { [PROVIDER_NAME]: { enable_thinking: true } } })
    const bodies = chats(out.requests).map((request) => record(request.body))
    expect(bodies).toHaveLength(5)
    expect(bodies.map((body) => body.enable_thinking)).toEqual([true, true, true, true, true])
    // The probe's own limits are the ones that apply, options or not.
    expect(bodies.map((body) => body.max_tokens)).toEqual([256, 256, 256, 256, 16])
    expect(bodies.every((body) => body.stream === true)).toBe(true)
    // The reasoning of the with-request is a message-level option, not a request-level one: the options leave it be.
    const [, , withReasoning, withoutReasoning] = chats(out.requests).map(askOf)
    expect(withReasoning.messages[1].reasoning_content).toBe("I should call the tool")
    expect(withoutReasoning.messages[1]).not.toHaveProperty("reasoning_content")
    // The models request is a plain GET, with no body to carry them.
    expect(out.requests[0].method).toBe("GET")
    expect(out.requests[0].body).toBeUndefined()
  })

  test("without provider options no chat request carries any", async () => {
    const out = await probe(REQUIRED)
    for (const request of chats(out.requests)) expect(record(request.body)).not.toHaveProperty("enable_thinking")
  })

  test("the models request carries the key and the configured headers", async () => {
    const out = await probe(REQUIRED, { headers: { "X-Org": "acme" } })
    expect(out.requests[0].headers).toMatchObject({ authorization: `Bearer ${API_KEY}`, "x-org": "acme" })
  })

  test("a configured Authorization header replaces the default one, whatever its case", async () => {
    const out = await probe(REQUIRED, { headers: { authorization: "Token custom" } })
    expect(out.requests[0].headers.authorization).toBe("Token custom")
  })

  test("no key, no Authorization header", async () => {
    const out = await probe(REQUIRED, { apiKey: undefined })
    expect(out.requests[0].headers.authorization).toBeUndefined()
  })
})

describe("ProbeRun.run: findings per script", () => {
  test("required: the endpoint wants the reasoning back", async () => {
    const out = await probe(REQUIRED)
    expect(out.findings.context).toEqual({ status: "found", tokens: 131_072 })
    expect(out.findings.usage).toBe("reported")
    expect(out.findings.toolCall).toBe("supported")
    expect(out.findings.reasoningField).toBe("reasoning_content")
    expect(out.findings.replay).toBe("required")
    expect(out.findings.finishReasons).toEqual(["stop", "tool_calls", "length"])
    expect(out.chatOk).toBe(true)
    expect(out.requests).toHaveLength(6)
  })

  test("the with-request replays the reasoning text on the assistant message, the without-request does not", async () => {
    const out = await probe(REQUIRED)
    const [, , withReasoning, withoutReasoning] = chats(out.requests).map(askOf)
    const assistantWith = withReasoning.messages[1]
    const assistantWithout = withoutReasoning.messages[1]
    expect(assistantWith.reasoning_content).toBe("I should call the tool")
    expect(assistantWith.tool_calls).toMatchObject([{ id: "call_probe_1", function: { name: "probe_echo" } }])
    expect(assistantWithout).not.toHaveProperty("reasoning_content")
    expect(assistantWithout.tool_calls).toMatchObject([{ id: "call_probe_1", function: { name: "probe_echo" } }])
    // Both continue the same turn: the tool result is the echoed text, and the tool is still offered.
    for (const body of [withReasoning, withoutReasoning]) {
      expect(body.messages[2]).toMatchObject({ role: "tool", tool_call_id: "call_probe_1", content: "ping" })
      expect(body.tools.map((fn) => fn.name)).toEqual(["probe_echo"])
    }
  })

  test("the replay uses the field the endpoint itself used", async () => {
    const fields: ProbePlan.ReasoningField[] = ["reasoning", "reasoning_content"]
    for (const field of fields) {
      const out = await probe({
        models: MODELS_OK,
        chat: [streamReply({ field }), toolReply({ field, text: "because" }), textReply(), textReply(), textReply()],
      })
      const withReasoning = askOf(chats(out.requests)[2]).messages[1]
      expect({ field, replayed: withReasoning[field] }).toEqual({ field, replayed: "because" })
      expect(out.findings.reasoningField).toBe(field)
    }
  })

  test("accepted: the endpoint takes the turn with and without the reasoning", async () => {
    const out = await probe({
      ...REQUIRED,
      chat: [
        streamReply({ field: "reasoning_content" }),
        toolReply({ field: "reasoning_content" }),
        textReply(),
        textReply(),
        textReply("length"),
      ],
    })
    expect(out.findings.replay).toBe("accepted")
    expect(out.requests).toHaveLength(6)
  })

  test("rejected: the endpoint refuses the reasoning", async () => {
    const out = await probe({
      ...REQUIRED,
      chat: [
        streamReply({ field: "reasoning_content" }),
        toolReply({ field: "reasoning_content" }),
        refusal,
        textReply(),
        textReply("length"),
      ],
    })
    expect(out.findings.replay).toBe("rejected")
  })

  test("inconclusive: the endpoint refuses both turns", async () => {
    const out = await probe({
      ...REQUIRED,
      chat: [
        streamReply({ field: "reasoning_content" }),
        toolReply({ field: "reasoning_content" }),
        refusal,
        refusal,
        textReply("length"),
      ],
    })
    expect(out.findings.replay).toBe("inconclusive")
  })

  test("the tool probe refused (400): no tool turn, so the replays are skipped and only 4 requests go out", async () => {
    const out = await probe({
      models: MODELS_OK,
      chat: [streamReply({ field: "reasoning_content" }), refusal, textReply("length")],
    })
    expect(out.findings.toolCall).toBe("unsupported")
    expect(out.findings.replay).toBe("skipped")
    expect(out.findings.evidence.replay).toBe("no_tool_turn")
    expect(out.requests).toHaveLength(4)
    expect(out.chatOk).toBe(true)
  })

  test("a tool probe answered with text is inconclusive and skips the replays", async () => {
    const out = await probe({ models: MODELS_OK, chat: [streamReply(), textReply(), textReply("length")] })
    expect(out.findings.toolCall).toBe("inconclusive")
    expect(out.findings.evidence.replay).toBe("no_tool_turn")
    expect(out.requests).toHaveLength(4)
  })

  test("a tool call with arguments that are not JSON is inconclusive", async () => {
    const out = await probe({
      models: MODELS_OK,
      chat: [streamReply(), toolReply({ args: "{bad" }), textReply("length")],
    })
    expect(out.findings.toolCall).toBe("inconclusive")
    expect(out.requests).toHaveLength(4)
  })

  test("a tool call without text is inconclusive", async () => {
    const out = await probe({
      models: MODELS_OK,
      chat: [streamReply(), toolReply({ args: "{}" }), textReply("length")],
    })
    expect(out.findings.toolCall).toBe("inconclusive")
  })

  test("a call to another tool is inconclusive", async () => {
    const out = await probe({
      models: MODELS_OK,
      chat: [streamReply(), toolReply({ name: "other_tool" }), textReply("length")],
    })
    expect(out.findings.toolCall).toBe("inconclusive")
  })

  test("no reasoning anywhere: the field is absent and the replays are skipped", async () => {
    const out = await probe({ models: MODELS_OK, chat: [streamReply(), toolReply(), textReply("length")] })
    expect(out.findings.reasoningField).toBe("absent")
    expect(out.findings.toolCall).toBe("supported")
    expect(out.findings.replay).toBe("skipped")
    expect(out.findings.evidence.replay).toBe("no_reasoning")
    expect(out.requests).toHaveLength(4)
  })

  test("reasoning only in the stream request still lets the replays run, with that text", async () => {
    const out = await probe({
      models: MODELS_OK,
      chat: [
        streamReply({ field: "reasoning_content", text: "from the stream" }),
        toolReply(),
        textReply(),
        refusal,
        textReply("length"),
      ],
    })
    expect(out.findings.replay).toBe("required")
    expect(askOf(chats(out.requests)[2]).messages[1].reasoning_content).toBe("from the stream")
  })

  test("a usage-less stream is reported as absent", async () => {
    const out = await probe({ ...REQUIRED, chat: [streamReply({ usage: false }), toolReply(), textReply("length")] })
    expect(out.findings.usage).toBe("absent")
  })

  test("a 200 models list without the model is absent, and the probe goes on", async () => {
    const out = await probe({ ...REQUIRED, models: json({ data: [{ id: "other", context_length: 1 }] }) })
    expect(out.findings.context).toEqual({ status: "absent" })
    expect(out.findings.replay).toBe("required")
  })

  test("an unresolved base URL skips the models request and sends 5 requests", async () => {
    const out = await probe(REQUIRED, { baseURL: undefined })
    expect(out.findings.context).toEqual({ status: "skipped" })
    expect(out.findings.evidence.context).toBe("base_url_unresolved")
    expect(out.requests.every((request) => request.method === "POST")).toBe(true)
    expect(out.requests).toHaveLength(5)
    expect(out.findings.replay).toBe("required")
  })

  test("every request 401: all items failed with the auth code, nothing to write, chatOk is false", async () => {
    const denied = status(401, { error: { message: "invalid api key" } })
    const out = await probe({ models: denied, chat: [denied, denied, denied, denied, denied] })
    expect(out.requests.length).toBeLessThanOrEqual(ProbePlan.MAX_REQUESTS)
    expect(out.requests).toHaveLength(4)
    expect(out.chatOk).toBe(false)
    expect(out.findings.context.status).toBe("failed")
    expect(out.findings.usage).toBe("failed")
    expect(out.findings.toolCall).toBe("failed")
    expect(out.findings.reasoningField).toBe("failed")
    expect(out.findings.replay).toBe("skipped")
    expect(out.findings.finishReasons).toEqual([])
    for (const field of ["context", "usage", "toolCall", "reasoningField"]) {
      expect(out.findings.evidence[field].startsWith("auth")).toBe(true)
    }
    expect(ProbeReport.snippet(out.findings, ctx).provider.relay.models[MODEL_ID]).toEqual({})
  })

  test("chatOk needs one chat request that succeeded, not the models request", async () => {
    const out = await probe({ models: MODELS_OK, chat: [status(500), status(500), status(500)] })
    expect(out.chatOk).toBe(false)
    expect(out.findings.context.status).toBe("found")
  })

  test("one successful chat request is enough for chatOk", async () => {
    const out = await probe({ models: status(404), chat: [status(500), status(500), textReply("length")] })
    expect(out.chatOk).toBe(true)
  })
})

describe("ProbeRun.run: a failed probe does not stop the others", () => {
  // The failure kinds of the issue, and the code each must report. `timeout` needs a short deadline.
  const failures: Array<[string, Reply, string]> = [
    ["timeout", hang, "timeout"],
    ["network", crash(), "network"],
    ["401", status(401), "auth"],
    ["403", status(403), "auth"],
    ["404", status(404), "http_404"],
    ["429", status(429), "http_429"],
    ["500", status(500), "http_500"],
    ["400 (only the tool and replay probes may call it a refusal)", status(400), "http_400"],
    ["422", status(422), "http_422"],
  ]

  for (const [name, reply, code] of failures) {
    test(`models ${name}: context failed with ${code}, the rest as usual`, async () => {
      const out = await probe({ ...REQUIRED, models: reply }, { timeoutMs: 300 })
      expect(out.findings.context).toEqual({ status: "failed" })
      expect(out.findings.evidence.context.startsWith(code)).toBe(true)
      expect(out.findings.usage).toBe("reported")
      expect(out.findings.toolCall).toBe("supported")
      expect(out.findings.replay).toBe("required")
      expect(out.requests).toHaveLength(6)
      // No window was measured, so the snippet has no limit.
      const model = ProbeReport.snippet(out.findings, ctx).provider.relay.models[MODEL_ID]
      expect(model).not.toHaveProperty("limit")
      expect(model).toEqual({
        reasoning: true,
        interleaved: { field: "reasoning_content" },
        profile: { reasoning_mode: { replay: "field" } },
      })
      const line = ProbeReport.render(out.findings, ctx)[0]
      expect(line).toContain("failed")
      expect(line).toContain(code)
    })

    test(`stream ${name}: usage failed with ${code}, the rest as usual`, async () => {
      const chat = [reply, ...(REQUIRED.chat ?? []).slice(1)]
      const out = await probe({ ...REQUIRED, chat }, { timeoutMs: 300 })
      expect(out.findings.usage).toBe("failed")
      expect(out.findings.evidence.usage.startsWith(code)).toBe(true)
      expect(out.findings.context.status).toBe("found")
      expect(out.findings.toolCall).toBe("supported")
      // The tool request carried the reasoning, so the field and the replay result do not depend on the stream request.
      expect(out.findings.reasoningField).toBe("reasoning_content")
      expect(out.findings.replay).toBe("required")
      expect(out.requests).toHaveLength(6)
      expect(out.chatOk).toBe(true)
    })

    test(`tool ${name}: toolCall failed (or unsupported for a refusal), replays skipped, length still runs`, async () => {
      const chat = [streamReply({ field: "reasoning_content" }), reply, textReply("length")]
      const out = await probe({ ...REQUIRED, chat }, { timeoutMs: 300 })
      // A 400 or 422 on the tool request is the endpoint saying "no tools": the probe's real answer.
      const refused = code === "http_400" || code === "http_422"
      expect(out.findings.toolCall).toBe(refused ? "unsupported" : "failed")
      if (!refused) expect(out.findings.evidence.toolCall.startsWith(code)).toBe(true)
      expect(out.findings.replay).toBe("skipped")
      expect(out.findings.finishReasons).toEqual(["stop", "length"])
      expect(out.requests).toHaveLength(4)
    })

    // A 400 or 422 on a replay request is a result (the endpoint refuses that turn), covered by the scripts above.
    if (code === "http_400" || code === "http_422") continue

    test(`replay_without ${name}: replay failed with ${code} and no profile key`, async () => {
      const chat = [
        streamReply({ field: "reasoning_content" }),
        toolReply({ field: "reasoning_content" }),
        textReply(),
        reply,
        textReply("length"),
      ]
      const out = await probe({ ...REQUIRED, chat }, { timeoutMs: 300 })
      expect(out.findings.replay).toBe("failed")
      expect(out.findings.evidence.replay.startsWith(code)).toBe(true)
      expect(out.findings.finishReasons).toContain("length")
      expect(ProbeReport.snippet(out.findings, ctx).provider.relay.models[MODEL_ID]).not.toHaveProperty("profile")
    })
  }

  test("a stream that ends without a finish reason counts as broken (network)", async () => {
    const broken = sse([chunk({ role: "assistant", content: "ok" })])
    const out = await probe({ ...REQUIRED, chat: [broken, ...(REQUIRED.chat ?? []).slice(1)] })
    expect(out.findings.usage).toBe("failed")
    expect(out.findings.evidence.usage.startsWith("network")).toBe(true)
  })

  test("a timeout on every request still ends, with every item failed", async () => {
    const out = await probe({ models: hang, chat: [hang, hang, hang] }, { timeoutMs: 50 })
    expect(out.chatOk).toBe(false)
    expect(out.findings.context.status).toBe("failed")
    expect(out.findings.usage).toBe("failed")
    expect(out.findings.evidence.usage.startsWith("timeout")).toBe(true)
    expect(out.requests).toHaveLength(4)
  })
})

describe("ProbeRun.limit", () => {
  const stub: ProbeTransport.Transport = {
    models: async () => ({ skipped: "base_url_unresolved" }),
    chat: async () => ({ raw: [], toolCalls: [] }),
  }

  test("passes calls through up to the budget, then throws on the next", async () => {
    const limited = ProbeRun.limit(stub, 3)
    await limited.models()
    await limited.chat({ messages: [], maxOutputTokens: 1 })
    await limited.chat({ messages: [], maxOutputTokens: 1 })
    expect(() => limited.chat({ messages: [], maxOutputTokens: 1 })).toThrow("3")
    expect(() => limited.models()).toThrow("3")
  })

  test("the default budget is the plan's MAX_REQUESTS", async () => {
    const limited = ProbeRun.limit(stub)
    for (let index = 0; index < ProbePlan.MAX_REQUESTS; index++) await limited.models()
    expect(() => limited.models()).toThrow(String(ProbePlan.MAX_REQUESTS))
  })
})

describe("ProbeTransport.make", () => {
  const transport = (script: Script, extra: Partial<Parameters<typeof ProbeTransport.make>[0]> = {}) => {
    const endpoint = fakeEndpoint(script)
    return {
      endpoint,
      transport: ProbeTransport.make({
        language: endpoint.language(),
        baseURL: BASE_URL,
        apiKey: API_KEY,
        headers: {},
        fetch: endpoint.fetch,
        timeoutMs: 100,
        ...extra,
      }),
    }
  }
  // The model can only call a tool the request offers; one it was not offered is an invalid call.
  const echoTool = tool({
    description: "Echo the given text.",
    inputSchema: jsonSchema({ type: "object", properties: { text: { type: "string" } }, required: ["text"] }),
  })
  const ask = { messages: [{ role: "user", content: "hi" }] satisfies ModelMessage[], maxOutputTokens: 8 }
  const askWithTool = { ...ask, tools: { probe_echo: echoTool } }

  test("chat returns the raw chunks and the tool calls", async () => {
    const { transport: t } = transport({ chat: [toolReply({ field: "reasoning_content" })] })
    const result = await t.chat(askWithTool)
    expect(result.error).toBeUndefined()
    expect(result.httpStatus).toBeUndefined()
    expect(result.raw.length).toBeGreaterThan(2)
    expect(result.raw[1]).toMatchObject({ choices: [{ delta: { reasoning_content: "I should call the tool" } }] })
    expect(result.toolCalls).toEqual([{ id: "call_probe_1", name: "probe_echo", input: { text: "ping" } }])
  })

  test("chat marks a tool call that does not parse as invalid", async () => {
    const { transport: t } = transport({ chat: [toolReply({ args: "{bad" })] })
    const result = await t.chat(askWithTool)
    expect(result.toolCalls).toMatchObject([{ name: "probe_echo", invalid: true }])
  })

  test("chat marks a call to a tool that was not offered as invalid", async () => {
    const { transport: t } = transport({ chat: [toolReply()] })
    const result = await t.chat(ask)
    expect(result.toolCalls).toMatchObject([{ name: "probe_echo", invalid: true }])
  })

  test("chat records the status and message of an error response", async () => {
    const { transport: t } = transport({ chat: [status(429, { error: { message: "slow down" } })] })
    const result = await t.chat(ask)
    expect(result.httpStatus).toBe(429)
    expect(result.error).toContain("slow down")
    expect(result.timedOut).toBeUndefined()
    expect(result.raw).toEqual([])
  })

  test("chat records a missing response as an error without a status", async () => {
    const { transport: t } = transport({ chat: [crash("socket hang up")] })
    const result = await t.chat(ask)
    expect(result.httpStatus).toBeUndefined()
    expect(result.error).toContain("socket hang up")
    expect(result.timedOut).toBeUndefined()
  })

  test("chat marks a timeout", async () => {
    const { transport: t } = transport({ chat: [hang] }, { timeoutMs: 50 })
    const result = await t.chat(ask)
    expect(result.timedOut).toBe(true)
    expect(result.httpStatus).toBeUndefined()
  })

  test("chat does not retry", async () => {
    const { transport: t, endpoint } = transport({ chat: [status(500), textReply()] })
    await t.chat(ask)
    expect(endpoint.requests).toHaveLength(1)
  })

  test("chat puts the provider options in the request body, next to the probe's own fields", async () => {
    const { transport: t, endpoint } = transport(
      { chat: [textReply()] },
      { providerOptions: { [PROVIDER_NAME]: { enable_thinking: true, thinking: { type: "enabled" } } } },
    )
    await t.chat(ask)
    expect(record(endpoint.requests[0].body)).toMatchObject({
      model: MODEL_ID,
      stream: true,
      max_tokens: 8,
      enable_thinking: true,
      thinking: { type: "enabled" },
    })
  })

  test("chat reads the options under the provider's own key only", async () => {
    const { transport: t, endpoint } = transport(
      { chat: [textReply()] },
      { providerOptions: { "someone-else": { enable_thinking: true } } },
    )
    await t.chat(ask)
    expect(record(endpoint.requests[0].body)).not.toHaveProperty("enable_thinking")
  })

  test("the probe's output cap wins: a cap among the provider options is dropped, the rest stays", async () => {
    const options = { [PROVIDER_NAME]: { enable_thinking: true, max_tokens: 4_096, max_completion_tokens: 4_096 } }
    const { transport: t, endpoint } = transport({ chat: [textReply()] }, { providerOptions: options })
    await t.chat(ask)
    const body = record(endpoint.requests[0].body)
    expect(body.max_tokens).toBe(8)
    expect(body).not.toHaveProperty("max_completion_tokens")
    expect(body.enable_thinking).toBe(true)
    // The caller's object is left as it was given.
    expect(options[PROVIDER_NAME]).toEqual({ enable_thinking: true, max_tokens: 4_096, max_completion_tokens: 4_096 })
  })

  test("the probe's retry count and deadline hold with provider options set", async () => {
    const options = { [PROVIDER_NAME]: { enable_thinking: true } }
    const retried = transport({ chat: [status(500), textReply()] }, { providerOptions: options })
    await retried.transport.chat(ask)
    expect(retried.endpoint.requests).toHaveLength(1)
    const stuck = transport({ chat: [hang] }, { providerOptions: options, timeoutMs: 50 })
    expect((await stuck.transport.chat(ask)).timedOut).toBe(true)
  })

  test("models returns the parsed body of a 2xx", async () => {
    const { transport: t } = transport({ models: MODELS_OK })
    expect(await t.models()).toEqual({
      body: {
        data: [
          { id: "other", context_length: 1 },
          { id: MODEL_ID, context_length: 131_072 },
        ],
      },
    })
  })

  test("models records the status and text of a non-2xx", async () => {
    const { transport: t } = transport({ models: status(404, "no models here") })
    expect(await t.models()).toEqual({ httpStatus: 404, error: "no models here" })
  })

  test("models records a 2xx whose body is not JSON", async () => {
    const { transport: t } = transport({ models: status(200, "<html>login</html>") })
    const result = await t.models()
    expect(result).toMatchObject({ httpStatus: 200 })
    expect("body" in result && result.body).toBeFalsy()
    expect("error" in result && result.error).toBeTruthy()
  })

  test("models records a fetch that throws, and a timeout", async () => {
    const down = await transport({ models: crash("connect ECONNREFUSED") }).transport.models()
    expect(down).toMatchObject({ error: expect.stringContaining("ECONNREFUSED") })
    expect("httpStatus" in down).toBe(false)
    const slow = await transport({ models: hang }, { timeoutMs: 50 }).transport.models()
    expect(slow).toMatchObject({ timedOut: true })
  })

  test("models without a base URL is skipped and sends nothing", async () => {
    const { transport: t, endpoint } = transport({ models: MODELS_OK }, { baseURL: undefined })
    expect(await t.models()).toEqual({ skipped: "base_url_unresolved" })
    expect(endpoint.requests).toEqual([])
  })

  test("the deadline defaults to the plan's REQUEST_TIMEOUT_MS", () => {
    // Only the constant can be checked without waiting a minute.
    expect(ProbePlan.REQUEST_TIMEOUT_MS).toBe(60_000)
  })
})

describe("ProbeTransport.resolveBaseURL", () => {
  const resolve = (input: { optionsBaseURL?: unknown; apiURL: string; env?: Record<string, string | undefined> }) =>
    ProbeTransport.resolveBaseURL({ env: {}, ...input })

  test("a non-empty options baseURL wins over the model's api url", () => {
    expect(resolve({ optionsBaseURL: "https://a.example.com/v1", apiURL: "https://b.example.com/v1" })).toBe(
      "https://a.example.com/v1",
    )
  })

  test("an empty, missing or non-string options baseURL falls back to the api url", () => {
    for (const optionsBaseURL of [undefined, "", 5, null, {}]) {
      expect(resolve({ optionsBaseURL, apiURL: "https://b.example.com/v1" })).toBe("https://b.example.com/v1")
    }
  })

  test("${NAME} is replaced from the environment", () => {
    expect(resolve({ apiURL: "https://${HOST}/${VERSION}", env: { HOST: "api.example.com", VERSION: "v1" } })).toBe(
      "https://api.example.com/v1",
    )
    expect(resolve({ optionsBaseURL: "https://${HOST}/v1", apiURL: "", env: { HOST: "x.example.com" } })).toBe(
      "https://x.example.com/v1",
    )
    expect(resolve({ apiURL: "https://${HOST}/${HOST}", env: { HOST: "h" } })).toBe("https://h/h")
  })

  test("a variable that is not set leaves a placeholder, which makes the URL unresolved", () => {
    expect(resolve({ apiURL: "https://${HOST}/v1", env: {} })).toBeUndefined()
    expect(resolve({ apiURL: "https://${HOST}/v1", env: { HOST: undefined } })).toBeUndefined()
    expect(resolve({ apiURL: "https://${A}.${B}/v1", env: { A: "ok" } })).toBeUndefined()
  })

  test("nothing at all is unresolved", () => {
    expect(resolve({ apiURL: "" })).toBeUndefined()
    expect(resolve({ optionsBaseURL: "", apiURL: "" })).toBeUndefined()
    expect(resolve({ apiURL: "${EMPTY}", env: { EMPTY: "" } })).toBeUndefined()
  })

  test("trailing slashes are removed", () => {
    expect(resolve({ apiURL: "https://api.example.com/v1/" })).toBe("https://api.example.com/v1")
    expect(resolve({ apiURL: "https://api.example.com/v1///" })).toBe("https://api.example.com/v1")
    expect(resolve({ apiURL: "https://api.example.com" })).toBe("https://api.example.com")
  })
})
