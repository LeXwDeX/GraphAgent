// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, test } from "bun:test"
import { jsonSchema, tool } from "ai"
import { Effect, Logger } from "effect"
import { ModelV2 } from "@graphagent/core/model"
import { ProviderV2 } from "@graphagent/core/provider"
import { SessionV1 } from "@graphagent/core/v1/session"
import { Injection } from "@graphagent/core/system-context/injection"
import { DEFAULT_WRITING_STYLE } from "@graphagent/core/system-context/writing-style"
import { Hash } from "@graphagent/core/util/hash"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EngineProcess } from "@/session/engine-process"
import type { LLM } from "@/session/llm"
import { LLMRequestPrep } from "@/session/llm/request"
import { estimateOverhead, serializedTools } from "@/session/overflow"
import { RuntimeContext } from "@/session/runtime-context"
import { SessionID } from "@/session/schema"
import type { SystemSection } from "@/session/step-metrics"
import { SystemPrompt } from "@/session/system"
import { Overhead } from "@/session/turn/overhead"
import { Token } from "@/util/token"
import { ProviderTest } from "../fake/provider"

const sessionID = SessionID.make("ses_overhead_unit")
const model = ProviderTest.model({ providerID: ProviderV2.ID.make("test"), id: ModelV2.ID.make("test-model") })

const readTool = tool({ description: "Read a file", inputSchema: jsonSchema({ type: "object", properties: {} }) })

const instruction = (file: string, text = "# Rules") => Injection.wrap("instruction-file", text, { path: file })

const entry = (content: string, key = "goal"): RuntimeContext.Entry => ({
  kind: "state",
  key,
  index: 0,
  anchor: "anchor",
  content,
})

function streamInput(overrides: Partial<LLM.StreamInput> = {}): LLM.StreamInput {
  return {
    user: {
      id: SessionV1.MessageID.make("msg_overhead_unit"),
      sessionID,
      role: "user",
      time: { created: 0 },
      agent: "build",
      model: { providerID: model.providerID, modelID: model.id },
    },
    sessionID,
    model,
    agent: { name: "build", mode: "primary", permission: [], options: {} },
    system: ["Environment facts.", instruction("/repo/AGENTS.md"), "Runtime note."],
    systemLabels: ["environment", "instructions", "runtime_note"],
    messages: [],
    tools: { read: readTool },
    ...overrides,
  }
}

const hash = (text: string) => Hash.sha256(text).slice(0, 16)

const manifestOf = (input: Partial<Parameters<typeof Overhead.buildManifest>[0]> = {}) =>
  Overhead.buildManifest({
    model: "test/test-model",
    base: ["Base prompt."],
    system: ["Environment facts."],
    labels: ["environment"],
    toolsText: '[{"name":"read"}]',
    ledger: [],
    ...input,
  })

const logs: Array<{ level: string; message: ReadonlyArray<unknown> }> = []
const capture = Logger.make((options) => {
  logs.push({ level: options.logLevel, message: Array.isArray(options.message) ? options.message : [options.message] })
})
// The capture replaces the default logger, so the test output stays free of the lines under test.
const run = <A>(effect: Effect.Effect<A>) => Effect.runPromise(effect.pipe(Effect.provide(Logger.layer([capture]))))
const infos = () => logs.filter((item) => item.message[0] === "session request manifest")
const warnings = () => logs.filter((item) => item.message[0] === "request manifest skipped")

afterEach(async () => {
  logs.length = 0
  await Effect.runPromise(EngineProcess.runtimes.remove(sessionID))
})

