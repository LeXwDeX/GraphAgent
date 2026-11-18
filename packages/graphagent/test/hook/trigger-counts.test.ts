// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { DateTime, Effect, Fiber, Layer } from "effect"
import { LayerNode } from "@graphagent/core/effect/layer-node"
import { CrossSpawnSpawner } from "@graphagent/core/cross-spawn-spawner"
import { Database } from "@graphagent/core/database/database"
import { EventV2 } from "@graphagent/core/event"
import { SessionProjector } from "@graphagent/core/session/projector"
import { LifecycleEvent } from "@graphagent/schema/lifecycle-event"
import { VALID_HOOK_EVENTS } from "@/hook"
import { HOOK_BINDINGS } from "@/hook/bindings"
import { HookLifecycle } from "@/hook/lifecycle"
import { SessionHooks } from "@/hook/session-hooks"
import { EventV2Bridge } from "@/event-v2-bridge"
import { LSP } from "@/lsp/lsp"
import { MCP } from "@/mcp"
import { SessionPrompt } from "@/session/prompt"
import { SessionRetry } from "@/session/retry"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { SessionSummary } from "@/session/summary"
import { provideTmpdirServer } from "../fixture/fixture"
import { cliIt } from "../lib/cli-process"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"

/**
 * Issue #1070: every hook event fires the expected number of times.
 *
 * Each scenario drives one deterministic transition sequence through the real
 * turn pipeline with a capture command hooked on every supported event (the
 * engine runs real handlers), then compares the captured multiset with the
 * scenario's declared one. The comparison is exact: an event that fires twice,
 * or fires where none is expected, fails. The keys carry the session scope
 * (`root` is the session the prompt went to) because a child run's events fire
 * in different sessions.
 *
 * `MessageDisplay` is covered by its own scenario: hooked everywhere it would
 * spawn one process per streamed text batch. The first group drives the turn
 * pipeline in process; the second drives a real server for the lifecycles that
 * only exist there (session start and end, DAG delivery).
 */

const mcp = Layer.succeed(
  MCP.Service,
  MCP.Service.of({
    status: () => Effect.succeed({}),
    clients: () => Effect.succeed({}),
    instructions: () => Effect.succeed([]),
    tools: () => Effect.succeed({}),
    prompts: () => Effect.succeed({}),
    resources: () => Effect.succeed({}),
    resourceTemplates: () => Effect.succeed({}),
    add: () => Effect.succeed({ status: { status: "disabled" as const } }),
    connect: () => Effect.void,
    disconnect: () => Effect.void,
    getPrompt: () => Effect.succeed(undefined),
    readResource: () => Effect.succeed(undefined),
    startAuth: () => Effect.die("unexpected MCP auth"),
    authenticate: () => Effect.die("unexpected MCP auth"),
    finishAuth: () => Effect.die("unexpected MCP auth"),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated" as const),
  }),
)

const lsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(false),
    touchFile: () => Effect.void,
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.succeed(undefined),
    definition: () => Effect.succeed([]),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed([]),
    workspaceSymbol: () => Effect.succeed([]),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
  }),
)

const root = LayerNode.group([
  EventV2Bridge.node,
  SessionPrompt.node,
  SessionHooks.node,
  HookLifecycle.node,
  Session.node,
  SessionStatus.node,
  SessionProjector.node,
  SessionSummary.node,
  Database.node,
  CrossSpawnSpawner.node,
  LayerNode.make(TestLLMServer.layer, []),
])
const it = testEffect(
  LayerNode.buildLayer(root, {
    replacements: [LayerNode.replace(MCP.node, mcp), LayerNode.replace(LSP.node, lsp)],
  }),
)

const providerCfg = (url: string) => ({
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: {
        apiKey: "test-key",
        baseURL: url,
      },
    },
  },
})

type Counts = Readonly<Record<string, number>>

interface Row {
  readonly hook_event_name: string
  readonly session_id: string
  readonly final?: boolean
}

interface Drive {
  readonly llm: TestLLMServer["Service"]
  readonly dir: string
  readonly session: Session.Info
  readonly prompt: SessionPrompt.Interface
  readonly status: SessionStatus.Interface
  readonly events: EventV2.Interface
}

interface Scenario {
  readonly name: string
  /** `Event@scope` -> exact number of times the capture command ran. */
  readonly expected: Counts
  readonly drive: (input: Drive) => Effect.Effect<void, unknown>
}

// The ordinary path of one user prompt: UserPromptSubmit, then Stop at the end.
const TURN = { "UserPromptSubmit@root": 1, "Stop@root": 1 } as const

