// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// #1350: a command (`/review`) drives its work through a `task` call that
// `SessionPrompt.handleSubtask` makes on its own. A PreToolUse hook that
// refuses that call (a deny verdict, or `continue:false`) is an ordinary policy
// outcome: `POST /session/:id/command` answers normally and the session keeps a
// finished tool part carrying the reason, shaped exactly like the part a model
// issued `task` call gets from the same hook. Before the fix the result had no
// `title`, the part write failed schema validation and the route answered 500.
//
// #1351: the refusal also decides how the command's turn goes on, and that
// matches the model path. A deny verdict is a tool result the model may react
// to, so the command asks the model once more (the summary round).
// `continue:false` means stop: the processor ends a model turn on the result's
// `hookStopped` metadata, and the command turn ends there too, with no summary
// round.
import { afterEach, describe, expect } from "bun:test"
import { join } from "node:path"
import { SessionV1 } from "@graphagent/core/v1/session"
import { CrossSpawnSpawner } from "@graphagent/core/cross-spawn-spawner"
import { Ripgrep } from "@graphagent/core/ripgrep"
import { Database } from "@graphagent/core/database/database"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { InstanceBootstrap as InstanceBootstrapService } from "../../src/project/bootstrap-service"
import { InstanceStore } from "../../src/project/instance-store"
import { Project } from "../../src/project/project"
import { SessionPaths } from "../../src/server/routes/instance/httpapi/groups/session"
import { Session } from "@/session/session"
import type { SessionID } from "../../src/session/schema"
import { resetDatabase } from "../fixture/db"
import { hookCommand } from "../fixture/claude-hook"
import { disposeAllInstances, provideInstanceEffect, tmpdirScoped } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"
import { isRecord } from "@/util/record"
import { httpApiLayer } from "./httpapi-layer"

const instanceStoreLayer = InstanceStore.defaultLayer.pipe(
  Layer.provide(
    Layer.succeed(InstanceBootstrapService.Service, InstanceBootstrapService.Service.of({ run: Effect.void })),
  ),
)
const it = testEffect(
  Layer.mergeAll(
    instanceStoreLayer,
    Project.defaultLayer,
    Session.defaultLayer,
    Database.defaultLayer,
    httpApiLayer,
  ).pipe(Layer.provide(Ripgrep.defaultLayer)),
)

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

function request(path: string, init: RequestInit) {
  const url = new URL(path, "http://localhost")
  return HttpClientRequest.fromWeb(new Request(url, init)).pipe(
    HttpClientRequest.setUrl(url.pathname),
    HttpClient.execute,
  )
}

function post(route: string, directory: string, body: unknown) {
  return request(route, {
    method: "POST",
    headers: { "content-type": "application/json", "x-graphagent-directory": directory },
    body: JSON.stringify(body),
  })
}

const route = (template: string, sessionID: SessionID) => template.replace(":sessionID", sessionID)

// The refusal as the hook protocol writes it; both are plain command hooks.
const deny = {
  name: "a deny verdict",
  hook: {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "subagents are off limits",
    },
  },
  output: "[Tool denied by hook] subagents are off limits",
  metadata: { hookDenied: true },
} as const

const stop = {
  name: "continue:false",
  hook: { continue: false, stopReason: "budget exhausted" },
  output: "[Hook stopped] budget exhausted",
  metadata: { hookStopped: true, stopReason: "budget exhausted" },
} as const

const refusals = [deny, stop] as const

type Refusal = (typeof refusals)[number]

// A Stop hook that records each run and always asks for another turn.
const keepGoing = hookCommand(`
  require("node:fs").appendFileSync(require("node:path").join(process.env.CLAUDE_PROJECT_DIR, "stop-runs.log"), "ran\\n");
  console.log(JSON.stringify({ decision: "block", reason: "KEEP-GOING" }))
`)

