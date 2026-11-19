// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { jsonSchema, tool } from "ai"
import { Effect, Layer, Logger, ManagedRuntime } from "effect"
import { Database } from "@graphagent/core/database/database"
import { EventV2 } from "@graphagent/core/event"
import { ModelV2 } from "@graphagent/core/model"
import { contextWindow, DEFAULT_CONTEXT_WINDOW } from "@graphagent/core/model-profile"
import { ProjectV2 } from "@graphagent/core/project"
import { ProviderV2 } from "@graphagent/core/provider"
import { SessionV1 } from "@graphagent/core/v1/session"
import { Injection } from "@graphagent/core/system-context/injection"
import { DEFAULT_WRITING_STYLE } from "@graphagent/core/system-context/writing-style"
import { Hash } from "@graphagent/core/util/hash"
import { TuiEvent } from "@graphagent/schema/tui-event"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { profileOf } from "@/provider/profile"
import { EngineProcess } from "@/session/engine-process"
import type { LLM } from "@/session/llm"
import { LLMRequestPrep } from "@/session/llm/request"
import { estimateOverhead, serializedTools } from "@/session/overflow"
import { RuntimeContext } from "@/session/runtime-context"
import { SessionID } from "@/session/schema"
import type { Session } from "@/session/session"
import type { SystemSection } from "@/session/step-metrics"
import { SystemPrompt } from "@/session/system"
import { Overhead } from "@/session/turn/overhead"
import type { PrepareDeps } from "@/session/turn/prepare"
import { Token } from "@/util/token"
import { ProviderTest } from "../fake/provider"

const sessionID = SessionID.make("ses_overhead_unit")
const parentID = SessionID.make("ses_overhead_parent")
const model = ProviderTest.model({ providerID: ProviderV2.ID.make("test"), id: ModelV2.ID.make("test-model") })

const sessionInfo = (id: SessionID = sessionID, parent?: SessionID): Session.Info => ({
  id,
  slug: "overhead-unit",
  role: parent === undefined ? "root" : "task_child",
  projectID: ProjectV2.ID.global,
  directory: "/repo",
  title: "overhead unit",
  version: "1.0.0",
  time: { created: 1, updated: 1 },
  ...(parent === undefined ? {} : { parentID: parent }),
})

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

// The toasts published through the bridge, in order, and whether publishing fails. The bridge is the real one over an
// in-memory database, so a payload that does not fit the event's schema fails the test as it would fail the server.
type Toast = { title?: string; message: string; variant: string; duration?: number }
const toasts: Toast[] = []
const publishing = { fails: false }

const isToast = (data: unknown): data is Toast =>
  typeof data === "object" && data !== null && "message" in data && "variant" in data

const rawBridge = EventV2Bridge.layer.pipe(
  Layer.provide(EventV2.layer.pipe(Layer.provide(Database.layerFromPath(":memory:")))),
)
const capturingBridge = Layer.effect(
  EventV2Bridge.Service,
  Effect.gen(function* () {
    const original = yield* EventV2Bridge.Service
    const publish: EventV2.Interface["publish"] = (definition, data, options) => {
      if (definition.type === TuiEvent.ToastShow.type && isToast(data)) toasts.push(data)
      return publishing.fails ? Effect.die(new Error("publishing failed")) : original.publish(definition, data, options)
    }
    return EventV2Bridge.Service.of({ ...original, publish })
  }),
).pipe(Layer.provide(rawBridge))

const runtime = ManagedRuntime.make(capturingBridge)
let events!: PrepareDeps["events"]

beforeAll(async () => {
  events = await runtime.runPromise(
    Effect.gen(function* () {
      return yield* EventV2Bridge.Service
    }),
  )
})

afterAll(() => runtime.dispose())

// Every session a test records for, so that nothing it leaves in the process-wide registry reaches the next test.
const touched = [sessionID, SessionID.make("ses_overhead_other")]