describe("Overhead.buildManifest", () => {
  test("returns undefined without one label for each system text", () => {
    expect(manifestOf({ labels: undefined })).toBeUndefined()
    expect(manifestOf({ labels: [] })).toBeUndefined()
    expect(manifestOf({ system: ["a", "b"], labels: ["environment"] })).toBeUndefined()
    expect(manifestOf({ system: ["a"], labels: ["environment", "language"] })).toBeUndefined()
    // Neither side holds a text: the lengths agree.
    expect(manifestOf({ system: [], labels: [] })).toBeDefined()
  })

  test("lists the base, each system text under its label, the tools and each ledger block, in that order", () => {
    const labels: SystemSection[] = ["environment", "language", "instructions", "runtime_note"]
    const manifest = manifestOf({
      base: ["Base prompt.", "Writing style."],
      system: ["env", "lang", instruction("/repo/AGENTS.md"), "note"],
      labels,
      toolsText: "[tools]",
      ledger: [entry("goal block"), entry("memory block", "memory")],
    })
    expect(manifest?.entries.map((item) => item.source)).toEqual([
      "base",
      "environment",
      "language",
      "instructions",
      "runtime_note",
      "tools",
      "runtime_context",
      "runtime_context",
    ])
    // The base entry is the whole base joined the way the request joins it.
    expect(manifest?.entries[0]?.hash).toBe(hash("Base prompt.\nWriting style."))
    expect(manifest?.entries[5]?.hash).toBe(hash("[tools]"))
    expect(manifest?.entries[6]?.hash).toBe(hash("goal block"))
    expect(manifest?.entries[7]?.hash).toBe(hash("memory block"))
    expect(manifest?.model).toBe("test/test-model")
  })

  test("does not record a text that is empty", () => {
    const manifest = manifestOf({
      base: [],
      system: ["env", ""],
      labels: ["environment", "language"],
      toolsText: "",
      ledger: [entry("")],
    })
    expect(manifest?.entries.map((item) => item.source)).toEqual(["environment"])
  })

  test("measures bytes, estimated tokens and a 16-character hash of each text", () => {
    const text = "中文 and English"
    const manifest = manifestOf({ system: [text], labels: ["environment"] })
    const item = manifest?.entries.find((candidate) => candidate.source === "environment")
    expect(item?.bytes).toBe(Buffer.byteLength(text))
    expect(item?.bytes).toBeGreaterThan(text.length)
    expect(item?.tokens).toBe(Token.estimateReserve(text))
    expect(item?.hash).toMatch(/^[0-9a-f]{16}$/)
    expect(item?.hash).toBe(Hash.sha256(text).slice(0, 16))
  })

  test("totals the bytes and the estimated tokens of its entries", () => {
    const manifest = manifestOf({ ledger: [entry("goal block")] })!
    expect(manifest.bytes).toBe(manifest.entries.reduce((sum, item) => sum + item.bytes, 0))
    expect(manifest.tokens).toBe(manifest.entries.reduce((sum, item) => sum + item.tokens, 0))
    expect(manifest.bytes).toBeGreaterThan(0)
    expect(manifest.window).toBeUndefined()
    expect(manifest.windowSource).toBeUndefined()
  })

  test("names an instruction file by the path attribute of its opening tag, as written", () => {
    const remote = "https://example.invalid/rules?a=1&b=2"
    const manifest = manifestOf({
      system: [instruction("/repo/AGENTS.md"), instruction('/repo/a&b"c/AGENTS.md'), instruction(remote), "plain text"],
      labels: ["instructions", "instructions", "instructions", "instructions"],
    })
    const labels = manifest?.entries.filter((item) => item.source === "instructions").map((item) => item.label)
    // The value stays in the entity form the engine wrote it in; nothing is decoded.
    expect(labels).toEqual([
      "/repo/AGENTS.md",
      "/repo/a&amp;b&quot;c/AGENTS.md",
      "https://example.invalid/rules?a=1&amp;b=2",
      undefined,
    ])
    expect(manifest?.entries.every((item) => item.label === undefined || item.source === "instructions")).toBe(true)
  })

  test("labels nothing but instruction files", () => {
    const text = '<system-reminder source="mcp-instructions" server="s" path="/not/a/file">\nnotes\n</system-reminder>'
    const manifest = manifestOf({ system: [text], labels: ["mcp_instructions"] })
    expect(manifest?.entries.find((item) => item.source === "mcp_instructions")?.label).toBeUndefined()
  })

  test("takes the path of an unavailable instruction file too", () => {
    const text =
      '<system-reminder source="instruction-file" path="https://example.invalid/x" status="unavailable">\n\n</system-reminder>'
    const manifest = manifestOf({ system: [text], labels: ["instructions"] })
    expect(manifest?.entries.find((item) => item.source === "instructions")?.label).toBe("https://example.invalid/x")
  })
})