const SCENARIOS: readonly Scenario[] = [
  {
    // A tool call settles, then idle is announced again and again: repeated
    // `idle` publications, `settle` pulses and a duplicate turn settlement
    // announce no new transition, so no hook may fire for them.
    name: "a root turn with a tool call fires once per transition and ignores repeated idle pulses",
    expected: { ...TURN, "PreToolUse@root": 1, "PostToolUse@root": 1, "PostToolBatch@root": 1 },
    drive: ({ llm, dir, session, prompt, status, events }) =>
      Effect.gen(function* () {
        yield* llm.tool("read", { filePath: path.join(dir, "note.txt") })
        yield* llm.text("done")
        yield* prompt.prompt({ sessionID: session.id, agent: "build", parts: [{ type: "text", text: "go" }] })
        yield* status.set(session.id, { type: "idle" })
        yield* status.set(session.id, { type: "idle" })
        yield* status.settle?.(session.id) ?? Effect.void
        yield* status.settle?.(session.id) ?? Effect.void
        yield* events.publish(SessionStatus.Event.Idle, { sessionID: session.id }).pipe(Effect.orDie)
        yield* events
          .publish(LifecycleEvent.TurnSettled, {
            sessionID: session.id,
            turnID: "turn_forged",
            outcome: { type: "completed" },
            steps: 1,
            timeEnded: DateTime.makeUnsafe(Date.now()),
          })
          .pipe(Effect.orDie)
        // Every hook of the turn already ran; the pause only lets a late one show up.
        yield* Effect.sleep("200 millis")
      }),
  },
  {
    name: "a failing tool call fires PostToolUseFailure instead of PostToolUse",
    expected: { ...TURN, "PreToolUse@root": 1, "PostToolUseFailure@root": 1, "PostToolBatch@root": 1 },
    drive: ({ llm, dir, session, prompt }) =>
      Effect.gen(function* () {
        yield* llm.tool("read", { filePath: path.join(dir, "missing.txt") })
        yield* llm.text("done")
        yield* prompt.prompt({ sessionID: session.id, agent: "build", parts: [{ type: "text", text: "go" }] })
      }),
  },
  {
    // A cancelled turn is neither a clean end nor a failure: only the prompt
    // that started it was announced.
    name: "a cancelled turn fires neither Stop nor StopFailure",
    expected: { "UserPromptSubmit@root": 1 },
    drive: ({ llm, session, prompt }) =>
      Effect.gen(function* () {
        yield* llm.hang
        const turn = yield* prompt
          .prompt({ sessionID: session.id, agent: "build", parts: [{ type: "text", text: "go" }] })
          .pipe(Effect.forkChild)
        yield* llm.wait(1)
        yield* prompt.cancel(session.id)
        yield* Fiber.await(turn)
      }),
  },
  {
    name: "a turn that ends on a provider error fires StopFailure instead of Stop",
    expected: { "UserPromptSubmit@root": 1, "StopFailure@root": 1 },
    drive: ({ llm, session, prompt }) =>
      Effect.gen(function* () {
        for (let attempt = 0; attempt <= SessionRetry.RETRY_MAX_RETRIES; attempt++)
          yield* llm.error(503, { error: { message: "request rejected" } }, { "retry-after-ms": "0" })
        yield* prompt.prompt({ sessionID: session.id, agent: "build", parts: [{ type: "text", text: "go" }] })
      }),
  },
  {
    // The parent announces the child run in its own session; the child's clean
    // end fires SubagentStop there, never a Stop of the child's own.
    name: "a finished child run fires SubagentStart and SubagentStop once, in the parent",
    expected: {
      ...TURN,
      "PreToolUse@root": 1,
      "PostToolUse@root": 1,
      "PostToolBatch@root": 1,
      "SubagentStart@root": 1,
      "SubagentStop@root": 1,
    },
    drive: ({ llm, session, prompt }) =>
      Effect.gen(function* () {
        yield* llm.tool("task", { description: "sub task", prompt: "say something", subagent_type: "general" })
        yield* llm.text("sub answer")
        yield* llm.text("parent done")
        yield* prompt.prompt({ sessionID: session.id, agent: "build", parts: [{ type: "text", text: "delegate" }] })
      }),
  },
  {
    // A child run that fails never reaches SubagentStop: its own session fires
    // StopFailure, and the parent sees a failed task call.
    name: "a failed child run fires StopFailure in the child and no SubagentStop",
    expected: {
      ...TURN,
      "PreToolUse@root": 1,
      "PostToolUseFailure@root": 1,
      "PostToolBatch@root": 1,
      "SubagentStart@root": 1,
      "StopFailure@child": 1,
    },
    drive: ({ llm, session, prompt }) =>
      Effect.gen(function* () {
        yield* llm.tool("task", { description: "sub task", prompt: "say something", subagent_type: "general" })
        for (let attempt = 0; attempt <= SessionRetry.RETRY_MAX_RETRIES; attempt++)
          yield* llm.error(503, { error: { message: "subagent request rejected" } }, { "retry-after-ms": "0" })
        yield* llm.text("parent done")
        yield* prompt.prompt({ sessionID: session.id, agent: "build", parts: [{ type: "text", text: "delegate" }] })
      }),
  },
]

