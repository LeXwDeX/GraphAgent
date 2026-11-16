// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// #1350: a command (`/review`) drives its work through a `task` call that
// `SessionPrompt.handleSubtask` makes on its own. A PreToolUse hook that
// refuses that call (a deny verdict, or `continue:false`) is an ordinary policy
// outcome: `POST /session/:id/command` answers normally and the session keeps a
// finished tool part carrying the reason, shaped exactly like the part a model
// issued `task` call gets from the same hook. Before the fix the result had no
// `title`, the part write failed schema validation and the route answered 500.
import { afterEach, describe, expect } from "bun:test"
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
import { testEffect } from "../lib/effect"
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
const refusals = [
  {
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
  },
  {
    name: "continue:false",
    hook: { continue: false, stopReason: "budget exhausted" },
    output: "[Hook stopped] budget exhausted",
    metadata: { hookStopped: true, stopReason: "budget exhausted" },
  },
] as const

type Refusal = (typeof refusals)[number]

function refusedSession(directory: string, refusal: Refusal) {
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
    return session
  })
}

function taskPart(directory: string, sessionID: SessionID) {
  return Session.use.messages({ sessionID }).pipe(
    provideInstanceEffect(directory),
    Effect.orDie,
    Effect.map((messages) =>
      messages
        .filter((message) => message.info.role === "assistant")
        .flatMap((message) => message.parts)
        .filter((part): part is SessionV1.ToolPart => part.type === "tool" && part.tool === "task"),
    ),
  )
}

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
        // The command's own follow-up turn, after the refused subtask.
        yield* llm.text("summarized")
        const directory = yield* tmpdirScoped({ git: true, config: testProviderConfig(llm.url) })
        const session = yield* refusedSession(directory, refusal)

        const response = yield* post(route(SessionPaths.command, session.id), directory, {
          command: "review",
          arguments: "",
          model: "test/test-model",
        })
        expect(response.status).toBe(200)
        const body = yield* response.json
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
        yield* llm.text("summarized")
        const directory = yield* tmpdirScoped({ git: true, config: testProviderConfig(llm.url) })

        const viaCommand = yield* refusedSession(directory, refusal)
        const commanded = yield* post(route(SessionPaths.command, viaCommand.id), directory, {
          command: "review",
          arguments: "",
          model: "test/test-model",
        })
        expect(commanded.status).toBe(200)
        yield* commanded.json

        // Whether or not the command asked the model for a follow-up turn, the
        // model-issued run starts from its own script.
        yield* llm.reset
        yield* llm.tool("task", { description: "inspect bug", prompt: "look into it", subagent_type: "general" })
        yield* llm.text("done")
        const viaModel = yield* refusedSession(directory, refusal)
        const prompted = yield* post(route(SessionPaths.prompt, viaModel.id), directory, {
          agent: "build",
          model: { providerID: "test", modelID: "test-model" },
          parts: [{ type: "text", text: "run the task" }],
        })
        expect(prompted.status).toBe(200)
        yield* prompted.json

        const [fromCommand] = yield* taskPart(directory, viaCommand.id)
        const [fromModel] = yield* taskPart(directory, viaModel.id)
        expect(shape(fromCommand)).toEqual(shape(fromModel))
        expect(shape(fromCommand)).toMatchObject({ status: "completed", output: refusal.output })
      }).pipe(Effect.provide(TestLLMServer.layer), Effect.provide(CrossSpawnSpawner.defaultLayer)),
    )
  }
})
