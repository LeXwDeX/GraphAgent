// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { ConfigV1 } from "@graphagent/core/v1/config/config"
import type { ProbeFindings } from "@/provider/probe/findings"
import { ProbePlan } from "@/provider/probe/plan"
import { ProbeReport } from "@/provider/probe/report"
import { ProviderRedact } from "@/provider/redact"

const ctx: ProbePlan.Context = {
  providerID: "relay",
  modelID: "org/model-1.5",
  apiID: "org/model-1.5",
  interleaved: false,
  secrets: ["fixture-key"],
}

const findings = (extra: Partial<ProbeFindings.Findings> = {}): ProbeFindings.Findings => ({
  context: { status: "absent" },
  usage: "absent",
  toolCall: "inconclusive",
  reasoningField: "absent",
  replay: "skipped",
  finishReasons: [],
  evidence: {},
  ...extra,
})

// The one model entry of a snippet.
const modelOf = (input: ProbeFindings.Findings, c: ProbePlan.Context = ctx) => {
  const out = ProbeReport.snippet(input, c)
  return out.provider[c.providerID].models[c.modelID]
}

describe("ProbeReport.snippet", () => {
  test("holds every key the probe can conclude, under provider.<id>.models.<id>", () => {
    const out = ProbeReport.snippet(
      findings({
        context: { status: "found", tokens: 131_072 },
        reasoningField: "reasoning_content",
        replay: "required",
      }),
      ctx,
    )
    expect(out).toEqual({
      provider: {
        relay: {
          models: {
            "org/model-1.5": {
              limit: { context: 131_072 },
              reasoning: true,
              interleaved: { field: "reasoning_content" },
              profile: { reasoning_mode: { replay: "field" } },
            },
          },
        },
      },
    })
  })

  test("never writes limit.output, and a rejected replay writes only limit, profile and reasoning", () => {
    const model = modelOf(
      findings({
        context: { status: "found", tokens: 8_000 },
        usage: "reported",
        toolCall: "supported",
        reasoningField: "reasoning_details",
        replay: "rejected",
        finishReasons: ["stop"],
      }),
    )
    expect(Object.keys(model).sort()).toEqual(["limit", "profile", "reasoning"])
    expect(model.limit).toEqual({ context: 8_000 })
    expect(model.limit).not.toHaveProperty("output")
    expect(model).not.toHaveProperty("tool_call")
    expect(model).not.toHaveProperty("interleaved")
  })

  test("required writes field, rejected writes none, the others write nothing", () => {
    const replay = (value: ProbeFindings.Findings["replay"]) => modelOf(findings({ replay: value })).profile
    expect(replay("required")).toEqual({ reasoning_mode: { replay: "field" } })
    expect(replay("rejected")).toEqual({ reasoning_mode: { replay: "none" } })
    const silent: ProbeFindings.Findings["replay"][] = ["accepted", "inconclusive", "failed", "skipped"]
    for (const value of silent) {
      expect({ value, profile: replay(value) }).toEqual({ value, profile: undefined })
    }
  })

  // The engine replays reasoning under `model.capabilities.interleaved.field` and never reads the profile's replay
  // setting, so a required replay has to name the field there too, or pasting the snippet changes nothing at run time.
  test("required also writes interleaved.field with the measured field", () => {
    for (const field of ProbePlan.REASONING_FIELDS) {
      expect({ field, model: modelOf(findings({ reasoningField: field, replay: "required" })) }).toEqual({
        field,
        model: { reasoning: true, interleaved: { field }, profile: { reasoning_mode: { replay: "field" } } },
      })
    }
  })

  test("required without a measured field writes no interleaved", () => {
    const none: ProbeFindings.Findings["reasoningField"][] = ["absent", "failed"]
    for (const value of none) {
      const model = modelOf(findings({ reasoningField: value, replay: "required" }))
      expect({ value, model }).toEqual({ value, model: { profile: { reasoning_mode: { replay: "field" } } } })
    }
  })

  // The configuration has no `interleaved: false` (it takes `true` or `{ field }`), so a rejected replay can only
  // say `replay: none`; writing `false` would make the pasted snippet fail to load.
  test("only a required replay writes interleaved, and never interleaved: false", () => {
    const others: ProbeFindings.Findings["replay"][] = ["accepted", "rejected", "inconclusive", "failed", "skipped"]
    for (const value of others) {
      const model = modelOf(findings({ reasoningField: "reasoning_content", replay: value }))
      expect({ value, interleaved: model.interleaved }).toEqual({ value, interleaved: undefined })
    }
  })

  test("reasoning is true only when a field was measured", () => {
    for (const field of ProbePlan.REASONING_FIELDS) {
      expect(modelOf(findings({ reasoningField: field })).reasoning).toBe(true)
    }
    const none: ProbeFindings.Findings["reasoningField"][] = ["absent", "failed"]
    for (const value of none) {
      expect(modelOf(findings({ reasoningField: value }))).not.toHaveProperty("reasoning")
    }
  })

  test("limit.context only for a found window", () => {
    expect(modelOf(findings({ context: { status: "found", tokens: 32_000 } })).limit).toEqual({ context: 32_000 })
    const none: ProbeFindings.ContextFinding["status"][] = ["absent", "failed", "skipped"]
    for (const status of none) {
      expect(modelOf(findings({ context: { status } }))).not.toHaveProperty("limit")
    }
  })

  test("no conclusion gives an empty model entry", () => {
    expect(ProbeReport.snippet(findings(), ctx)).toEqual({ provider: { relay: { models: { "org/model-1.5": {} } } } })
  })

  test("decodes through the configuration schema without losing a key", () => {
    const out = ProbeReport.snippet(
      findings({ context: { status: "found", tokens: 65_536 }, reasoningField: "reasoning", replay: "rejected" }),
      ctx,
    )
    const decoded = Schema.decodeUnknownSync(ConfigV1.Info)(out)
    expect(decoded.provider).toEqual(out.provider)
    const empty = Schema.decodeUnknownSync(ConfigV1.Info)(ProbeReport.snippet(findings(), ctx))
    expect(empty.provider).toEqual({ relay: { models: { "org/model-1.5": {} } } })
  })

  test("every snippet the probe can print decodes through the configuration schema, key for key", () => {
    const replays: ProbeFindings.Findings["replay"][] = [
      "accepted",
      "required",
      "rejected",
      "inconclusive",
      "failed",
      "skipped",
    ]
    const fields: ProbeFindings.Findings["reasoningField"][] = [...ProbePlan.REASONING_FIELDS, "absent", "failed"]
    for (const replay of replays) {
      for (const reasoningField of fields) {
        const out = ProbeReport.snippet(
          findings({ context: { status: "found", tokens: 4_096 }, reasoningField, replay }),
          ctx,
        )
        const decoded = Schema.decodeUnknownSync(ConfigV1.Info)(out)
        expect({ replay, reasoningField, provider: decoded.provider }).toEqual({
          replay,
          reasoningField,
          provider: out.provider,
        })
      }
    }
  })

  test("returns fresh objects on every call", () => {
    const input = findings({ context: { status: "found", tokens: 1 } })
    const first = ProbeReport.snippet(input, ctx)
    const second = ProbeReport.snippet(input, ctx)
    expect(first).toEqual(second)
    expect(first).not.toBe(second)
  })
})