describe("Overhead.record", () => {
  const input = (requestOverheads = new Map<SessionID, number>()) => ({ sessionID, model, requestOverheads })

  test("records the overhead of the request as sent: base prompt, system texts, ledger blocks and tools", async () => {
    const requestOverheads = new Map<SessionID, number>()
    const processInput = streamInput()
    const ledger = [entry("goal block")]
    await run(Overhead.record(input(requestOverheads), { processInput, toolsJson: undefined, ledger }))

    const recorded = requestOverheads.get(sessionID)!
    const system = LLMRequestPrep.requestSystem(processInput)
    expect(recorded).toBe(estimateOverhead({ system: [...system, "goal block"], tools: processInput.tools }))
    // The base prompt and the writing style are part of it: the estimate over the engine's system texts alone is smaller.
    expect(system.join("\n")).toContain(DEFAULT_WRITING_STYLE)
    expect(recorded).toBeGreaterThan(
      estimateOverhead({ system: [...processInput.system, "goal block"], tools: processInput.tools }) + 100,
    )
    // It covers the joined system text the provider receives.
    expect(recorded).toBeGreaterThanOrEqual(
      estimateOverhead({ system: [system.join("\n"), "goal block"], tools: processInput.tools }),
    )
  })

  test("counts the per-message user system text and uses the serialized tools it was given", async () => {
    const requestOverheads = new Map<SessionID, number>()
    const base = streamInput()
    const processInput = streamInput({ user: { ...base.user, system: "User instructions. ".repeat(40) } })
    const toolsJson = JSON.stringify(serializedTools(processInput.tools))
    await run(Overhead.record(input(requestOverheads), { processInput, toolsJson, ledger: [] }))
    expect(requestOverheads.get(sessionID)).toBe(
      estimateOverhead({ system: LLMRequestPrep.requestSystem(processInput), tools: processInput.tools, toolsJson }),
    )
    expect(LLMRequestPrep.requestSystem(processInput).join("\n")).toContain("User instructions.")
  })

  test("stores the manifest of the request under its session, with the model as provider/model", async () => {
    const processInput = streamInput()
    const ledger = [entry("goal block")]
    await run(Overhead.record(input(), { processInput, toolsJson: undefined, ledger }))

    const manifest = EngineProcess.runtimes.requestManifests.get(sessionID)!
    expect(manifest.model).toBe("test/test-model")
    expect(manifest.entries.map((item) => item.source)).toEqual([
      "base",
      "environment",
      "instructions",
      "runtime_note",
      "tools",
      "runtime_context",
    ])
    const base = LLMRequestPrep.requestSystem({ ...processInput, system: [] }).join("\n")
    expect(manifest.entries[0]).toMatchObject({ source: "base", bytes: Buffer.byteLength(base), hash: hash(base) })
    expect(manifest.entries[2]?.label).toBe("/repo/AGENTS.md")
    const tools = JSON.stringify(serializedTools(processInput.tools))
    expect(manifest.entries.find((item) => item.source === "tools")).toMatchObject({
      bytes: Buffer.byteLength(tools),
      tokens: Token.estimateReserve(tools),
      hash: hash(tools),
    })
  })

  test("measures the serialized tools it was handed instead of serializing them again", async () => {
    await run(Overhead.record(input(), { processInput: streamInput(), toolsJson: "[cached fragment]", ledger: [] }))
    const manifest = EngineProcess.runtimes.requestManifests.get(sessionID)!
    expect(manifest.entries.find((item) => item.source === "tools")?.hash).toBe(hash("[cached fragment]"))
  })

  test("logs the manifest at INFO the first time and whenever a source, label or hash changes, and not otherwise", async () => {
    const requestOverheads = new Map<SessionID, number>()
    const record = (processInput: LLM.StreamInput, ledger: RuntimeContext.Entry[] = []) =>
      run(Overhead.record(input(requestOverheads), { processInput, toolsJson: undefined, ledger }))

    await record(streamInput())
    expect(infos()).toHaveLength(1)
    // An identical request says nothing.
    await record(streamInput())
    expect(infos()).toHaveLength(1)

    // A text changes.
    await record(
      streamInput({ system: ["Environment facts, edited.", instruction("/repo/AGENTS.md"), "Runtime note."] }),
    )
    expect(infos()).toHaveLength(2)

    // The same texts under another source.
    await record(
      streamInput({
        system: ["Environment facts, edited.", instruction("/repo/AGENTS.md"), "Runtime note."],
        systemLabels: ["environment", "hooks", "runtime_note"],
      }),
    )
    expect(infos()).toHaveLength(3)

    // The tool set changes.
    await record(
      streamInput({
        system: ["Environment facts, edited.", instruction("/repo/AGENTS.md"), "Runtime note."],
        systemLabels: ["environment", "hooks", "runtime_note"],
        tools: { read: readTool, grep: readTool },
      }),
    )
    expect(infos()).toHaveLength(4)

    // A ledger block joins.
    const same = streamInput({
      system: ["Environment facts, edited.", instruction("/repo/AGENTS.md"), "Runtime note."],
      systemLabels: ["environment", "hooks", "runtime_note"],
      tools: { read: readTool, grep: readTool },
    })
    await record(same, [entry("goal block")])
    expect(infos()).toHaveLength(5)
    await record(same, [entry("goal block")])
    expect(infos()).toHaveLength(5)
    expect(warnings()).toHaveLength(0)
  })

  test("a model change that moves no entry logs nothing but replaces the stored manifest", async () => {
    const processInput = streamInput()
    await run(Overhead.record(input(), { processInput, toolsJson: undefined, ledger: [] }))
    const other = ProviderTest.model({ providerID: ProviderV2.ID.make("test"), id: ModelV2.ID.make("other-model") })
    await run(Overhead.record({ ...input(), model: other }, { processInput, toolsJson: undefined, ledger: [] }))
    expect(infos()).toHaveLength(1)
    expect(EngineProcess.runtimes.requestManifests.get(sessionID)?.model).toBe("test/other-model")
  })

  test("the INFO line carries the session, the model, the totals and the entries", async () => {
    await run(Overhead.record(input(), { processInput: streamInput(), toolsJson: undefined, ledger: [] }))
    const [line] = infos()
    const manifest = EngineProcess.runtimes.requestManifests.get(sessionID)!
    expect(line?.level).toBe("Info")
    expect(line?.message[1]).toEqual({
      "session.id": sessionID,
      model: "test/test-model",
      bytes: manifest.bytes,
      tokens: manifest.tokens,
      entries: manifest.entries,
    })
  })

  test("skips the manifest with a warning when the system texts carry no matching labels, and still records the overhead", async () => {
    const requestOverheads = new Map<SessionID, number>()
    await run(
      Overhead.record(input(requestOverheads), { processInput: streamInput(), toolsJson: undefined, ledger: [] }),
    )
    const previous = EngineProcess.runtimes.requestManifests.get(sessionID)
    expect(previous).toBeDefined()

    for (const broken of [{ systemLabels: undefined }, { systemLabels: ["environment"] as SystemSection[] }]) {
      logs.length = 0
      requestOverheads.clear()
      await run(
        Overhead.record(input(requestOverheads), {
          processInput: streamInput(broken),
          toolsJson: undefined,
          ledger: [],
        }),
      )
      expect(warnings()).toHaveLength(1)
      expect(infos()).toHaveLength(0)
      expect(requestOverheads.get(sessionID)).toBeGreaterThan(0)
      // The last good manifest stays.
      expect(EngineProcess.runtimes.requestManifests.get(sessionID)).toBe(previous)
    }
  })

  test("a session that was never recorded has no manifest, and forgetting a session drops it", async () => {
    expect(EngineProcess.runtimes.requestManifests.get(sessionID)).toBeUndefined()
    await run(Overhead.record(input(), { processInput: streamInput(), toolsJson: undefined, ledger: [] }))
    expect(EngineProcess.runtimes.requestManifests.get(sessionID)).toBeDefined()
    await Effect.runPromise(EngineProcess.runtimes.remove(sessionID))
    expect(EngineProcess.runtimes.requestManifests.get(sessionID)).toBeUndefined()
  })
})

