// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { expect } from "bun:test"
import { SettingsHook } from "@/hook"
import { SessionHooks } from "@/hook/session-hooks"
import { HookRewakeLive } from "@/hook/rewake-live"
import { HookFileWatch } from "@/hook/file-watch"
import { HookLifecycle } from "@/hook/lifecycle"
import { Effect, Fiber, Layer, Option } from "effect"
import { LayerNode } from "@graphagent/core/effect/layer-node"
import { CrossSpawnSpawner } from "@graphagent/core/cross-spawn-spawner"
import { Database } from "@graphagent/core/database/database"
import { SessionProjector } from "@graphagent/core/session/projector"
import { LSP } from "@/lsp/lsp"
import { MCP } from "@/mcp"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { SessionSummary } from "@/session/summary"
import { SessionID } from "@/session/schema"
import { provideTmpdirServer } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"

/**
 * Issue #1019 PR8 acceptance: ESC must settle a cancelled turn quickly, both
 * while a fake provider is streaming and while a shell command is running.
 * Issue #1026 PR1 adds the third shape: cancelling a child run, measured until
 * the child's streaming turn has settled.
 *
 * The Issue requires 50 samples per shape with p95 < 600 ms on shared CI and
 * p95 < 200 ms on the self-hosted machine. The default bound here is the shared
 * one; run with `GRAPHAGENT_CANCEL_P95_MS=200` on the self-hosted machine to
 * enforce the stricter bound. The measured values are written to stderr so a CI
 * log always carries the numbers, not just a pass/fail.
 */

const SAMPLES = 50
const WARMUP = 3
const LIMIT_MS = Number(process.env.GRAPHAGENT_CANCEL_P95_MS ?? "600")

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
  SessionPrompt.node,
  SettingsHook.node,
  HookRewakeLive.node,
  HookLifecycle.node,
  SessionHooks.node,
  HookFileWatch.node,
  Session.node,
  SessionProjector.node,
  SessionSummary.node,
  Database.node,
  CrossSpawnSpawner.node,
  SessionRunState.node,
  SessionStatus.node,
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
          variants: { xhigh: {}, high: {} },
        },
      },
      options: {
        apiKey: "test-key",
        baseURL: url,
      },
    },
  },
})

/** Nearest-rank p95 over the measured samples. */
function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))
  return sorted[index]
}

function report(label: string, samples: number[]) {
  const p95 = percentile(samples, 0.95)
  const max = Math.max(...samples)
  const median = percentile(samples, 0.5)
  process.stderr.write(
    `[cancel-latency] ${label}: n=${samples.length} median=${median.toFixed(1)}ms p95=${p95.toFixed(1)}ms max=${max.toFixed(1)}ms limit=${LIMIT_MS}ms\n`,
  )
  return p95
}

const waitForBusy = (sessionID: SessionID) =>
  pollWithTimeout(
    Effect.gen(function* () {
      const status = yield* SessionStatus.Service
      const current = yield* status.get(sessionID)
      return current.type === "busy" ? (true as const) : undefined
    }),
    `session ${sessionID} never became busy`,
    "5 seconds",
  )

// The shell scenario uses POSIX process-group cancellation (`sleep 30`), so the
// benchmark is skipped on Windows rather than asserting a different contract.
const live = process.platform === "win32" ? it.live.skip : it.live

