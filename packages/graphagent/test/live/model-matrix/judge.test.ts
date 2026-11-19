// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * Offline checks of the model matrix (Issue #1474): the constants, the scenarios and their judges, the verdict
 * and regression rules, the command line, the scripted server, and the additions to the delegation-timing
 * harness the matrix stands on. No host starts and no model is called; `replay.test.ts` plays the scenarios.
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { isRecord } from "../delegation-timing/classify"
import {
  clipToolText,
  discoverModels,
  hostConfig,
  outcomeOf,
  parseOriginConfig,
  providerEnv,
  readMessages,
  seedHome,
  TOOL_TEXT_CAP,
  type ModelRef,
} from "../delegation-timing/harness"
import { startScriptServer } from "../lib/script-server"
import { matrixHostConfig, matrixHostEnv, replayOrigin, scriptProvider } from "./host-config"
import { describeNeedles, holds, replyPaths, scriptFailures } from "./judge"
import {
  buildReport,
  cellOf,
  parseBaseline,
  profileFrom,
  recordOf,
  regressionsOf,
  renderMarkdown,
  statsOf,
  verdictOf,
  type Cell,
  type Verdict,
} from "./report"
import { callsOf, caseKey, familiesOf, lastReply, runScenario, scrubber, scriptOf, tokensOf } from "./runner"
import { brokenCells, defaultOutPrefix, exitCodeOf, insideRepo, parseOptions } from "./run"
import { SCENARIOS } from "./scenarios"
import {
  CONCURRENCY,
  PASS_MIN,
  RUNS_PER_CELL,
  STEPS,
  TURN_TIMEOUT_MS,
  type Call,
  type RunView,
  type Scenario,
} from "./types"

const REPO = path.resolve(import.meta.dir, "../../../../..")
const EMPTY: RunView = { files: {}, calls: [], reply: "", todos: [], children: 0 }

const scenario = (id: string): Scenario => {
  const found = SCENARIOS.find((item) => item.id === id)
  if (!found) throw new Error(`no scenario ${id}`)
  return found
}

const done = (tool: string, text = ""): Call => ({ tool, input: {}, status: "completed", outcome: "ok", text })
const failed = (tool: string, text = ""): Call => ({
  tool,
  input: {},
  status: "error",
  outcome: "execution_error",
  text,
})

describe("constants", () => {
  test("are the values the Issue fixes", () => {
    expect(RUNS_PER_CELL).toBe(3)
    expect(PASS_MIN).toBe(2)
    expect(STEPS).toBe(8)
    expect(TURN_TIMEOUT_MS).toBe(360_000)
    expect(CONCURRENCY).toBe(3)
  })
})

describe("scenario catalogue", () => {
  test("holds the 11 read, glob, grep and bash scenarios, each once", () => {
    expect(SCENARIOS.map((item) => item.id)).toEqual([
      "read.call",
      "read.recover",
      "read.continue",
      "glob.call",
      "glob.continue",
      "grep.call",
      "grep.recover",
      "grep.continue",
      "bash.call",
      "bash.recover",
      "bash.continue",
    ])
  })

  test("every scenario has a prompt, a script that ends in text, and replays as the default family only", () => {
    for (const item of SCENARIOS) {
      expect(item.prompt.length).toBeGreaterThan(0)
      expect(item.prompt).not.toContain("[case")
      const replies = item.scripts.default.replies
      expect(replies.length).toBeGreaterThan(1)
      expect(replies.at(-1)).toHaveProperty("text")
      expect(familiesOf(item)).toEqual(["default"])
    }
  })

  test("an empty run fails every judge", () => {
    for (const item of SCENARIOS) expect(item.judge(EMPTY).length).toBeGreaterThan(0)
  })

  test("the fixtures are what the table says", () => {
    const config = scenario("read.call").files["src/config.ts"] ?? ""
    expect(config.trimEnd().split("\n")).toHaveLength(120)
    expect(config.split("\n")[46]).toBe("export const TIMEOUT_MS = 4200")
    const blob = scenario("read.continue").files["data/blob.txt"] ?? ""
    expect(blob).toHaveLength(30_000)
    expect(blob).not.toContain("\n")
    expect(blob.indexOf(" SECRET_CODE=amber-7731 ")).toBe(25_000)
    expect(Object.keys(scenario("glob.call").files).filter((file) => file.endsWith(".test.ts"))).toHaveLength(4)
    const items = Object.keys(scenario("glob.continue").files)
    expect(items).toHaveLength(150)
    expect(items[0]).toBe("data/item-001.json")
    expect(items.at(-1)).toBe("data/item-150.json")
    const parse = scenario("grep.call").files
    expect(Object.keys(parse).filter((file) => (parse[file] ?? "").includes("parseConfig"))).toEqual([
      "src/config.ts",
      "src/app.ts",
      "src/cli.ts",
    ])
    const fixmes = scenario("grep.continue").files
    const counts = Object.values(fixmes).map((text) => text.split("\n").filter((line) => line.includes("FIXME")).length)
    expect(counts).toEqual([33, 33, 33, 33, 33, 33, 33, 33, 34, 34, 34, 34])
    expect(counts.reduce((sum, count) => sum + count, 0)).toBe(400)
    expect(scenario("bash.continue").files["scripts/gen.sh"]).toContain("NEEDLE-4417")
  })

  test("the case markers keep the apply_patch family apart", () => {
    expect(caseKey("file.create", "default")).toBe("file.create")
    expect(caseKey("file.create", "apply_patch")).toBe("file.create:apply_patch")
    expect(() => scriptOf(scenario("read.call"), "apply_patch")).toThrow("no apply_patch script")
  })
})