afterEach(async () => {
  logs.length = 0
  toasts.length = 0
  publishing.fails = false
  for (const id of touched) await Effect.runPromise(EngineProcess.runtimes.remove(id))
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
  const input = (requestOverheads = new Map<SessionID, number>()) => ({
    session: sessionInfo(),
    sessionID,
    model,
    requestOverheads,
  })

  test("records the overhead of the request as sent: base prompt, system texts, ledger blocks and tools", async () => {
    const requestOverheads = new Map<SessionID, number>()
    const processInput = streamInput()
    const ledger = [entry("goal block")]
    await run(Overhead.record(events, input(requestOverheads), { processInput, toolsJson: undefined, ledger }))

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
    await run(Overhead.record(events, input(requestOverheads), { processInput, toolsJson, ledger: [] }))
    expect(requestOverheads.get(sessionID)).toBe(
      estimateOverhead({ system: LLMRequestPrep.requestSystem(processInput), tools: processInput.tools, toolsJson }),
    )
    expect(LLMRequestPrep.requestSystem(processInput).join("\n")).toContain("User instructions.")
  })

  test("stores the manifest of the request under its session, with the model as provider/model", async () => {
    const processInput = streamInput()
    const ledger = [entry("goal block")]
    await run(Overhead.record(events, input(), { processInput, toolsJson: undefined, ledger }))

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
    await run(
      Overhead.record(events, input(), { processInput: streamInput(), toolsJson: "[cached fragment]", ledger: [] }),
    )
    const manifest = EngineProcess.runtimes.requestManifests.get(sessionID)!
    expect(manifest.entries.find((item) => item.source === "tools")?.hash).toBe(hash("[cached fragment]"))
  })

  test("logs the manifest at INFO the first time and whenever a source, label or hash changes, and not otherwise", async () => {
    const requestOverheads = new Map<SessionID, number>()
    const record = (processInput: LLM.StreamInput, ledger: RuntimeContext.Entry[] = []) =>
      run(Overhead.record(events, input(requestOverheads), { processInput, toolsJson: undefined, ledger }))

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
    await run(Overhead.record(events, input(), { processInput, toolsJson: undefined, ledger: [] }))
    const other = ProviderTest.model({ providerID: ProviderV2.ID.make("test"), id: ModelV2.ID.make("other-model") })
    await run(Overhead.record(events, { ...input(), model: other }, { processInput, toolsJson: undefined, ledger: [] }))
    expect(infos()).toHaveLength(1)
    expect(EngineProcess.runtimes.requestManifests.get(sessionID)?.model).toBe("test/other-model")
  })

  test("the INFO line carries the session, the model, the totals and the entries", async () => {
    await run(Overhead.record(events, input(), { processInput: streamInput(), toolsJson: undefined, ledger: [] }))
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
      Overhead.record(events, input(requestOverheads), {
        processInput: streamInput(),
        toolsJson: undefined,
        ledger: [],
      }),
    )
    const previous = EngineProcess.runtimes.requestManifests.get(sessionID)
    expect(previous).toBeDefined()

    for (const broken of [{ systemLabels: undefined }, { systemLabels: ["environment"] as SystemSection[] }]) {
      logs.length = 0
      requestOverheads.clear()
      await run(
        Overhead.record(events, input(requestOverheads), {
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
    await run(Overhead.record(events, input(), { processInput: streamInput(), toolsJson: undefined, ledger: [] }))
    expect(EngineProcess.runtimes.requestManifests.get(sessionID)).toBeDefined()
    await Effect.runPromise(EngineProcess.runtimes.remove(sessionID))
    expect(EngineProcess.runtimes.requestManifests.get(sessionID)).toBeUndefined()
  })
})

// A model that declares a context window of `tokens`, and one that declares none (the window is then assumed).
const windowed = (tokens: number, id = "test-model") =>
  ProviderTest.model({
    providerID: ProviderV2.ID.make("test"),
    id: ModelV2.ID.make(id),
    limit: { context: tokens, output: 1_000 },
  })
const undeclared = (id = "test-model") => windowed(0, id)

const otherID = touched[1]
const stored = (id: SessionID = sessionID) => EngineProcess.runtimes.requestManifests.get(id)!

/** One request recorded the way a step records it, for `session` (a root by default) on `model`. */
const step = (options: { session?: Session.Info; model?: typeof model; request?: LLM.StreamInput } = {}) => {
  const session = options.session ?? sessionInfo()
  return run(
    Overhead.record(
      events,
      { session, sessionID: session.id, model: options.model ?? model, requestOverheads: new Map() },
      { processInput: options.request ?? streamInput(), toolsJson: undefined, ledger: [] },
    ),
  )
}

/** The tokens of the default request's fixed overhead; the same for every model and session. */
const fixedTokens = async () => {
  await step({ session: sessionInfo(otherID), model: windowed(10_000_000, "huge") })
  return stored(otherID).tokens
}

/** A request whose system text alone is 130,000 characters: more than a quarter of the assumed window. */
const bulky = () => streamInput({ system: ["x".repeat(130_000)], systemLabels: ["environment"] })

const TITLE = "Fixed request overhead is large"

describe("Overhead.record: the window of the model", () => {
  test("keeps the window the profile of the model declares, and where it comes from, with the manifest", async () => {
    const declared = windowed(200_000)
    await step({ model: declared })
    expect(stored().window).toBe(200_000)
    expect(stored().windowSource).toBe(contextWindow(profileOf(declared)).source)
    expect(stored().windowSource).not.toBe("default")
  })

  test("takes the assumed window, marked `default`, for a model that declares none", async () => {
    await step({ model: undeclared() })
    expect(stored().window).toBe(DEFAULT_CONTEXT_WINDOW)
    expect(stored().windowSource).toBe("default")
  })

  test("follows the model of the latest request", async () => {
    await step({ model: windowed(200_000) })
    await step({ model: windowed(64_000, "smaller") })
    expect(stored().window).toBe(64_000)
    expect(stored().model).toBe("test/smaller")
  })

  test("does not change the sums or the entries of the manifest", async () => {
    await step({ model: windowed(200_000) })
    const manifest = stored()
    expect(manifest.bytes).toBe(manifest.entries.reduce((sum, item) => sum + item.bytes, 0))
    expect(manifest.tokens).toBe(manifest.entries.reduce((sum, item) => sum + item.tokens, 0))
    expect(manifest.entries.map((item) => item.source)).toEqual([
      "base",
      "environment",
      "instructions",
      "runtime_note",
      "tools",
    ])
  })
})

describe("Overhead.record: the alert about a large fixed overhead", () => {
  test("is 25% of the window", () => {
    expect(Overhead.OVERHEAD_WARN_RATIO).toBe(0.25)
  })

  test("tells the user once, with a warning toast, when a root session's overhead passes the share", async () => {
    await step({ model: windowed(1_000) })
    const { tokens } = stored()
    // The overhead is more than the window itself here; the percentage says so.
    expect(toasts).toEqual([
      {
        title: TITLE,
        message: `≈${tokens.toLocaleString("en-US")} tokens (${Math.round((tokens / 1_000) * 100)}% of the 1,000-token window) are sent with every request.`,
        variant: "warning",
        duration: 8_000,
      },
    ])
    expect(toasts[0]?.message).toMatch(
      /^≈[\d,]+ tokens \(\d+% of the 1,000-token window\) are sent with every request\.$/,
    )
  })

  test("writes the figures with thousands separators and the share as a whole percentage", async () => {
    const tokens = await fixedTokens()
    // A window of 2.5 times the overhead makes it 40%.
    const window = Math.round(tokens * 2.5)
    await step({ model: windowed(window) })
    expect(window).toBeGreaterThanOrEqual(1_000)
    expect(toasts.map((toast) => toast.message)).toEqual([
      `≈${tokens.toLocaleString("en-US")} tokens (40% of the ${window.toLocaleString("en-US")}-token window) are sent with every request.`,
    ])
    expect(toasts[0]?.message).toContain(",")
  })

  test("says that the window is assumed, and how to declare it, when the model declares none", async () => {
    await step({ request: bulky(), model: undeclared() })
    const { tokens } = stored()
    const percent = Math.round((tokens / DEFAULT_CONTEXT_WINDOW) * 100)
    expect(percent).toBeGreaterThan(25)
    expect(toasts).toEqual([
      {
        title: TITLE,
        message: `≈${tokens.toLocaleString("en-US")} tokens (~${percent}% of an assumed 128,000-token window) are sent with every request. The model's window is not declared; set provider.test.models.test-model.limit.context in graphagent.json.`,
        variant: "warning",
        duration: 8_000,
      },
    ])
  })

  test("names the provider and the model of the request in that advice", async () => {
    const other = ProviderTest.model({
      providerID: ProviderV2.ID.make("acme"),
      id: ModelV2.ID.make("big-one"),
      limit: { context: 0, output: 1_000 },
    })
    await step({ request: bulky(), model: other })
    expect(toasts[0]?.message).toEndWith("set provider.acme.models.big-one.limit.context in graphagent.json.")
  })

  test("is quiet while the overhead is a small part of the window, declared or assumed", async () => {
    await step({ model: windowed(200_000) })
    await step({ model: undeclared("assumed") })
    expect(toasts).toEqual([])
    expect(stored().tokens / stored().window!).toBeLessThan(Overhead.OVERHEAD_WARN_RATIO)
  })

  test("needs more than a quarter: exactly a quarter is quiet, one token less window is not", async () => {
    const tokens = await fixedTokens()
    await step({ model: windowed(tokens * 4, "exactly") })
    expect(stored().tokens / stored().window!).toBe(0.25)
    expect(toasts).toEqual([])
    await step({ model: windowed(tokens * 4 - 1, "just-over") })
    expect(toasts).toHaveLength(1)
    expect(toasts[0]?.message).toContain(`(25% of the ${(tokens * 4 - 1).toLocaleString("en-US")}-token window)`)
  })

  test("speaks once for a model in a session: later requests with it say nothing", async () => {
    const small = windowed(1_000)
    await step({ model: small })
    await step({ model: small })
    await step({ model: small, request: bulky() })
    expect(toasts).toHaveLength(1)
  })

  test("speaks again once for another model, and not for one it already told about", async () => {
    const first = windowed(1_000, "first")
    const second = windowed(1_000, "second")
    await step({ model: first })
    expect(toasts).toHaveLength(1)
    await step({ model: second })
    expect(toasts).toHaveLength(2)
    await step({ model: first })
    await step({ model: second })
    expect(toasts).toHaveLength(2)
    expect([...EngineProcess.runtimes.overheadWarned.get(sessionID)!].toSorted()).toEqual(["test/first", "test/second"])
  })

  test("keeps its memory for each session", async () => {
    const small = windowed(1_000)
    await step({ model: small })
    await step({ session: sessionInfo(otherID), model: small })
    expect(toasts).toHaveLength(2)
  })

  test("is quiet in a child session, whatever its share, and leaves no mark there", async () => {
    await step({ session: sessionInfo(sessionID, parentID), model: windowed(1_000) })
    expect(toasts).toEqual([])
    expect(EngineProcess.runtimes.overheadWarned.get(sessionID)).toBeUndefined()
    // The manifest is kept all the same: the drawer shows the session on screen, a sub-agent's included.
    expect(stored().window).toBe(1_000)
    // Nothing was marked, so the same session recorded as a root still speaks.
    await step({ model: windowed(1_000) })
    expect(toasts).toHaveLength(1)
  })

  test("forgetting the session lets it speak again", async () => {
    const small = windowed(1_000)
    await step({ model: small })
    expect(EngineProcess.runtimes.overheadWarned.has(sessionID)).toBe(true)
    await Effect.runPromise(EngineProcess.runtimes.remove(sessionID))
    expect(EngineProcess.runtimes.overheadWarned.has(sessionID)).toBe(false)
    await step({ model: small })
    expect(toasts).toHaveLength(2)
  })

  test("a publish that fails is swallowed and not tried again for the same model", async () => {
    publishing.fails = true
    await step({ model: windowed(1_000) })
    // The request went on: the manifest and the estimate are there, and the attempt was made once.
    expect(stored().window).toBe(1_000)
    expect(toasts).toHaveLength(1)
    publishing.fails = false
    await step({ model: windowed(1_000) })
    expect(toasts).toHaveLength(1)
  })

  test("says nothing, and warns about the manifest only, when the system texts carry no matching labels", async () => {
    await step({ request: streamInput({ systemLabels: undefined }), model: windowed(1_000) })
    expect(toasts).toEqual([])
    expect(warnings()).toHaveLength(1)
    expect(EngineProcess.runtimes.overheadWarned.get(sessionID)).toBeUndefined()
  })

  test("does not change what the request records for the limit check", async () => {
    const quiet = new Map<SessionID, number>()
    const loud = new Map<SessionID, number>()
    const processInput = streamInput()
    const built = { processInput, toolsJson: undefined, ledger: [] }
    await run(
      Overhead.record(
        events,
        { session: sessionInfo(), sessionID, model: windowed(200_000), requestOverheads: quiet },
        built,
      ),
    )
    await Effect.runPromise(EngineProcess.runtimes.remove(sessionID))
    await run(
      Overhead.record(
        events,
        { session: sessionInfo(), sessionID, model: windowed(1_000), requestOverheads: loud },
        built,
      ),
    )
    expect(toasts).toHaveLength(1)
    expect(quiet.get(sessionID)).toBeGreaterThan(0)
    expect(loud.get(sessionID)).toBe(quiet.get(sessionID))
  })
})

describe("Overhead.view", () => {
  test("is empty for a session that has no manifest", () => {
    expect(Overhead.view(undefined)).toEqual({ bytes: 0, tokens: 0, sources: [] })
    expect(JSON.stringify(Overhead.view(undefined))).toBe('{"bytes":0,"tokens":0,"sources":[]}')
  })

  test("gives the totals, the model, the window and its share, and each source", async () => {
    await step({ model: windowed(200_000) })
    const manifest = stored()
    const view = Overhead.view(manifest)
    expect(view).toEqual({
      bytes: manifest.bytes,
      tokens: manifest.tokens,
      model: "test/test-model",
      window: 200_000,
      windowSource: manifest.windowSource!,
      ratio: manifest.tokens / 200_000,
      sources: manifest.entries.map((item) => ({
        source: item.source,
        ...(item.label === undefined ? {} : { label: item.label }),
        bytes: item.bytes,
        tokens: item.tokens,
        hash: item.hash,
      })),
    })
    expect(view.sources.map((item) => item.source)).toEqual([
      "base",
      "environment",
      "instructions",
      "runtime_note",
      "tools",
    ])
    expect(view.sources.find((item) => item.source === "instructions")?.label).toBe("/repo/AGENTS.md")
    expect(view.sources.find((item) => item.source === "tools")?.label).toBeUndefined()
    // A source carries exactly these members, the label only where it has one.
    expect(Object.keys(view.sources[0] ?? {}).toSorted()).toEqual(["bytes", "hash", "source", "tokens"])
    expect(Object.keys(view.sources[2] ?? {}).toSorted()).toEqual(["bytes", "hash", "label", "source", "tokens"])
  })

  test("is the share of the assumed window, marked `default`, for a model that declares none", async () => {
    await step({ model: undeclared() })
    const view = Overhead.view(stored())
    expect(view.window).toBe(DEFAULT_CONTEXT_WINDOW)
    expect(view.windowSource).toBe("default")
    expect(view.ratio).toBe(view.tokens / DEFAULT_CONTEXT_WINDOW)
  })

  test("carries no window, source or share before a window is known, and survives JSON as it is", () => {
    const manifest = manifestOf()!
    const view = Overhead.view(manifest)
    expect(Object.keys(view).toSorted()).toEqual(["bytes", "model", "sources", "tokens"])
    expect(JSON.parse(JSON.stringify(view))).toEqual(view)
  })

  test("the view of a stored manifest has no undefined member, so it survives JSON unchanged", async () => {
    await step({ model: windowed(200_000) })
    const view = Overhead.view(stored())
    expect(JSON.parse(JSON.stringify(view))).toEqual(view)
  })

  test("reads the manifest the process holds for the session", async () => {
    expect(Overhead.view(EngineProcess.runtimes.requestManifests.get(sessionID))).toEqual({
      bytes: 0,
      tokens: 0,
      sources: [],
    })
    await step({ model: windowed(200_000) })
    expect(Overhead.view(EngineProcess.runtimes.requestManifests.get(sessionID)).tokens).toBe(stored().tokens)
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