live(
  "cancelling a streaming turn settles within the shared-CI p95 budget",
  provideTmpdirServer(
    ({ llm }) =>
      Effect.gen(function* () {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const session = yield* sessions.create({ title: "cancel latency streaming" })
        let requests = 0
        const samples: number[] = []
        for (let i = 0; i < WARMUP + SAMPLES; i++) {
          let release!: () => void
          const gate = new Promise<void>((resolve) => {
            release = resolve
          })
          yield* llm.hold("held streaming answer", gate)
          const running = yield* prompt
            .prompt({
              sessionID: session.id,
              agent: "build",
              parts: [{ type: "text", text: `streaming cancel ${i}` }],
            })
            .pipe(Effect.forkChild)
          requests += 1
          yield* llm.wait(requests)
          const measured = yield* Effect.gen(function* () {
            const started = performance.now()
            const settled = yield* prompt.cancel(session.id).pipe(
              Effect.andThen(Fiber.await(running)),
              Effect.timeoutOption("10 seconds"),
            )
            const elapsed = performance.now() - started
            return { elapsed, settled }
          }).pipe(Effect.ensuring(Effect.sync(() => release())))
          expect(Option.isSome(measured.settled)).toBe(true)
          if (i >= WARMUP) samples.push(measured.elapsed)
        }
        const p95 = report("streaming", samples)
        expect(p95).toBeLessThan(LIMIT_MS)
      }),
    { git: true, config: providerCfg },
  ),
  60_000,
)

live(
  "cancelling a running shell command settles within the shared-CI p95 budget",
  provideTmpdirServer(
    () =>
      Effect.gen(function* () {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const session = yield* sessions.create({ title: "cancel latency shell" })
        const samples: number[] = []
        for (let i = 0; i < WARMUP + SAMPLES; i++) {
          const running = yield* prompt
            .shell({ sessionID: session.id, agent: "build", command: "sleep 30" })
            .pipe(Effect.forkChild)
          yield* waitForBusy(session.id)
          const started = performance.now()
          const settled = yield* prompt.cancel(session.id).pipe(
            Effect.andThen(Fiber.await(running)),
            Effect.timeoutOption("10 seconds"),
          )
          const elapsed = performance.now() - started
          expect(Option.isSome(settled)).toBe(true)
          if (i >= WARMUP) samples.push(elapsed)
        }
        const p95 = report("shell", samples)
        expect(p95).toBeLessThan(LIMIT_MS)
      }),
    { git: true, config: providerCfg },
  ),
  60_000,
)

live(
  "cancelling a child run settles its streaming turn within the shared-CI p95 budget",
  provideTmpdirServer(
    ({ llm }) =>
      Effect.gen(function* () {
        const prompt = yield* SessionPrompt.Service
        const children = yield* prompt.children
        const sessions = yield* Session.Service
        const parent = yield* sessions.create({ title: "cancel latency child run parent" })
        let requests = 0
        const samples: number[] = []
        for (let i = 0; i < WARMUP + SAMPLES; i++) {
          // What the task tool does: a child session of the parent, one registered run, one driven turn.
          const child = yield* sessions.create({ parentID: parent.id, title: `cancel latency child ${i}` })
          const run = yield* children.start({
            parentSessionID: parent.id,
            childSessionID: child.id,
            owner: { kind: "task", toolCallID: `call_${i}` },
            detached: true,
          })
          yield* run.markRunning
          let release!: () => void
          const gate = new Promise<void>((resolve) => {
            release = resolve
          })
          yield* llm.hold("held streaming answer", gate)
          const running = yield* prompt
            .prompt(
              { sessionID: child.id, agent: "build", parts: [{ type: "text", text: `child cancel ${i}` }] },
              { internalDelegation: true },
            )
            .pipe(Effect.forkChild)
          requests += 1
          yield* llm.wait(requests)
          const measured = yield* Effect.gen(function* () {
            const started = performance.now()
            // Signal-and-return, then the child's turn settles: the measurement
            // runs until both the run and the turn are done.
            const settled = yield* children
              .cancel(run.id, { kind: "main_agent_tool", toolCallID: `cancel_${i}` })
              .pipe(
                Effect.andThen(Effect.all([run.settled, Fiber.await(running)], { concurrency: "unbounded" })),
                Effect.timeoutOption("10 seconds"),
              )
            const elapsed = performance.now() - started
            return { elapsed, settled }
          }).pipe(Effect.ensuring(Effect.sync(() => release())))
          expect(Option.isSome(measured.settled)).toBe(true)
          if (i >= WARMUP) samples.push(measured.elapsed)
        }
        const p95 = report("child run", samples)
        expect(p95).toBeLessThan(LIMIT_MS)
      }),
    { git: true, config: providerCfg },
  ),
  60_000,
)