describe("judges", () => {
  const view = (patch: Partial<RunView>): RunView => ({ ...EMPTY, ...patch })

  test("a read scenario wants a completed read and the number as a word of the reply", () => {
    const read = scenario("read.call")
    expect(read.judge(view({ calls: [done("read")], reply: "4200" }))).toEqual([])
    expect(read.judge(view({ calls: [done("read")], reply: "42000" }))).toEqual(["reply: missing /\\b4200\\b/"])
    expect(read.judge(view({ calls: [failed("read")], reply: "4200" }))).toEqual(["calls: no completed read call"])
  })

  test("a grep scenario wants exactly the paths asked for", () => {
    const grep = scenario("grep.call")
    const calls = [done("grep")]
    expect(grep.judge(view({ calls, reply: "src/app.ts\nsrc/cli.ts" }))).toEqual([])
    expect(grep.judge(view({ calls, reply: "src/cli.ts\nsrc/app.ts\nsrc/app.ts" }))).toEqual([])
    expect(grep.judge(view({ calls, reply: "src/app.ts" }))).toEqual([
      'reply: paths ["src/app.ts"], expected ["src/app.ts","src/cli.ts"]',
    ])
    expect(grep.judge(view({ calls, reply: "src/app.ts\nsrc/cli.ts\nsrc/config.ts" }))).toHaveLength(1)
    expect(replyPaths(view({ reply: "see src/a.ts, src/b.ts and docs/c.md" }))).toEqual(["src/a.ts", "src/b.ts"])
  })

  test("bash.recover wants the fix on disk, the last completed run to succeed and the reply to say so", () => {
    const recover = scenario("bash.recover")
    const build = (text: string): Call => ({ ...done("bash", text), input: { command: "sh scripts/build.sh" } })
    const calls = [build("config.toml not found"), done("bash", ""), build("build ok\n")]
    expect(recover.judge(view({ calls, files: { "config.toml": "" }, reply: "build ok" }))).toEqual([])
    // A later check that is not the build does not replace the build's result.
    const checked = [...calls, { ...done("bash", " M x"), input: { command: "git status --short" } }]
    expect(recover.judge(view({ calls: checked, files: { "config.toml": "" }, reply: "build ok" }))).toEqual([])
    const missing = recover.judge(view({ calls, files: {}, reply: "build ok" }))
    expect(missing).toEqual(["files: config.toml missing"])
    const stuck = recover.judge(view({ calls: calls.slice(0, 1), files: { "config.toml": "" }, reply: "build ok" }))
    expect(stuck).toEqual(['calls: last completed build.sh run lacks "build ok"'])
  })

  test("a failed call does not count as the named tool having run", () => {
    expect(scenario("bash.call").judge(view({ calls: [failed("bash")], reply: "build ok: 42 files" }))).toEqual([
      "calls: no completed bash call",
    ])
  })
})

describe("trap and contract", () => {
  const script = {
    replies: [],
    trap: { call: 0, includes: ["Check the path with glob."] },
    contract: [{ tool: "read", includes: ["amber", /\d{4}/] }],
  }
  const good = [failed("read", "File not found: a. Check the path with glob."), done("read", "amber-7731")]

  test("pass when the call is the failure and a completed call holds every entry", () => {
    expect(scriptFailures("x", "default", script, good)).toEqual([])
  })

  test("a trap that did not catch says what was there instead, in the fixed format", () => {
    expect(scriptFailures("read.recover", "default", script, [done("read", "ok"), good[1] ?? done("read")])).toEqual([
      'trap read.recover [default] call 0: expected error containing ["Check the path with glob."], got completed "ok"',
    ])
    expect(scriptFailures("x", "apply_patch", script, [failed("read", "File not found: a.")])[0]).toBe(
      'trap x [apply_patch] call 0: expected error containing ["Check the path with glob."], got error "File not found: a."',
    )
    expect(scriptFailures("x", "default", script, [])[0]).toBe(
      'trap x [default] call 0: expected error containing ["Check the path with glob."], got no call ""',
    )
  })

  test("an empty includes list only asks for the failure", () => {
    const bare = { replies: [], trap: { call: 1, includes: [] } }
    expect(scriptFailures("x", "default", bare, [done("read"), failed("grep", "anything")])).toEqual([])
    expect(scriptFailures("x", "default", bare, [done("read"), done("grep")])).toEqual([
      'trap x [default] call 1: expected error containing [], got completed ""',
    ])
  })

  test("a contract entry needs one completed call with every includes entry; the trapped call is no help", () => {
    expect(scriptFailures("x", "default", script, [good[0] ?? failed("read"), done("read", "amber only")])).toEqual([
      'contract x [default] read: no completed call contains ["amber", /\\d{4}/]',
    ])
    const onlyFailed = [failed("read", "amber-7731 File not found. Check the path with glob.")]
    expect(scriptFailures("x", "default", script, onlyFailed)).toHaveLength(1)
  })

  test("a text is searched case-sensitively; a pattern's g flag does not skip a match", () => {
    expect(holds("Amber", "amber")).toBe(false)
    const global = /amber/g
    expect([holds("amber", global), holds("amber", global)]).toEqual([true, true])
    expect(describeNeedles(["a", /b/i])).toBe('["a", /b/i]')
  })
})