const COUNTED_EVENTS = [...VALID_HOOK_EVENTS].filter((event) => event !== "MessageDisplay")

const writeHooks = (dir: string, events: readonly string[]) =>
  Effect.promise(async () => {
    const capture = path.join(dir, "hook-events.jsonl")
    await fs.mkdir(path.join(dir, ".agents"), { recursive: true })
    await fs.writeFile(path.join(dir, "note.txt"), "hello\n")
    const handler = { type: "command", command: `cat >> '${capture}'; echo >> '${capture}'` }
    await fs.writeFile(
      path.join(dir, ".agents", "hooks.json"),
      JSON.stringify(Object.fromEntries(events.map((event) => [event, [{ hooks: [handler] }]]))),
    )
    return capture
  })

const readRows = (capture: string) =>
  Effect.promise(() => fs.readFile(capture, "utf8").catch(() => "")).pipe(
    Effect.map((text) =>
      text
        .split("\n")
        .filter((line) => line.trim())
        .map((line): Row => JSON.parse(line)),
    ),
  )

const sorted = (counts: Counts): Counts =>
  Object.fromEntries(Object.entries(counts).toSorted(([left], [right]) => left.localeCompare(right)))

const tally = (rows: readonly Row[], rootID: string): Counts => {
  const counts: Record<string, number> = {}
  for (const row of rows) {
    const key = `${row.hook_event_name}@${row.session_id === rootID ? "root" : "child"}`
    counts[key] = (counts[key] ?? 0) + 1
  }
  return sorted(counts)
}

describe("hook event trigger counts", () => {
  for (const scenario of SCENARIOS) {
    it.live(scenario.name, () =>
      provideTmpdirServer(
        Effect.fnUntraced(function* ({ llm, dir }) {
          const capture = yield* writeHooks(dir, COUNTED_EVENTS)
          const sessions = yield* Session.Service
          const session = yield* sessions.create({
            title: scenario.name,
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          })
          yield* scenario.drive({
            llm,
            dir,
            session,
            prompt: yield* SessionPrompt.Service,
            status: yield* SessionStatus.Service,
            events: yield* EventV2Bridge.Service,
          })
          expect(tally(yield* readRows(capture), session.id)).toEqual(sorted(scenario.expected))
        }),
        { git: true, config: providerCfg },
      ),
    )
  }

  // One streamed reply is one display batch carrying the final marker, once.
  it.live("a text reply fires MessageDisplay with a single final batch", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm, dir }) {
        const capture = yield* writeHooks(dir, ["MessageDisplay"])
        const sessions = yield* Session.Service
        const prompt = yield* SessionPrompt.Service
        const session = yield* sessions.create({ title: "display" })
        yield* llm.text("done")
        yield* prompt.prompt({ sessionID: session.id, agent: "build", parts: [{ type: "text", text: "go" }] })
        const rows = yield* readRows(capture)
        expect(rows.map((row) => row.hook_event_name)).toEqual(["MessageDisplay"])
        expect(rows.filter((row) => row.final === true)).toHaveLength(1)
      }),
      { git: true, config: providerCfg },
    ),
  )

  test("the scenarios exercise every event that has a lifecycle source", () => {
    const exercised = new Set(
      SCENARIOS.flatMap((scenario) => Object.keys(scenario.expected)).map((key) => key.split("@")[0]),
    )
    const bound = Object.entries(HOOK_BINDINGS)
      .filter(([, binding]) => binding.source.kind === "lifecycle")
      .map(([event]) => event)
    expect(bound.filter((event) => !exercised.has(event))).toEqual([])
  })
})

// Real server scenarios: the hooks sit in the global layer of an isolated home,
// the server runs in a subprocess against the fake provider, and the session
// lifecycles go through the HTTP surface a client uses.
const serverHooks = (home: string) =>
  Effect.promise(async () => {
    const capture = path.join(home, "hook-events.jsonl")
    const handler = { type: "command", command: `cat >> '${capture}'; echo >> '${capture}'` }
    await fs.writeFile(
      path.join(home, ".config/graphagent/hooks.json"),
      JSON.stringify(Object.fromEntries(COUNTED_EVENTS.map((event) => [event, [{ hooks: [handler] }]]))),
    )
    return capture
  })