describe("ProbeReport.redact", () => {
  const R = ProviderRedact.REDACTED

  test("replaces every occurrence of every secret", () => {
    expect(ProbeReport.redact("a fixture-key b fixture-key c other-secret", ["fixture-key", "other-secret"])).toBe(
      `a ${R} b ${R} c ${R}`,
    )
  })

  test("ignores empty secrets and leaves a text without secrets alone", () => {
    expect(ProbeReport.redact("nothing to hide", ["", "fixture-key"])).toBe("nothing to hide")
    expect(ProbeReport.redact("anything", [])).toBe("anything")
  })

  test("the longer secret is replaced first, so no tail of it is left behind", () => {
    expect(ProbeReport.redact("token abcdef end", ["abc", "abcdef"])).toBe(`token ${R} end`)
    expect(ProbeReport.redact("token abcdef end", ["abcdef", "abc"])).toBe(`token ${R} end`)
  })

  test("secrets are literal text, not patterns", () => {
    expect(ProbeReport.redact("a.b*c(d) a-b-c", ["a.b*c(d)"])).toBe(`${R} a-b-c`)
  })

  test("redacting twice changes nothing, even for a secret that occurs inside the marker", () => {
    const once = ProbeReport.redact("my red key fixture-key", ["fixture-key", "red"])
    expect(once).toBe(`my ${R} key ${R}`)
    expect(ProbeReport.redact(once, ["fixture-key", "red"])).toBe(once)
  })
})