describe("verdicts and regressions", () => {
  const cases: [Verdict[], Verdict][] = [
    [["pass", "pass", "pass"], "pass"],
    [["pass", "pass", "fail"], "pass"],
    [["pass", "pass", "error"], "pass"],
    [["pass", "fail", "fail"], "fail"],
    [["pass", "fail", "error"], "fail"],
    [["fail", "fail", "fail"], "fail"],
    [["error", "error", "pass"], "error"],
    [["error", "error", "fail"], "error"],
    [["error", "error", "error"], "error"],
    [["error", "fail", "pass"], "fail"],
  ]
  test.each(cases)("%j gives %s", (statuses, verdict) => {
    expect(verdictOf(statuses)).toBe(verdict)
  })

  const run = (status: Verdict) => ({
    status,
    failures: status === "pass" ? [] : ["reply: missing x"],
    attempts: 1,
    durationMs: 1,
    tokens: 10,
    calls: 2,
    outcomes: { ok: 1, validation_error: 1 },
  })
  const cell = (model: string, id: string, ...statuses: Verdict[]): Cell => cellOf(model, id, statuses.map(run))

  test("a cell that passed in the baseline and is fail or error now is a regression", () => {
    const baseline = new Map<string, Verdict>(
      parseBaseline({
        cells: [
          { model: "p/m", scenario: "a", verdict: "pass" },
          { model: "p/m", scenario: "b", verdict: "pass" },
          { model: "p/m", scenario: "c", verdict: "pass" },
          { model: "p/m", scenario: "d", verdict: "fail" },
        ],
      }),
    )
    const now = [
      cell("p/m", "a", "fail", "fail", "fail"),
      cell("p/m", "b", "error", "error", "error"),
      cell("p/m", "c", "pass", "pass", "pass"),
      cell("p/m", "d", "fail", "fail", "fail"),
      cell("p/m", "e", "fail", "fail", "fail"),
    ]
    expect(regressionsOf(baseline, now)).toEqual([
      { model: "p/m", scenario: "a" },
      { model: "p/m", scenario: "b" },
    ])
    expect(regressionsOf(undefined, now)).toEqual([])
  })

  test("a baseline that is not a results.json is refused", () => {
    expect(parseBaseline("nope")).toBeUndefined()
    expect(parseBaseline({ cells: [{ model: "p/m", scenario: "a", verdict: "great" }] })).toBeUndefined()
    expect(parseBaseline({ cells: [{ model: 1 }] })).toBeUndefined()
    expect(parseBaseline({ cells: [] })?.size).toBe(0)
  })

  test("the exit code is 1 for a regression or an error cell and 0 for a plain failure", () => {
    const pass = cell("p/m", "a", "pass", "pass", "pass")
    const fail = cell("p/m", "b", "fail", "fail", "fail")
    const broken = cell("p/m", "c", "error", "error", "error")
    expect(exitCodeOf(buildReport({ profiles: {}, cells: [pass, fail] }))).toBe(0)
    expect(exitCodeOf(buildReport({ profiles: {}, cells: [pass, broken] }))).toBe(1)
    const baseline = new Map<string, Verdict>([[JSON.stringify(["p/m", "b"]), "pass"]])
    expect(exitCodeOf(buildReport({ profiles: {}, cells: [pass, fail], baseline }))).toBe(1)
  })

  test("a model whose host never ran has an error cell for every scenario, and the run exits with 1", () => {
    const cells = brokenCells("p/m", SCENARIOS, "the evaluation host did not become ready")
    expect(cells.map((item) => item.scenario)).toEqual(SCENARIOS.map((item) => item.id))
    for (const item of cells) {
      expect(item.verdict).toBe("error")
      expect(item.runs).toHaveLength(RUNS_PER_CELL)
      expect(item.runs.every((entry) => entry.status === "error")).toBe(true)
    }
    expect(exitCodeOf(buildReport({ profiles: { "p/m": null }, cells }))).toBe(1)
  })

  test("the report has the matrix, the rates, the outcome counts, the tokens and the profile header", () => {
    const report = buildReport({
      profiles: {
        "p/m": { context: 128_000, output: 8_192, missing: ["reasoning"], sources: { context: "config" } },
        "q/n": null,
      },
      cells: [
        cell("p/m", "read.call", "pass", "pass", "pass"),
        cell("p/m", "grep.call", "pass", "fail", "fail"),
        cell("q/n", "read.call", "pass", "pass", "fail"),
        cell("q/n", "grep.call", "error", "error", "error"),
      ],
    })
    const text = renderMarkdown(report)
    expect(text).toContain("- `p/m`: context 128000, output 8192, missing reasoning, sources context=config")
    expect(text).toContain("- `q/n`: profile unavailable")
    expect(text).toContain("| scenario | `p/m` | `q/n` |")
    expect(text).toContain("| `read.call` | pass 3/3 | pass 2/3 |")
    expect(text).toContain("| `grep.call` | fail 1/3 | error 0/3 |")
    expect(text).toContain(
      "| model | cells passed | ok | validation_error | execution_error | denied | aborted | arguments_truncated |",
    )
    // 6 runs of 2 calls each; half of those calls are validation errors; 10 tokens a run.
    expect(text).toContain("| `p/m` | 1/2 (50.0%) | 6 | 6 | 0 | 0 | 0 | 0 | 50.0% | 60 |")
    expect(text).toContain("- `q/n` `grep.call` run 1 (error): reply: missing x")
    expect(statsOf(report, "q/n").tokens).toBe(60)
  })

  test("a run counts its calls by outcome and its tokens", () => {
    const calls: Call[] = [done("read"), failed("read"), { ...done("grep"), outcome: "validation_error" }]
    const record = recordOf({
      status: "fail",
      failures: ["x"],
      view: { ...EMPTY, calls },
      tokens: 7,
      durationMs: 3,
      attempts: 1,
    })
    expect(record.calls).toBe(3)
    expect(record.outcomes).toEqual({ ok: 1, execution_error: 1, validation_error: 1 })
    expect(record.tokens).toBe(7)
  })

  test("a retried run keeps the tokens and the calls of its first attempt; the verdict is the retry's", () => {
    const earlier = {
      status: "error" as const,
      failures: ["provider error"],
      view: { ...EMPTY, calls: [done("read"), failed("grep")] },
      tokens: 40,
      durationMs: 5,
      attempts: 1,
    }
    const record = recordOf({
      status: "pass",
      failures: [],
      view: { ...EMPTY, calls: [done("read")] },
      tokens: 7,
      durationMs: 3,
      attempts: 2,
      earlier,
    })
    expect(record).toMatchObject({ status: "pass", failures: [], attempts: 2, tokens: 47, calls: 3 })
    expect(record.outcomes).toEqual({ ok: 2, execution_error: 1 })
  })

  test("the profile is cut down to what the report shows", () => {
    const response = {
      all: [
        {
          id: "p",
          key: "sk-secret-not-for-reports",
          options: { baseURL: "https://example.com/v1", apiKey: "sk-secret" },
          models: {
            m: {
              profile: {
                context: 64_000,
                output: 4_096,
                missing: ["modalities"],
                sources: { context: "catalog" },
                vendor: "v",
              },
            },
            bare: {},
          },
        },
      ],
    }
    const profile = profileFrom(response, "p", "m")
    expect(profile).toEqual({
      context: 64_000,
      output: 4_096,
      missing: ["modalities"],
      sources: { context: "catalog" },
    })
    expect(JSON.stringify(profile)).not.toContain("sk-secret")
    expect(profileFrom(response, "p", "bare")).toBeNull()
    expect(profileFrom(response, "p", "gone")).toBeNull()
    expect(profileFrom(response, "other", "m")).toBeNull()
    expect(profileFrom({ error: true }, "p", "m")).toBeNull()
  })
})