const serverCall = (url: string, home: string, route: string, method: string, body?: object) =>
  Effect.promise(async () => {
    const response = await fetch(url + route, {
      method,
      headers: { "content-type": "application/json", "x-graphagent-directory": home },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    return { status: response.status, text: await response.text() }
  })

describe("hook event trigger counts on a real server", () => {
  cliIt.live("a session fires SessionStart once on creation and SessionEnd once on deletion", ({ home, graphagent }) =>
    Effect.gen(function* () {
      const capture = yield* serverHooks(home)
      const server = yield* graphagent.host()
      const created = yield* serverCall(server.url, home, "/session", "POST", {})
      expect(created.status).toBe(200)
      const session: { id: string } = JSON.parse(created.text)
      expect((yield* serverCall(server.url, home, `/session/${session.id}`, "DELETE")).status).toBe(200)
      // The session is gone: a second delete has nothing to end.
      expect((yield* serverCall(server.url, home, `/session/${session.id}`, "DELETE")).status).toBe(404)
      // Both hooks ran inside the requests above; the pause only lets a late duplicate show up.
      yield* Effect.sleep("500 millis")
      expect(tally(yield* readRows(capture), session.id)).toEqual(
        sorted({ "SessionStart@root": 1, "SessionEnd@root": 1 }),
      )
    }),
  )

  // A DAG node is a child run too: its parent hears SubagentStart and
  // SubagentStop once for the attempt, and the node's own session fires nothing.
  cliIt.live(
    "a DAG node run fires SubagentStart and SubagentStop once and nothing of its own",
    ({ home, env, llm, graphagent }) =>
      Effect.gen(function* () {
        const capture = yield* serverHooks(home)
        const spec = path.join(home, "hook-counts.yaml")
        yield* Effect.promise(() =>
          fs.writeFile(
            spec,
            JSON.stringify({
              title: "Hook counts",
              config: {
                name: "hook-counts",
                delivery_node: "worker",
                max_concurrency: 1,
                nodes: [
                  {
                    id: "worker",
                    name: "Local worker",
                    worker_type: "general",
                    depends_on: [],
                    required: true,
                    prompt_template: { inline: "Produce the report." },
                  },
                ],
              },
            }),
          ),
        )
        yield* llm.toolMatch((hit) => JSON.stringify(hit.body).includes("HOOK-COUNTS-START"), "workflow", {
          params: { action: "run", operation: "start", spec_path: spec },
        })
        yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes("Produce the report."), "FINAL_DAG_REPORT")
        const server = yield* graphagent.host({
          env: {
            GRAPHAGENT_CONFIG_CONTENT: JSON.stringify({
              ...JSON.parse(env.GRAPHAGENT_CONFIG_CONTENT),
              permission: { "*": "allow" },
            }),
          },
        })
        const json = (route: string, method: string, body?: object) =>
          serverCall(server.url, home, route, method, body).pipe(Effect.map((response) => JSON.parse(response.text)))
        const parent: { id: string } = yield* json("/session", "POST", {
          title: "DAG hook counts",
          model: { providerID: "test", id: "test-model" },
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        yield* json(`/session/${parent.id}/message`, "POST", { parts: [{ type: "text", text: "HOOK-COUNTS-START" }] })
        // The run is over when the workflow settled and both the node's SubagentStop
        // and the parent's Stop reached the capture.
        yield* pollWithTimeout(
          Effect.gen(function* () {
            const workflows: { status: string }[] = yield* json(`/dag/session/${parent.id}`, "GET")
            const names = (yield* readRows(capture)).map((row) => row.hook_event_name)
            const settled = workflows.length > 0 && workflows.every((workflow) => workflow.status === "completed")
            return settled && names.includes("SubagentStop") && names.includes("Stop") ? true : undefined
          }),
          "the DAG run never reached SubagentStop and Stop",
          "15 seconds",
        )
        // Late duplicates would arrive after the last expected event.
        yield* Effect.sleep("500 millis")
        expect(tally(yield* readRows(capture), parent.id)).toEqual(
          sorted({
            "SessionStart@root": 1,
            ...TURN,
            "PreToolUse@root": 1,
            "PostToolUse@root": 1,
            "PostToolBatch@root": 1,
            "SubagentStart@root": 1,
            "SubagentStop@root": 1,
          }),
        )
      }),
  )
})