describe("LLMRequestPrep.baseSystem and requestSystem", () => {
  const request = (overrides: Partial<Parameters<typeof LLMRequestPrep.requestSystem>[0]> = {}) => ({
    ...streamInput(),
    ...overrides,
  })

  test("baseSystem is the agent prompt, or the provider prompt for the tools in use, then the writing style", () => {
    expect(LLMRequestPrep.baseSystem(request({ agent: { ...streamInput().agent, prompt: "Custom agent." } }))).toEqual([
      "Custom agent.",
      DEFAULT_WRITING_STYLE,
    ])
    expect(LLMRequestPrep.baseSystem(request({ tools: { edit: readTool, write: readTool } }))).toEqual([
      ...SystemPrompt.provider(["edit", "write"]),
      DEFAULT_WRITING_STYLE,
    ])
    // The prompt names the editing tools of this request: a denied tool is not advertised.
    const denied = request({
      tools: { edit: readTool, write: readTool },
      permission: [{ permission: "edit", pattern: "*", action: "deny" }],
    })
    expect(LLMRequestPrep.baseSystem(denied)).toEqual([...SystemPrompt.provider([]), DEFAULT_WRITING_STYLE])
  })

  test("requestSystem appends the system texts and the per-message system text, and drops empty ones", () => {
    const base = streamInput()
    const system = LLMRequestPrep.requestSystem(
      request({
        agent: { ...base.agent, prompt: "Custom agent." },
        system: ["first", "", "second"],
        user: { ...base.user, system: "User instructions." },
      }),
    )
    expect(system).toEqual(["Custom agent.", DEFAULT_WRITING_STYLE, "first", "second", "User instructions."])
    expect(
      LLMRequestPrep.requestSystem(request({ agent: { ...base.agent, prompt: "Custom agent." }, system: [] })),
    ).toEqual(["Custom agent.", DEFAULT_WRITING_STYLE])
  })

  test("prepare sends exactly the joined requestSystem", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const flags = yield* RuntimeFlags.Service
        const provider = ProviderTest.info({}, model)
        const base = streamInput()
        for (const variant of [
          {},
          { agent: { ...base.agent, prompt: "Custom agent." } },
          { system: ["first", "", "second"], user: { ...base.user, system: "User instructions." } },
        ] as Array<Partial<LLM.StreamInput>>) {
          const input = { ...base, ...variant }
          const prepared = yield* LLMRequestPrep.prepare({
            user: input.user,
            sessionID: input.sessionID,
            model,
            agent: input.agent,
            system: input.system,
            messages: [],
            tools: input.tools,
            provider,
            cfg: {},
            auth: undefined,
            flags,
          })
          expect(prepared.system).toEqual([LLMRequestPrep.requestSystem(input).join("\n")])
        }
      }).pipe(Effect.provide(RuntimeFlags.layer())),
    ))
})
