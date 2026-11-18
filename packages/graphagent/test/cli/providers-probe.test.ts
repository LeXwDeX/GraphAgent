// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// `graphagent providers probe <provider>/<model>` end to end: a real CLI subprocess against the scripted
// TestLLMServer. Nothing leaves the machine, and the only credential is the fixture key `test-key`.
import { beforeAll, describe, expect } from "bun:test"
import { Effect } from "effect"
import { setLanguage, t } from "@graphagent/tui/i18n"
import { cliIt } from "../lib/cli-process"
import { httpError, reply } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"

const KEY = "test-key"
const PLAN_LINE = "Sends at most 6 requests, each capped at 256 output tokens"

beforeAll(() => setLanguage("en"))

const configWith = (url: string, npm: string) => {
  const base = testProviderConfig(url)
  return JSON.stringify({ ...base, provider: { test: { ...base.provider.test, npm } } })
}

describe("graphagent providers probe", () => {
  cliIt.live(
    "is registered under providers and under its alias auth",
    ({ graphagent }) =>
      Effect.gen(function* () {
        for (const group of ["providers", "auth"]) {
          const result = yield* graphagent.spawn([group, "probe", "--help"], { env: { COLUMNS: "120" } })
          graphagent.expectExit(result, 0, `${group} probe --help`)
          expect(result.stderr).toContain(`probe <model>`)
          expect(result.stderr).toContain(t("cli.providers.probe.describe"))
          expect(result.stderr).toContain(t("cli.providers.probe.arg.model"))
        }
        const list = yield* graphagent.spawn(["providers", "--help"], { env: { COLUMNS: "120" } })
        expect(list.stderr).toContain("probe <model>")
      }),
    120_000,
  )

  cliIt.live(
    "an unknown model, provider or argument without a slash fails before any request",
    ({ graphagent, llm }) =>
      Effect.gen(function* () {
        const cases: Array<[string, string]> = [
          ["test/nope", t("cli.providers.probe.modelNotFound", { model: "test/nope" })],
          ["nope/anything", t("cli.providers.probe.modelNotFound", { model: "nope/anything" })],
          ["test-model", t("cli.providers.probe.invalidModel", { value: "test-model" })],
          ["/test-model", t("cli.providers.probe.invalidModel", { value: "/test-model" })],
          ["test/", t("cli.providers.probe.invalidModel", { value: "test/" })],
        ]
        for (const [model, message] of cases) {
          const result = yield* graphagent.spawn(["providers", "probe", model])
          graphagent.expectExit(result, 1, `probe ${model}`)
          expect(result.stdout).toBe("")
          expect(result.stderr).toContain(message)
          expect(result.stderr).not.toContain(PLAN_LINE)
        }
        expect(yield* llm.calls).toBe(0)
      }),
    180_000,
  )

  cliIt.live(
    "a model that is not OpenAI-compatible is refused before any request",
    ({ graphagent, llm }) =>
      Effect.gen(function* () {
        const result = yield* graphagent.spawn(["providers", "probe", "test/test-model"], {
          env: { GRAPHAGENT_CONFIG_CONTENT: configWith(llm.url, "@ai-sdk/anthropic") },
        })
        graphagent.expectExit(result, 1, "probe non-openai-compatible")
        expect(result.stdout).toBe("")
        expect(result.stderr).toContain(
          t("cli.providers.probe.unsupported", { model: "test/test-model", npm: "@ai-sdk/anthropic" }),
        )
        expect(result.stderr).not.toContain(PLAN_LINE)
        expect(yield* llm.calls).toBe(0)
      }),
    60_000,
  )

  cliIt.live(
    "every chat request answered 401: exit 1, empty stdout, a report on stderr, and no key anywhere",
    ({ graphagent, llm }) =>
      Effect.gen(function* () {
        // The endpoint echoes the key in its error text, as some gateways do.
        const denied = httpError(401, { error: { message: `Incorrect API key provided: ${KEY}` } })
        yield* llm.push(denied, denied, denied, denied, denied)

        const result = yield* graphagent.spawn(["providers", "probe", "test/test-model"])
        graphagent.expectExit(result, 1, "probe all 401")

        expect(result.stdout).toBe("")
        expect(result.stderr).toContain(PLAN_LINE)
        expect(result.stderr).toContain(t("cli.providers.probe.noResponse"))
        // The report: the tool probe failed, so the replay probes were skipped and four requests went out.
        expect(result.stderr).toMatch(/usage\s+failed\s+auth/)
        expect(result.stderr).toMatch(/tool_call\s+failed\s+auth/)
        expect(result.stderr).toMatch(/replay\s+skipped\s+no_tool_turn/)
        expect(result.stderr).toContain("[redacted]")
        expect(result.stdout).not.toContain(KEY)
        expect(result.stderr).not.toContain(KEY)
        expect(yield* llm.calls).toBe(3)
      }),
    120_000,
  )

  cliIt.live(
    "a credential header of the model is masked in the report, with and without its Bearer prefix",
    ({ graphagent, llm }) =>
      Effect.gen(function* () {
        const base = testProviderConfig(llm.url)
        const declared = base.provider.test.models["test-model"]
        const config = JSON.stringify({
          ...base,
          provider: {
            test: {
              ...base.provider.test,
              models: { "test-model": { ...declared, headers: { "X-Api-Token": "Bearer header-token-123" } } },
            },
          },
        })
        // One gateway echoes the header as sent, another only the token.
        const echoed = httpError(401, { error: { message: "rejected X-Api-Token: Bearer header-token-123" } })
        const tokenOnly = httpError(401, { error: { message: "bad token header-token-123 for key test-key" } })
        yield* llm.push(echoed, tokenOnly, echoed, tokenOnly)

        const result = yield* graphagent.spawn(["providers", "probe", "test/test-model"], {
          env: { GRAPHAGENT_CONFIG_CONTENT: config },
        })
        graphagent.expectExit(result, 1, "probe masks credential headers")

        expect(result.stderr).toContain("[redacted]")
        for (const secret of ["header-token-123", KEY]) {
          expect(result.stdout).not.toContain(secret)
          expect(result.stderr).not.toContain(secret)
        }
      }),
    120_000,
  )

  cliIt.live(
    "a header of any name is masked in the report, unless its value is too short to be a secret",
    ({ graphagent, llm }) =>
      Effect.gen(function* () {
        const base = testProviderConfig(llm.url)
        const declared = base.provider.test.models["test-model"]
        const headers = {
          "X-Custom-Auth": "custom-auth-value-456",
          Cookie: "session=cookie-value-789",
          "X-Edge-Auth": "Bearer tok7",
          "X-Tenant": "7",
        }
        const config = JSON.stringify({
          ...base,
          provider: {
            test: { ...base.provider.test, models: { "test-model": { ...declared, headers } } },
          },
        })
        // The gateway echoes every header value in its error text, the tenant number and a bare token among them.
        const message = "rejected custom-auth-value-456, session=cookie-value-789, token tok7, tenant 7"
        const echoed = httpError(401, { error: { message } })
        yield* llm.push(echoed, echoed, echoed, echoed)

        const result = yield* graphagent.spawn(["providers", "probe", "test/test-model"], {
          env: { GRAPHAGENT_CONFIG_CONTENT: config },
        })
        graphagent.expectExit(result, 1, "probe masks headers of any name")

        expect(result.stderr).toContain("[redacted]")
        for (const secret of ["custom-auth-value-456", "cookie-value-789", "tok7"]) {
          expect(result.stdout).not.toContain(secret)
          expect(result.stderr).not.toContain(secret)
        }
        // A value this short names no credential: masking "7" would blank every 7 in the report.
        expect(result.stderr).toContain("tenant 7")
      }),
    120_000,
  )

  cliIt.live(
    "every chat request carries the model's request options, and the probe's own limits still hold",
    ({ graphagent, llm }) =>
      Effect.gen(function* () {
        const base = testProviderConfig(llm.url)
        const declared = base.provider.test.models["test-model"]
        // `max_tokens` among the options would replace the probe's cap in the body if it were passed on.
        const options = { enable_thinking: true, custom_flag: "on", max_tokens: 4_096 }
        const config = JSON.stringify({
          ...base,
          provider: {
            test: { ...base.provider.test, models: { "test-model": { ...declared, options } } },
          },
        })
        yield* llm.push(
          reply().text("ok").stop(),
          reply().tool("probe_echo", { text: "ping" }),
          reply().text("1\n2\n3").stop(),
        )

        const result = yield* graphagent.spawn(["providers", "probe", "test/test-model"], {
          env: { GRAPHAGENT_CONFIG_CONTENT: config },
        })
        graphagent.expectExit(result, 0, "probe with request options")

        // No reasoning came back, so the replay probes were skipped: three chat requests, all with the options.
        expect(yield* llm.calls).toBe(3)
        const bodies = yield* llm.inputs
        expect(bodies.map((body) => body.enable_thinking)).toEqual([true, true, true])
        expect(bodies.map((body) => body.custom_flag)).toEqual(["on", "on", "on"])
        expect(bodies.map((body) => body.max_tokens)).toEqual([256, 256, 16])
        expect(bodies.every((body) => body.stream === true)).toBe(true)
      }),
    120_000,
  )

  cliIt.live(
    "the engine's own request options for the model are sent too: the thinking switch of a reasoning model on alibaba-cn",
    ({ graphagent, llm }) =>
      Effect.gen(function* () {
        const base = testProviderConfig(llm.url)
        const declared = base.provider.test.models["test-model"]
        const config = JSON.stringify({
          ...base,
          provider: {
            "alibaba-cn": {
              ...base.provider.test,
              id: "alibaba-cn",
              models: { "test-model": { ...declared, reasoning: true } },
            },
          },
        })
        yield* llm.push(
          reply().reason("thinking about the word").text("ok").stop(),
          reply().tool("probe_echo", { text: "ping" }),
          reply().text("done").stop(),
          reply().text("done").stop(),
          reply().text("1\n2\n3").stop(),
        )

        const result = yield* graphagent.spawn(["providers", "probe", "alibaba-cn/test-model"], {
          env: { GRAPHAGENT_CONFIG_CONTENT: config },
        })
        graphagent.expectExit(result, 0, "probe on alibaba-cn")

        // Reasoning came back, so all five chat requests went out, the replay probes among them.
        expect(yield* llm.calls).toBe(5)
        const bodies = yield* llm.inputs
        expect(bodies.map((body) => body.enable_thinking)).toEqual([true, true, true, true, true])
      }),
    120_000,
  )

  cliIt.live(
    "succeeds with a snippet on stdout and the plan and report on stderr",
    ({ graphagent, llm }) =>
      Effect.gen(function* () {
        yield* llm.push(
          // stream: reasoning, text and usage
          reply().reason("thinking about the word").text("ok").usage({ input: 12, output: 3 }).stop(),
          // tool: reasoning and the probe_echo call
          reply().reason("I should call the tool").tool("probe_echo", { text: "ping" }),
          // replay_with: accepted
          reply().text("done").stop(),
          // replay_without: refused
          httpError(400, { error: { message: "reasoning_content is required" } }),
          // length
          reply().text("1\n2\n3").stop(),
        )

        const result = yield* graphagent.spawn(["providers", "probe", "test/test-model"])
        graphagent.expectExit(result, 0, "probe success")

        // stdout: one JSON object, two-space indent, trailing newline, only the keys the probe measured.
        expect(result.stdout.endsWith("}\n")).toBe(true)
        const snippet = JSON.parse(result.stdout)
        expect(snippet).toEqual({
          provider: {
            test: {
              models: {
                "test-model": {
                  reasoning: true,
                  // The engine replays reasoning under `interleaved`, so the snippet names the measured field there.
                  interleaved: { field: "reasoning_content" },
                  profile: { reasoning_mode: { replay: "field" } },
                },
              },
            },
          },
        })
        expect(result.stdout).toBe(JSON.stringify(snippet, null, 2) + "\n")

        // stderr: the plan line first, then one report line per item.
        expect(result.stderr).toContain(PLAN_LINE)
        expect(result.stderr.indexOf(PLAN_LINE)).toBeLessThan(result.stderr.indexOf("usage"))
        expect(result.stderr).toMatch(/usage\s+reported/)
        expect(result.stderr).toMatch(/tool_call\s+supported/)
        expect(result.stderr).toMatch(/reasoning_field\s+reasoning_content/)
        expect(result.stderr).toMatch(/replay\s+required/)
        expect(result.stderr).toMatch(/finish_reasons\s+stop, tool_calls/)
        expect(result.stderr).toContain("interleaved: false")
        // The models route does not exist on the scripted endpoint: that item failed, the rest went on.
        expect(result.stderr).toMatch(/context\s+failed\s+http_404/)

        // Five chat requests, each capped at 256 output tokens (16 for the length probe), all streamed.
        expect(yield* llm.calls).toBe(5)
        const bodies = yield* llm.inputs
        expect(bodies.map((body) => body.max_tokens)).toEqual([256, 256, 256, 256, 16])
        expect(bodies.every((body) => body.stream === true)).toBe(true)
        // The stream probe asks for usage the way the engine does.
        expect(bodies[0].stream_options).toEqual({ include_usage: true })

        expect(result.stdout).not.toContain(KEY)
        expect(result.stderr).not.toContain(KEY)
      }),
    120_000,
  )
})