describe("the command line", () => {
  const configured: ModelRef[] = [
    { providerID: "bailian", modelID: "qwen3-coder", family: "qwen" },
    { providerID: "zhipu", modelID: "glm-5", family: "glm" },
  ]
  const env = { GRAPHAGENT_LIVE_EVAL_CONFIG: "/somewhere/graphagent.json" }
  const error = (argv: string[], withEnv: Record<string, string | undefined> = env) => {
    const parsed = parseOptions(argv, withEnv, configured)
    return parsed.ok ? undefined : parsed.error
  }

  test("a model is required, and it must be one of the configured authorised models", () => {
    expect(error(["--model", "bailian/qwen3-coder"], {})).toContain("GRAPHAGENT_LIVE_EVAL_CONFIG")
    expect(error([])).toContain("--model is required")
    expect(error(["--model", "bailian/other"])).toContain("not a configured QWEN, GLM or DeepSeek model")
    // A model of the config that no family authorises is not in `configured` at all.
    expect(error(["--model", "openai/gpt-5"])).toContain("openai/gpt-5")
    expect(error(["--model"])).toContain("--model needs a value")
  })

  test("an unknown scenario, an unknown flag and a repeated --out are usage errors", () => {
    expect(error(["--model", "zhipu/glm-5", "--scenario", "read.call", "--scenario", "nope"])).toBe(
      "unknown scenario ids: nope",
    )
    expect(error(["--model", "zhipu/glm-5", "--verbose"])).toBe("unknown argument --verbose")
    expect(error(["--model", "zhipu/glm-5", "--out", "/a", "--out", "/b"])).toContain("once")
  })

  test("an output directory inside this repository is refused", () => {
    expect(error(["--model", "zhipu/glm-5", "--out", path.join(REPO, "results")])).toContain("inside this repository")
    expect(error(["--model", "zhipu/glm-5", "--out", path.join(REPO, "packages", "x", "..", "..", "y")])).toContain(
      "inside",
    )
    expect(insideRepo(REPO)).toBe(true)
    expect(insideRepo(path.join(REPO, "..", "elsewhere"))).toBe(false)
    expect(insideRepo("/out/inside", "/out")).toBe(true)
    expect(insideRepo("/outside", "/out")).toBe(false)
  })

  test("the root used for that is this checkout", async () => {
    const turbo = await fs.stat(path.join(REPO, "turbo.json"))
    expect(turbo.isFile()).toBe(true)
  })

  test("without --out the results go to a new directory of the OS temporary directory", () => {
    const prefix = defaultOutPrefix()
    expect(path.dirname(prefix)).toBe(os.tmpdir())
    expect(path.basename(prefix)).toBe("graphagent-model-matrix-")
  })

  test("defaults: every scenario, a temporary output directory, no baseline", () => {
    const parsed = parseOptions(["--model", "bailian/qwen3-coder"], env, configured)
    expect(parsed).toEqual({
      ok: true,
      options: { configFile: "/somewhere/graphagent.json", models: [configured[0]], scenarios: [] },
    })
  })

  test("models and scenarios repeat, in both flag spellings, without duplicates", () => {
    const parsed = parseOptions(
      [
        "--model",
        "bailian/qwen3-coder",
        "--model=zhipu/glm-5",
        "--model",
        "bailian/qwen3-coder",
        "--scenario=glob.call",
        "--out",
        "/results/run1",
        "--baseline",
        "/results/earlier/results.json",
      ],
      env,
      configured,
    )
    expect(parsed).toEqual({
      ok: true,
      options: {
        configFile: "/somewhere/graphagent.json",
        models: configured,
        scenarios: ["glob.call"],
        out: path.resolve("/results/run1"),
        baseline: path.resolve("/results/earlier/results.json"),
      },
    })
  })

  test("the configured models come from the three authorised families", () => {
    const origin = parseOriginConfig(
      JSON.stringify({
        provider: {
          a: { models: { "qwen3-coder": {}, "gpt-5": {} } },
          b: { models: { "GLM-5": {}, "deepseek-chat": {} } },
        },
      }),
    )
    expect(discoverModels(origin).map((model) => `${model.providerID}/${model.modelID}`)).toEqual([
      "a/qwen3-coder",
      "b/GLM-5",
      "b/deepseek-chat",
    ])
  })
})

