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
// round. A PostToolUseFailure hook stops a call the other way round: the call
// fails, and the failure itself carries the stop (`HookToolStop`), which the
// processor reads off the error. The command turn ends on that too.
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
import { SessionRetry } from "@/session/retry"
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

// A hook the session carries for the task call: the event it answers and the JSON its command prints.
interface Policy {
  readonly event: "PreToolUse" | "PostToolUseFailure"
  readonly hook: unknown
}

// The refusal as the hook protocol writes it; both are plain command hooks.
const deny = {
  name: "a deny verdict",
  event: "PreToolUse",
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
  event: "PreToolUse",
  hook: { continue: false, stopReason: "budget exhausted" },
  output: "[Hook stopped] budget exhausted",
  metadata: { hookStopped: true, stopReason: "budget exhausted" },
} as const

const refusals = [deny, stop] as const

// The call itself fails (see `failChild`) and PostToolUseFailure sees the failure. This hook stops the turn on it...
const failureStop = {
  event: "PostToolUseFailure",
  hook: { continue: false, stopReason: "STOPPED-AFTER-FAILURE" },
} as const

// ...and this one has no opinion about it.
const failureSeen = { event: "PostToolUseFailure", hook: {} } as const

// A Stop hook that records each run and always asks for another turn.
const keepGoing = hookCommand(`
  require("node:fs").appendFileSync(require("node:path").join(process.env.CLAUDE_PROJECT_DIR, "stop-runs.log"), "ran\\n");
  console.log(JSON.stringify({ decision: "block", reason: "KEEP-GOING" }))
`)

// A foreground subtask command, so that its `task` call runs a real child session.
const withInspect = (url: string) => ({
  ...testProviderConfig(url),
  command: {
    inspect: {
      template: "inspect the repository",
      description: "inspect the repository",
      agent: "general",
      subtask: true,
    },
  },
})

// A child run asks the provider this often before it gives up and fails the `task` call.
const CHILD_REQUESTS = SessionRetry.RETRY_MAX_RETRIES + 1

const failChild = Effect.gen(function* () {
  const llm = yield* TestLLMServer
  for (let request = 0; request < CHILD_REQUESTS; request++)
    yield* llm.error(503, { error: { message: "subagent request rejected" } }, { "retry-after-ms": "0" })
})

// What a run adds to the plain refused call: a Stop hook the session carries, the slash command to run,
// and a child run that fails.
interface Run {
  readonly stopHook?: string
  readonly command?: string
  readonly childFails?: boolean
}

function refusedSession(directory: string, refusal: Policy, stopHook?: string) {
  return Effect.gen(function* () {
    const session = yield* Session.use
      .create({
        title: "refused task",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      .pipe(provideInstanceEffect(directory))
    const hook = yield* post(route(SessionPaths.hook, session.id), directory, {
      event: refusal.event,
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
function viaCommand(directory: string, refusal: Policy, run: Run = {}) {
  return Effect.gen(function* () {
    const llm = yield* TestLLMServer
    yield* llm.reset
    if (run.childFails) yield* failChild
    // The answer to the summary round, if the command asks for one.
    yield* llm.text("summarized")
    const session = yield* refusedSession(directory, refusal, run.stopHook)
    const response = yield* post(route(SessionPaths.command, session.id), directory, {
      command: run.command ?? "review",
      arguments: "",
      model: "test/test-model",
    })
    expect(response.status).toBe(200)
    return { session, body: yield* response.json, calls: yield* llm.calls }
  })
}

// The same `task` call issued by the model: its first request is the call itself.
function viaModel(directory: string, refusal: Policy, run: Run = {}) {
  return Effect.gen(function* () {
    const llm = yield* TestLLMServer
    yield* llm.reset
    yield* llm.tool("task", { description: "inspect bug", prompt: "look into it", subagent_type: "general" })
    if (run.childFails) yield* failChild
    yield* llm.text("done")
    const session = yield* refusedSession(directory, refusal, run.stopHook)
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
      const commanded = yield* viaCommand(commandDir, stop, { stopHook: keepGoing })
      expect(commanded.calls).toBe(0)
      expect(yield* stopRuns(commandDir)).toBe(1)

      const prompted = yield* viaModel(modelDir, stop, { stopHook: keepGoing })
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

describe("command turn after a subtask that fails under a PostToolUseFailure hook (#1351)", () => {
  it.live("continue:false ends the turn at the failed subtask, as it does after a model-issued call", () =>
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      const directory = yield* tmpdirScoped({ git: true, config: withInspect(llm.url) })

      const commanded = yield* viaCommand(directory, failureStop, { command: "inspect", childFails: true })
      // The call failed and the hook's stop is on the failure.
      const [part] = yield* taskPart(directory, commanded.session.id)
      expect(part.state.status).toBe("error")
      if (part.state.status === "error") expect(part.state.error).toContain("STOPPED-AFTER-FAILURE")
      // The turn ends there: the child run's requests are the only ones, and no summary prompt is left behind.
      expect(commanded.calls).toBe(CHILD_REQUESTS)
      expect(yield* roles(directory, commanded.session.id)).toEqual(["user", "assistant"])
      yield* idle(directory)

      // The model path: the request that issues the call, the child run's requests, and the turn ends on the failure.
      const prompted = yield* viaModel(directory, failureStop, { childFails: true })
      expect(prompted.calls).toBe(1 + CHILD_REQUESTS)
      yield* idle(directory)
    }).pipe(Effect.provide(TestLLMServer.layer), Effect.provide(CrossSpawnSpawner.defaultLayer)),
  )

  it.live("a failure nothing stops lets the turn go on with one summary round, as after a model-issued call", () =>
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      const directory = yield* tmpdirScoped({ git: true, config: withInspect(llm.url) })

      const commanded = yield* viaCommand(directory, failureSeen, { command: "inspect", childFails: true })
      const [part] = yield* taskPart(directory, commanded.session.id)
      expect(part.state.status).toBe("error")
      // The failure is a result the model may report: exactly one more request, answering the summary prompt.
      expect(commanded.calls).toBe(CHILD_REQUESTS + 1)
      expect(yield* roles(directory, commanded.session.id)).toEqual(["user", "assistant", "user", "assistant"])
      yield* idle(directory)

      // The model path: the request that issues the call, the child run's requests, then the one that reads the failure.
      const prompted = yield* viaModel(directory, failureSeen, { childFails: true })
      expect(prompted.calls).toBe(1 + CHILD_REQUESTS + 1)
      yield* idle(directory)
    }).pipe(Effect.provide(TestLLMServer.layer), Effect.provide(CrossSpawnSpawner.defaultLayer)),
  )
})