describe("ProbeReport.render", () => {
  const full = findings({
    context: { status: "found", tokens: 131_072 },
    usage: "reported",
    toolCall: "supported",
    reasoningField: "reasoning_content",
    replay: "required",
    finishReasons: ["stop", "tool_calls", "length"],
    evidence: {
      context: "context_length=131072 in GET /models",
      usage: "prompt_tokens=12, completion_tokens=3",
      toolCall: 'probe_echo called with {"text":"ping"}',
      reasoningField: "reasoning_content in the stream response",
      replay: "with: ok, without: refused (HTTP 400)",
      finishReasons: "length probe (maxOutputTokens=16): length",
    },
  })
  const cells = (line: string) => line.split(/ {2,}/)

  test("one line per item, in the fixed order", () => {
    const lines = ProbeReport.render(full, ctx)
    expect(lines.map((line) => cells(line)[0])).toEqual([
      "context",
      "usage",
      "tool_call",
      "reasoning_field",
      "replay",
      "finish_reasons",
    ])
  })

  test("three aligned columns: name, result, evidence", () => {
    const lines = ProbeReport.render(full, ctx)
    const evidenceColumn = lines[0].indexOf("context_length=131072")
    expect(evidenceColumn).toBeGreaterThan(0)
    expect(lines[1].indexOf("prompt_tokens=12")).toBe(evidenceColumn)
    expect(lines[2].indexOf("probe_echo called")).toBe(evidenceColumn)
    expect(lines[4].indexOf("with: ok")).toBe(evidenceColumn)
    const resultColumn = lines[0].indexOf("found")
    expect(lines[1].indexOf("reported")).toBe(resultColumn)
    expect(lines[3].indexOf("reasoning_content")).toBe(resultColumn)
    expect(cells(lines[1])).toEqual(["usage", "reported", "prompt_tokens=12, completion_tokens=3"])
  })

  test("the result column shows the window, the field and the finish reasons", () => {
    const lines = ProbeReport.render(full, ctx)
    expect(cells(lines[0])[1]).toContain("131072")
    expect(cells(lines[3])[1]).toBe("reasoning_content")
    expect(cells(lines[5])[1]).toBe("stop, tool_calls, length")
  })

  test("a failed line is the word, then the reason code and the error text", () => {
    const lines = ProbeReport.render(
      findings({ context: { status: "failed" }, evidence: { context: "http_404: Not Found" } }),
      ctx,
    )
    expect(cells(lines[0])).toEqual(["context", "failed", "http_404: Not Found"])
  })

  test("a skipped line is the word and the reason code", () => {
    const lines = ProbeReport.render(findings({ replay: "skipped", evidence: { replay: "no_tool_turn" } }), ctx)
    expect(cells(lines[4])).toEqual(["replay", "skipped", "no_tool_turn"])
  })

  test("the reasoning_field line shows the interleaved setting the model already has", () => {
    const off = ProbeReport.render(full, ctx)[3]
    expect(off.endsWith("; interleaved: false")).toBe(true)
    const on = ProbeReport.render(full, { ...ctx, interleaved: true })[3]
    expect(on.endsWith("; interleaved: true")).toBe(true)
    const named = ProbeReport.render(full, { ...ctx, interleaved: { field: "reasoning" } })[3]
    expect(named.endsWith('; interleaved: {"field":"reasoning"}')).toBe(true)
    // No evidence text: the setting stands alone.
    const bare = ProbeReport.render(findings({ reasoningField: "absent" }), ctx)[3]
    expect(cells(bare)).toEqual(["reasoning_field", "absent", "interleaved: false"])
  })

  test("finish reasons outside the known list are marked, an empty list says none", () => {
    const marked = ProbeReport.render(findings({ finishReasons: ["stop", "eos_token", "length"] }), ctx)[5]
    expect(cells(marked)[1]).toBe("stop, eos_token (unknown), length")
    expect(cells(ProbeReport.render(findings(), ctx)[5])[1]).toBe("none")
  })

  test("secrets never appear in a line", () => {
    const lines = ProbeReport.render(
      findings({ usage: "failed", evidence: { usage: "http_401: Incorrect API key provided: fixture-key" } }),
      ctx,
    )
    expect(lines.join("\n")).not.toContain("fixture-key")
    expect(lines[1]).toContain(`Incorrect API key provided: ${ProviderRedact.REDACTED}`)
  })

  test("the evidence is redacted first and truncated after, so no prefix of a secret survives the cut", () => {
    // The secret starts five characters before the limit: cutting first would leave "fixtu" on the line.
    const head = "http_500: "
    const filler = "a".repeat(ProbePlan.EVIDENCE_MAX - head.length - 5)
    const lines = ProbeReport.render(
      findings({ usage: "failed", evidence: { usage: `${head}${filler} fixture-key tail` } }),
      ctx,
    )
    const evidence = cells(lines[1])[2]
    expect(evidence.length).toBeLessThanOrEqual(ProbePlan.EVIDENCE_MAX)
    expect(evidence.startsWith(`${head}aaa`)).toBe(true)
    expect(evidence).toContain(" [")
    expect(lines[1]).not.toContain("fix")
  })

  test("long evidence is cut to the limit and marked", () => {
    const lines = ProbeReport.render(
      findings({ usage: "failed", evidence: { usage: `http_500: ${"z".repeat(1000)}` } }),
      ctx,
    )
    const evidence = cells(lines[1])[2]
    expect(evidence.length).toBe(ProbePlan.EVIDENCE_MAX)
    expect(evidence.endsWith("…")).toBe(true)
  })

  test("a line never breaks: newlines and control characters in an error text become spaces", () => {
    const lines = ProbeReport.render(
      findings({ usage: "failed", evidence: { usage: "http_502: <html>\n<body>\r\n\tbad\u001b[31m gateway</body>" } }),
      ctx,
    )
    expect(lines).toHaveLength(6)
    expect(lines[1]).not.toMatch(/[\u0000-\u001f\u007f]/)
    expect(lines[1]).toContain("http_502: <html> <body> bad [31m gateway</body>")
  })
})