describe("the scripted server", () => {
  const server = startScriptServer()
  afterEach(() => server.register("demo", []))
  afterAll(() => server.stop())

  async function ask(messages: unknown[]) {
    const response = await fetch(`${server.baseURL}/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ messages }),
    })
    const events = (await response.text())
      .split("\n\n")
      .filter((block) => block.startsWith("data: ") && !block.includes("[DONE]"))
      .map((block): unknown => JSON.parse(block.slice("data: ".length)))
    const deltas = events.flatMap((event) => {
      const choice = isRecord(event) && Array.isArray(event.choices) ? event.choices[0] : undefined
      return isRecord(choice) ? [choice] : []
    })
    const finish = deltas.map((choice) => choice.finish_reason).find((reason) => typeof reason === "string")
    const text = deltas.map((choice) => (isRecord(choice.delta) ? choice.delta.content : undefined)).join("")
    const calls = deltas.flatMap((choice) => {
      const list = isRecord(choice.delta) && Array.isArray(choice.delta.tool_calls) ? choice.delta.tool_calls : []
      return list.filter(isRecord)
    })
    const named = calls.filter((call) => isRecord(call.function) && typeof call.function.name === "string")
    return {
      finish,
      text,
      calls: named.map((call) => {
        const fn = isRecord(call.function) ? call.function : {}
        const args = calls
          .filter((part) => part.index === call.index && isRecord(part.function))
          .map((part) => (isRecord(part.function) ? part.function.arguments : ""))
          .join("")
        return { id: call.id, name: fn.name, input: JSON.parse(args) }
      }),
    }
  }

  const user = (text: string) => ({ role: "user", content: text })
  const assistant = { role: "assistant", content: null, tool_calls: [] }

  test("answers the runtime's title request, a request with no marker, and a request past the script", async () => {
    server.register("demo", [{ text: "one" }])
    expect((await ask([user("Generate a title for this conversation:\n"), user("hi [case demo]")])).text).toBe(
      "E2E Title",
    )
    expect((await ask([user("hi")])).text).toBe("ok")
    expect((await ask([user("hi [case unregistered]")])).text).toBe("ok")
    expect((await ask([user("hi [case demo]"), assistant])).text).toBe("done")
  })

  test("plays reply n for the request that follows n assistant messages", async () => {
    server.register("demo", [
      { calls: [{ name: "read", input: { filePath: "a.ts" } }] },
      {
        calls: [
          { name: "glob", input: { pattern: "*" } },
          { name: "grep", input: { pattern: "x" } },
        ],
      },
      { text: "fin" },
    ])
    const first = await ask([{ role: "system", content: "s" }, user("task [case demo]")])
    expect(first.finish).toBe("tool_calls")
    expect(first.calls).toEqual([{ id: "call_demo_0_0", name: "read", input: { filePath: "a.ts" } }])
    const second = await ask([user("task [case demo]"), assistant])
    expect(second.calls.map((call) => [call.id, call.name])).toEqual([
      ["call_demo_1_0", "glob"],
      ["call_demo_1_1", "grep"],
    ])
    const last = await ask([user("task [case demo]"), assistant, assistant])
    expect(last).toMatchObject({ finish: "stop", text: "fin", calls: [] })
  })

  test("the marker is read from the first user message, in a string or in text parts", async () => {
    server.register("demo", [{ text: "from parts" }])
    const parts = { role: "user", content: [{ type: "text", text: "task\n[case demo]" }] }
    expect((await ask([parts, user("[case other]")])).text).toBe("from parts")
  })

  test("<saved> becomes the saved-output path of the latest tool result, and stays when there is none", async () => {
    server.register("demo", [
      { calls: [{ name: "x", input: {} }] },
      { calls: [{ name: "grep", input: { pattern: "NEEDLE", path: "<saved>", nested: ["<saved>:1"] } }] },
    ])
    const saved = "/tmp/gm-a1/home/.local/share/graphagent/tool-output/tool_01abcDEF"
    const old = { role: "tool", content: "path: /tmp/gm-a1/home/.local/share/graphagent/tool-output/tool_old000" }
    const latest = { role: "tool", content: `[truncated]\npath: ${saved}\nstart:  read filePath="${saved}"` }
    // Two parallel calls of one turn left two results: the later one names the path.
    const withPath = await ask([user("[case demo]"), assistant, old, latest])
    expect(withPath.calls[0]?.input).toEqual({ pattern: "NEEDLE", path: saved, nested: [`${saved}:1`] })
    const without = await ask([user("[case demo]"), assistant, { role: "tool", content: "no path here" }])
    expect(without.calls[0]?.input).toEqual({ pattern: "NEEDLE", path: "<saved>", nested: ["<saved>:1"] })
    // The path is read from a text-parts content as well.
    const parts = { role: "tool", content: [{ type: "text", text: `path: ${saved}` }] }
    expect((await ask([user("[case demo]"), assistant, parts])).calls[0]?.input).toMatchObject({ path: saved })
  })

  test("only a POST is answered", async () => {
    expect((await fetch(`${server.baseURL}/models`)).status).toBe(404)
  })
})

describe("the host the matrix builds on", () => {
  const roots: string[] = []
  const saved: Record<string, string | undefined> = {}
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })
  const setEnv = (name: string, value: string | undefined) => {
    if (!(name in saved)) saved[name] = process.env[name]
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  const temp = async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gm-test-"))
    roots.push(dir)
    return dir
  }
  const exists = (file: string) =>
    fs.access(file).then(
      () => true,
      () => false,
    )

  test("seedHome without an audit file writes no hooks.json, and with one writes the hook", async () => {
    const quiet = await temp()
    await seedHome(quiet)
    expect(await exists(path.join(quiet, ".config", "graphagent", "hooks.json"))).toBe(false)
    expect(await exists(path.join(quiet, ".config", "graphagent", "memory.jsonc"))).toBe(true)
    expect(await exists(path.join(quiet, "tmp"))).toBe(true)
    const audited = await temp()
    await seedHome(audited, path.join(audited, "audit.jsonl"))
    expect(await exists(path.join(audited, ".config", "graphagent", "hooks.json"))).toBe(true)
  })

  test("providerEnv throws for an unset variable, and passes and scrubs a set one", () => {
    const origin = parseOriginConfig(
      JSON.stringify({
        provider: { p: { options: { apiKey: "{env:MATRIX_1474_KEY}", baseURL: "{env:MATRIX_1474_URL}" } } },
      }),
    )
    setEnv("MATRIX_1474_KEY", undefined)
    setEnv("MATRIX_1474_URL", undefined)
    expect(() => providerEnv(origin, { providerID: "p" })).toThrow(
      "the provider block refers to unset environment variables: MATRIX_1474_KEY, MATRIX_1474_URL",
    )
    setEnv("MATRIX_1474_KEY", "sk-test-1474-secret")
    setEnv("MATRIX_1474_URL", "https://llm.example.com/v1")
    const { passthrough, redact } = providerEnv(origin, { providerID: "p" })
    expect(passthrough).toEqual({
      MATRIX_1474_KEY: "sk-test-1474-secret",
      MATRIX_1474_URL: "https://llm.example.com/v1",
    })
    // A referenced value is scrubbed whatever it is (here an endpoint); any other URL goes too, a local one stays.
    const text =
      "key sk-test-1474-secret at https://llm.example.com/v1/chat or https://other.example.org/a or http://127.0.0.1:9/v1"
    expect(redact(text)).toBe("key <redacted> at <redacted>/chat or <url> or http://127.0.0.1:9/v1")
    expect(providerEnv(origin, { providerID: "unknown" }).passthrough).toEqual({})
  })

  test("the matrix config adds the scripted provider, makes the model under test the small model, fixes compaction", () => {
    const origin = parseOriginConfig(JSON.stringify({ provider: { p: { models: { "qwen3-coder": {} } } } }))
    const model = { providerID: "p", modelID: "qwen3-coder" }
    const config = matrixHostConfig({ origin, model, scriptURL: "http://127.0.0.1:1/v1", home: "/h" })
    expect(config.model).toBe("p/qwen3-coder")
    expect(config.small_model).toBe("p/qwen3-coder")
    expect(config.compaction).toEqual({ auto: false, tail_turns: 0, mode: "small" })
    expect(config.agent).toMatchObject({ build: { steps: STEPS } })
    const providers = isRecord(config.provider) ? config.provider : {}
    expect(Object.keys(providers).sort()).toEqual(["p", "script", "stub"])
    const script = scriptProvider("http://127.0.0.1:1/v1")
    expect(providers.script).toEqual(script)
    expect(script).toMatchObject({ npm: "@ai-sdk/openai-compatible", options: { baseURL: "http://127.0.0.1:1/v1" } })
    const models = isRecord(script.models) ? script.models : {}
    expect(Object.keys(models)).toEqual(["scripted", "gpt-scripted"])
    expect(models.scripted).toMatchObject({ limit: { context: 100_000, output: 10_000 }, tool_call: true })
    // The delegation-timing config stays what it was where the matrix does not touch it.
    const base = hostConfig({ origin, model, stubURL: "http://127.0.0.1:1/v1", stepCap: STEPS, home: "/h" })
    expect(config.permission).toEqual(base.permission)
    expect(config.lsp).toBe(false)
  })

  test("the replay origin holds only the scripted provider", () => {
    expect(Object.keys(replayOrigin("http://127.0.0.1:1/v1").providers)).toEqual(["script"])
  })

  test("the matrix host environment adds only the runtime-asset locations, and only when they are set", () => {
    setEnv("GRAPHAGENT_RUNTIME_ASSET_CACHE", undefined)
    setEnv("GRAPHAGENT_RUNTIME_ASSETS_DIR", undefined)
    setEnv("GRAPHAGENT_RUNTIME_ASSET_MIRROR", "https://mirror.example.com")
    const input = { home: "/h", config: {}, passthrough: {} }
    const bare = matrixHostEnv(input)
    expect(Object.keys(bare).filter((name) => name.includes("RUNTIME_ASSET"))).toEqual([])
    setEnv("GRAPHAGENT_RUNTIME_ASSET_CACHE", "/cache/assets")
    setEnv("GRAPHAGENT_RUNTIME_ASSETS_DIR", "/packaged/assets")
    const set = matrixHostEnv(input)
    expect(set.GRAPHAGENT_RUNTIME_ASSET_CACHE).toBe("/cache/assets")
    expect(set.GRAPHAGENT_RUNTIME_ASSETS_DIR).toBe("/packaged/assets")
    expect(set.GRAPHAGENT_RUNTIME_ASSET_MIRROR).toBeUndefined()
    // The rest is the allow-list the delegation-timing host uses.
    expect(set.HOME).toBe("/h")
    expect(set.GRAPHAGENT_DISABLE_PROJECT_CONFIG).toBe("1")
  })

  test("the transcript reader gives a tool part its output, error and outcome, and a message its tokens", () => {
    const tool = (state: Record<string, unknown>) => ({ type: "tool", tool: "read", callID: "c", state })
    const json = [
      { info: { id: "m1", role: "user" }, parts: [{ type: "text", text: "go" }] },
      {
        info: {
          id: "m2",
          role: "assistant",
          tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 30, write: 10 } },
        },
        parts: [
          tool({ status: "completed", input: { a: 1 }, output: "fine", metadata: {} }),
          tool({ status: "completed", input: {}, output: "blocked", metadata: { hookDenied: true } }),
          tool({ status: "error", input: {}, error: "bad", metadata: { outcome: "validation_error" } }),
          tool({ status: "error", input: {}, error: "boom" }),
          tool({ status: "error", input: {}, error: "odd", metadata: { outcome: "made_up" } }),
          tool({ status: "running", input: {} }),
        ],
      },
    ]
    const [user, model] = readMessages(json)
    expect(user?.tokens).toEqual({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })
    expect(model?.tokens).toEqual({ input: 100, output: 20, reasoning: 5, cache: { read: 30, write: 10 } })
    const parts = model?.parts ?? []
    expect(parts.map((part) => [part.status, part.outcome])).toEqual([
      ["completed", "ok"],
      ["completed", "denied"],
      ["error", "validation_error"],
      ["error", "execution_error"],
      ["error", "execution_error"],
      ["running", undefined],
    ])
    expect(parts[0]?.output).toBe("fine")
    expect(parts[2]?.error).toBe("bad")
    expect(parts[0]?.error).toBeUndefined()
    expect(outcomeOf("pending", {})).toBeUndefined()
    // What the runner makes of them.
    const calls = callsOf(readMessages(json))
    expect(calls.map((call) => [call.status, call.outcome, call.text])).toEqual([
      ["completed", "ok", "fine"],
      ["completed", "denied", "blocked"],
      ["error", "validation_error", "bad"],
      ["error", "execution_error", "boom"],
      ["error", "execution_error", "odd"],
      ["error", "aborted", "(the call did not finish: running)"],
    ])
    // The cached input counts: the session keeps it out of `input`.
    expect(tokensOf(readMessages(json))).toBe(165)
  })

  test("a run that breaks before a verdict is an error, tried once more, and its reason is redacted", async () => {
    // A host nobody listens at: the first request of the run fails, which is the run's failure, not the model's.
    const closed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") })
    const url = `http://127.0.0.1:${closed.port}`
    await closed.stop(true)
    const root = await temp()
    const script = startScriptServer()
    try {
      const result = await runScenario(
        {
          mode: "replay",
          host: { url, stderrTail: () => "", stop: async () => {} },
          script,
          home: root,
          work: root,
          model: { providerID: "script", modelID: "scripted" },
          timeoutMs: 5_000,
          redact: (value) => `redacted: ${value.length > 0}`,
        },
        scenario("read.call"),
        "default",
      )
      expect(result).toMatchObject({ status: "error", attempts: 2, failures: ["redacted: true"], tokens: 0 })
      expect(result.view).toBeUndefined()
      expect(result.earlier).toMatchObject({ status: "error", attempts: 1, failures: ["redacted: true"] })
    } finally {
      script.stop()
    }
  })

  test("a long result keeps its first and its last characters", () => {
    const short = "x".repeat(2 * TOOL_TEXT_CAP)
    expect(clipToolText(short)).toBe(short)
    const long = `${"a".repeat(TOOL_TEXT_CAP)}${"#".repeat(500)}${"z".repeat(TOOL_TEXT_CAP)}`
    const clipped = clipToolText(long)
    expect(clipped.startsWith("a".repeat(TOOL_TEXT_CAP))).toBe(true)
    expect(clipped.endsWith("z".repeat(TOOL_TEXT_CAP))).toBe(true)
    expect(clipped).toContain("[... 500 characters omitted ...]")
    expect(clipped).not.toContain("#")
  })

  test("the last reply is the last non-synthetic assistant text", () => {
    const text = (value: string, synthetic = false) => ({
      type: "text",
      text: value,
      ...(synthetic ? { synthetic } : {}),
    })
    const messages = readMessages([
      { info: { id: "1", role: "assistant" }, parts: [text("first")] },
      { info: { id: "2", role: "assistant" }, parts: [text("second"), text("injected", true)] },
      { info: { id: "3", role: "user" }, parts: [text("user words")] },
    ])
    expect(lastReply(messages)).toBe("second")
    expect(lastReply([])).toBe("")
  })

  test("a text is scrubbed of the longest place first, then redacted", () => {
    const scrub = scrubber(
      [
        ["/t/gm-1", "<root>"],
        ["/t/gm-1/w", "<work>"],
      ],
      (value) => value.replaceAll("secret", "<redacted>"),
    )
    expect(scrub("/t/gm-1/w/a and /t/gm-1/home with secret")).toBe("<work>/a and <root>/home with <redacted>")
  })
})
