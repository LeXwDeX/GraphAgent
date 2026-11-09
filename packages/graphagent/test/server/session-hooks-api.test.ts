// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { LayerNode } from "@graphagent/core/effect/layer-node"
import { SettingsHook } from "@/hook"
import { Session } from "@/session/session"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, httpApiLayerWith, requestInDirectory } from "./httpapi-layer"

const it = testEffect(Layer.mergeAll(Session.defaultLayer, httpApiLayer))

const cancelled: Array<{ sessionID: string; hookID: string }> = []
const settingsHook = Layer.succeed(
  SettingsHook.Service,
  SettingsHook.Service.of({
    trigger: () => Effect.succeed({ additionalContexts: [], systemMessages: [] }),
    hasEvent: () => Effect.succeed(false),
    list: () => Effect.succeed([]),
    fileWatchPaths: () => Effect.succeed([]),
    cancel: (sessionID, hookID) => {
      cancelled.push({ sessionID: String(sessionID), hookID })
      return Effect.succeed(hookID === "running-hook")
    },
  }),
)
const itWithCancel = testEffect(
  Layer.mergeAll(Session.defaultLayer, httpApiLayerWith([LayerNode.replace(SettingsHook.node, settingsHook)])),
)

afterEach(() => disposeAllInstances())

function addHook(directory: string, sessionID: string, hook: Record<string, unknown>) {
  return requestInDirectory(`/session/${sessionID}/hook`, directory, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event: "UserPromptSubmit", hooks: [hook] }),
  })
}

describe("session hook add validation", () => {
  it.instance(
    "rejects missing handler descriptors and round-trips supported command fields",
    () =>
      Effect.gen(function* () {
        const instance = yield* TestInstance
        const session = yield* Session.use.create({})
        for (const type of ["mcp", "http", "prompt", "agent"]) {
          const response = yield* addHook(instance.directory, session.id, { type })
          expect(response.status).toBe(400)
        }
        const input = {
          type: "command",
          command: "true",
          shell: "bash",
          once: true,
          statusMessage: "checking",
          options: { mode: "check" },
        }
        const added = yield* addHook(instance.directory, session.id, input)
        expect(added.status).toBe(200)
        const listed = yield* requestInDirectory(`/session/${session.id}/hook`, instance.directory)
        expect(listed.status).toBe(200)
        expect(yield* listed.json).toMatchObject([{ hooks: [input] }])
      }),
    { git: true },
  )

  it.instance(
    "rejects command-type hooks with a missing or blank command",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* Session.use.create({})

        const missing = yield* addHook(test.directory, session.id, { type: "command" })
        expect(missing.status).toBe(400)

        const blank = yield* addHook(test.directory, session.id, { type: "command", command: "   " })
        expect(blank.status).toBe(400)
      }),
    { git: true },
  )

  it.instance(
    "rejects non-positive timeout",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* Session.use.create({})

        const zero = yield* addHook(test.directory, session.id, { type: "command", command: "true", timeout: 0 })
        expect(zero.status).toBe(400)

        const negative = yield* addHook(test.directory, session.id, { type: "command", command: "true", timeout: -5 })
        expect(negative.status).toBe(400)
      }),
    { git: true },
  )

  it.instance(
    "accepts valid command and http hooks",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* Session.use.create({})

        const command = yield* addHook(test.directory, session.id, { type: "command", command: "true" })
        expect(command.status).toBe(200)
        expect(typeof ((yield* command.json) as { id: string }).id).toBe("string")

        const http = yield* addHook(test.directory, session.id, {
          type: "http",
          url: "https://hooks.example.com/endpoint",
          timeout: 30,
          headers: { authorization: "Bearer token" },
        })
        expect(http.status).toBe(200)
      }),
    { git: true },
  )
})

describe("session hook cancel", () => {
  itWithCancel.instance(
    "reports whether the addressed hook was running",
    () =>
      Effect.gen(function* () {
        const instance = yield* TestInstance
        const session = yield* Session.use.create({})
        cancelled.length = 0

        const hit = yield* requestInDirectory(`/session/${session.id}/hook/running-hook/cancel`, instance.directory, {
          method: "POST",
        })
        expect(hit.status).toBe(200)
        expect(yield* hit.json).toEqual({ cancelled: true })

        const miss = yield* requestInDirectory(`/session/${session.id}/hook/quiet-hook/cancel`, instance.directory, {
          method: "POST",
        })
        expect(miss.status).toBe(200)
        expect(yield* miss.json).toEqual({ cancelled: false })
        expect(cancelled).toEqual([
          { sessionID: session.id, hookID: "running-hook" },
          { sessionID: session.id, hookID: "quiet-hook" },
        ])
      }),
    { git: true },
  )
})
