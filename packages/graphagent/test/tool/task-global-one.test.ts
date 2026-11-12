// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { expect } from "bun:test"
import { CrossSpawnSpawner } from "@graphagent/core/cross-spawn-spawner"
import { Database } from "@graphagent/core/database/database"
import { LayerNode } from "@graphagent/core/effect/layer-node"
import { SessionProjector } from "@graphagent/core/session/projector"
import { Effect, Fiber, Layer } from "effect"
import { LSP } from "@/lsp/lsp"
import { MCP } from "@/mcp"
import { AgentScheduler } from "@/session/agent-scheduler"
import * as AgentSchedulerState from "@/session/agent-scheduler-state"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { SessionSummary } from "@/session/summary"
import { provideTmpdirServer } from "../fixture/fixture"
import { awaitWithTimeout, testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"

// Issue #1021 acceptance: with the global model-stream limit at ONE (the
// reservation disabled), a foreground task's parent/child chain still
// completes. The parent's turn calls the `task` tool; the child's own turn
// needs a model-stream permit while the parent's tool is still running. That
// is only possible because the parent's permit is released the moment its tool
// call is admitted (the permit covers the provider response stream, never the
// tool execution). `llm.test.ts` pins that release at the LLM boundary; this
// test runs the real chain end to end: processor → AI SDK → `task` tool →
// child session → child stream, against a real HTTP model server.

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarizeTurn: () => Effect.void,
    read: () => Effect.succeed([]),
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

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

/** One model stream at a time, process-wide; the default task reserve and child pool stay. */
const limits: AgentSchedulerState.SchedulerLimits = { ...AgentSchedulerState.DEFAULT_LIMITS, global: 1, perProvider: 1 }
const inner = AgentScheduler.make(AgentSchedulerState.makeState(limits), () => Effect.succeed(limits))

/** Every permit the chain asked for, in order, with the stream count the grant produced. */
const granted: Array<{ readonly lane: string; readonly inflight: number }> = []
const scheduler: AgentScheduler.Interface = {
  ...inner,
  request: (input, options) =>
    inner
      .request(input, options)
      .pipe(
        Effect.tap(() =>
          inner
            .capacity()
            .pipe(
              Effect.tap((snapshot) =>
                Effect.sync(() => void granted.push({ lane: input.lane, inflight: snapshot.requests.inflight })),
              ),
            ),
        ),
      ),
}

const root = LayerNode.group([
  SessionPrompt.node,
  Session.node,
  SessionProjector.node,
  SessionRunState.node,
  SessionStatus.node,
  Database.node,
  CrossSpawnSpawner.node,
  AgentScheduler.node,
  LayerNode.make(TestLLMServer.layer, []),
])
const it = testEffect(
  LayerNode.buildLayer(root, {
    replacements: [
      LayerNode.replace(MCP.node, mcp),
      LayerNode.replace(LSP.node, lsp),
      LayerNode.replace(SessionSummary.node, summary),
      // The real LLM service stays on purpose: it owns the permit and its release point.
      LayerNode.replace(AgentScheduler.node, Layer.succeed(AgentScheduler.Service, scheduler)),
    ],
  }),
)

const unix = process.platform === "win32" ? it.live.skip : it.live

unix(
  "a foreground task's parent/child chain completes when the global stream limit is one",
  provideTmpdirServer(
    ({ llm }) =>
      Effect.gen(function* () {
        const prompts = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({
          title: "task chain at global one",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        let release!: () => void
        const childGate = new Promise<void>((resolve) => {
          release = resolve
        })

        // Request 1 (parent): call the task tool. Request 2 (child): held open at
        // the server so the chain can be observed mid-flight. Request 3 (parent):
        // the answer after the task returns.
        yield* llm.tool("task", {
          description: "child at global one",
          prompt: "do the child work",
          subagent_type: "general",
        })
        yield* llm.hold("child answer", childGate)
        yield* llm.text("parent done")

        const parent = yield* prompts
          .prompt({ sessionID: chat.id, agent: "build", parts: [{ type: "text", text: "delegate it" }] })
          .pipe(Effect.forkChild)

        // The child's request reaches the model server while the parent's tool
        // call is still running. With the permit held through tool execution it
        // would queue behind the parent forever and this wait would time out.
        yield* awaitWithTimeout(
          llm.wait(2),
          "the child never reached the model while the parent's tool was running (permit held through the tool?)",
          "10 seconds",
        )
        const midFlight = yield* scheduler.capacity()
        expect(midFlight.requests.inflight).toBe(1)
        expect(midFlight.requests.cap).toBe(1)
        expect(midFlight.laneQueued.child).toBe(0)
        // The task run itself holds a child slot for the whole subagent run.
        expect(midFlight.children.running).toBe(1)
        expect(midFlight.children.dagRunning).toBe(0)

        release()
        yield* awaitWithTimeout(
          Fiber.join(parent),
          "the parent turn never finished after the child answered",
          "10 seconds",
        )

        const messages = yield* sessions.messages({ sessionID: chat.id })
        const parts = messages.flatMap((message) => message.parts)
        const task = parts.find((part) => part.type === "tool" && part.tool === "task")
        expect(task?.type === "tool" ? task.state.status : undefined).toBe("completed")
        expect(task?.type === "tool" && task.state.status === "completed" ? task.state.output : "").toContain(
          "child answer",
        )
        expect(parts.some((part) => part.type === "text" && part.text === "parent done")).toBe(true)
        expect(yield* llm.calls).toBe(3)

        // Three streams went through the one-permit pool, one at a time, and the
        // task's subagent ran in the child lane.
        expect(granted.map((entry) => entry.lane)).toEqual(["interactive", "child", "interactive"])
        expect(granted.every((entry) => entry.inflight === 1)).toBe(true)
        const settled = yield* scheduler.capacity()
        expect(settled.requests.inflight).toBe(0)
        expect(settled.children.running).toBe(0)
      }),
    {
      config: (url) => ({
        ...testProviderConfig(url),
        agent: { general: { model: "test/test-model" } },
      }),
    },
  ),
  60_000,
)