function refusedSession(directory: string, refusal: Refusal, stopHook?: string) {
  return Effect.gen(function* () {
    const session = yield* Session.use
      .create({
        title: "refused task",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      .pipe(provideInstanceEffect(directory))
    const hook = yield* post(route(SessionPaths.hook, session.id), directory, {
      event: "PreToolUse",
      hooks: [
        { type: "command", command: hookCommand(`console.log(JSON.stringify(${JSON.stringify(refusal.hook)}))`) },
      ],
    })
    expect(hook.status).toBe(200)
    if (stopHook) {
      const added = yield* post(route(SessionPaths.hook, session.id), directory, {
        event: "Stop",
        hooks: [{ type: "command", command: stopHook }],
      })
      expect(added.status).toBe(200)
    }
    return session
  })
}

// `/review` makes its own `task` call; the model is only asked afterwards, if at all.
function viaCommand(directory: string, refusal: Refusal, stopHook?: string) {
  return Effect.gen(function* () {
    const llm = yield* TestLLMServer
    yield* llm.reset
    // The answer to the summary round, if the command asks for one.
    yield* llm.text("summarized")
    const session = yield* refusedSession(directory, refusal, stopHook)
    const response = yield* post(route(SessionPaths.command, session.id), directory, {
      command: "review",
      arguments: "",
      model: "test/test-model",
    })
    expect(response.status).toBe(200)
    return { session, body: yield* response.json, calls: yield* llm.calls }
  })
}

// The same `task` call issued by the model: its first request is the call itself.
function viaModel(directory: string, refusal: Refusal, stopHook?: string) {
  return Effect.gen(function* () {
    const llm = yield* TestLLMServer
    yield* llm.reset
    yield* llm.tool("task", { description: "inspect bug", prompt: "look into it", subagent_type: "general" })
    yield* llm.text("done")
    const session = yield* refusedSession(directory, refusal, stopHook)
    const response = yield* post(route(SessionPaths.prompt, session.id), directory, {
      agent: "build",
      model: { providerID: "test", modelID: "test-model" },
      parts: [{ type: "text", text: "run the task" }],
    })
    expect(response.status).toBe(200)
    yield* response.json
    return { session, calls: yield* llm.calls }
  })
}

function transcript(directory: string, sessionID: SessionID) {
  return Session.use.messages({ sessionID }).pipe(provideInstanceEffect(directory), Effect.orDie)
}

function taskPart(directory: string, sessionID: SessionID) {
  return transcript(directory, sessionID).pipe(
    Effect.map((messages) =>
      messages
        .filter((message) => message.info.role === "assistant")
        .flatMap((message) => message.parts)
        .filter((part): part is SessionV1.ToolPart => part.type === "tool" && part.tool === "task"),
    ),
  )
}

const roles = (directory: string, sessionID: SessionID) =>
  transcript(directory, sessionID).pipe(Effect.map((messages) => messages.map((message) => message.info.role)))

// How often `keepGoing` ran in this directory.
const stopRuns = (directory: string) =>
  Effect.promise(() =>
    Bun.file(join(directory, "stop-runs.log"))
      .text()
      .catch(() => ""),
  ).pipe(Effect.map((log) => log.split("\n").filter(Boolean).length))

// The runner publishes idle once the turn is over; an idle session has no status entry.
const idle = (directory: string) =>
  pollWithTimeout(
    Effect.gen(function* () {
      const response = yield* request(SessionPaths.status, {
        method: "GET",
        headers: { "x-graphagent-directory": directory },
      })
      const statuses = yield* response.json
      return isRecord(statuses) && Object.keys(statuses).length === 0 ? (true as const) : undefined
    }),
    "the session never went idle",
  )

// What a client reads off the part; time, input and ids differ by construction.
function shape(part: SessionV1.ToolPart) {
  const state = part.state
  if (state.status !== "completed") return { status: state.status }
  return { status: state.status, title: state.title, output: state.output, metadata: state.metadata }
}

describe("command-driven subtask refused by a PreToolUse hook (#1350)", () => {
  for (const refusal of refusals) {
    it.live(`${refusal.name} finishes the tool part and the command route answers normally`, () =>
      Effect.gen(function* () {
        const llm = yield* TestLLMServer
        const directory = yield* tmpdirScoped({ git: true, config: testProviderConfig(llm.url) })

        const { session, body } = yield* viaCommand(directory, refusal)
        expect(isRecord(body) && isRecord(body.info) ? body.info.role : undefined).toBe("assistant")

        const parts = yield* taskPart(directory, session.id)
        expect(parts).toHaveLength(1)
        const part = parts[0]
        expect(part.state.status).toBe("completed")
        if (part.state.status !== "completed") return
        expect(part.state.title).toBe("task")
        expect(part.state.output).toBe(refusal.output)
        expect(part.state.metadata).toEqual(refusal.metadata)
        // The refused call never ran: no child session was started for it.
        expect(yield* Session.use.children(session.id).pipe(provideInstanceEffect(directory))).toHaveLength(0)
      }).pipe(Effect.provide(TestLLMServer.layer), Effect.provide(CrossSpawnSpawner.defaultLayer)),
    )

    it.live(`${refusal.name} leaves the same part as a model-issued task call`, () =>
      Effect.gen(function* () {
        const llm = yield* TestLLMServer
        const directory = yield* tmpdirScoped({ git: true, config: testProviderConfig(llm.url) })

        const commanded = yield* viaCommand(directory, refusal)
        const prompted = yield* viaModel(directory, refusal)

        const [fromCommand] = yield* taskPart(directory, commanded.session.id)
        const [fromModel] = yield* taskPart(directory, prompted.session.id)
        expect(shape(fromCommand)).toEqual(shape(fromModel))
        expect(shape(fromCommand)).toMatchObject({ status: "completed", output: refusal.output })
      }).pipe(Effect.provide(TestLLMServer.layer), Effect.provide(CrossSpawnSpawner.defaultLayer)),
    )
  }
})

describe("command turn after a subtask refused by a PreToolUse hook (#1351)", () => {
  it.live("continue:false ends the turn at the subtask, as it does after a model-issued call", () =>
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      const directory = yield* tmpdirScoped({ git: true, config: testProviderConfig(llm.url) })

      const commanded = yield* viaCommand(directory, stop)
      // No summary round: the model is never asked, and no summary prompt is left in the transcript.
      expect(commanded.calls).toBe(0)
      expect(yield* roles(directory, commanded.session.id)).toEqual(["user", "assistant"])
      yield* idle(directory)

      // The model path: its only request is the one that issues the call, and the turn ends on the result.
      const prompted = yield* viaModel(directory, stop)
      expect(prompted.calls).toBe(1)
      expect(yield* roles(directory, prompted.session.id)).toEqual(["user", "assistant"])
      yield* idle(directory)
    }).pipe(Effect.provide(TestLLMServer.layer), Effect.provide(CrossSpawnSpawner.defaultLayer)),
  )

  it.live("continue:false is final: a Stop hook asking for another turn cannot reopen it", () =>
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      const commandDir = yield* tmpdirScoped({ git: true, config: testProviderConfig(llm.url) })
      const modelDir = yield* tmpdirScoped({ git: true, config: testProviderConfig(llm.url) })

      // The Stop hook still observes the stopped turn once, but a blocked turn cannot continue.
      const commanded = yield* viaCommand(commandDir, stop, keepGoing)
      expect(commanded.calls).toBe(0)
      expect(yield* stopRuns(commandDir)).toBe(1)

      const prompted = yield* viaModel(modelDir, stop, keepGoing)
      expect(prompted.calls).toBe(1)
      expect(yield* stopRuns(modelDir)).toBe(1)
    }).pipe(Effect.provide(TestLLMServer.layer), Effect.provide(CrossSpawnSpawner.defaultLayer)),
  )

  it.live("a deny verdict lets the turn go on with one summary round, as it does after a model-issued call", () =>
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      const directory = yield* tmpdirScoped({ git: true, config: testProviderConfig(llm.url) })

      const commanded = yield* viaCommand(directory, deny)
      // The refusal is a result the model may react to: exactly one more request, answering the summary prompt.
      expect(commanded.calls).toBe(1)
      expect(yield* roles(directory, commanded.session.id)).toEqual(["user", "assistant", "user", "assistant"])
      yield* idle(directory)

      // The model path: the request that issues the call, then the one that reads the refusal.
      const prompted = yield* viaModel(directory, deny)
      expect(prompted.calls).toBe(2)
      yield* idle(directory)
    }).pipe(Effect.provide(TestLLMServer.layer), Effect.provide(CrossSpawnSpawner.defaultLayer)),
  )
})
