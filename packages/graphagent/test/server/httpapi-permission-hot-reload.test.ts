// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// #1678: a permission edit made in `/config` writes the global configuration (`PATCH /global/config`). It must govern
// the NEXT tool call of the session that is already open, a call of the same running turn included, and it must
// neither interrupt that turn nor reject the question the user has not answered yet.
//
// The real route tree, the real session loop, the real `write` tool and the real Permission service are used; only the
// model is scripted (an OpenAI-compatible HTTP stub). A scripted model asks for a `write` call and the test reports
// what the permission layer made of it: `ask` (the call waited for the user), `allow` (it ran) or `deny` (it was
// refused).
import { afterAll, afterEach, beforeEach, describe, expect } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect, Fiber } from "effect"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { isRecord } from "@/util/record"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdirScoped } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { reply as scripted, TestLLMServer } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"
import { waitGlobalBusEvent } from "./global-bus"
import { httpApiLayer, request, requestInDirectory } from "./httpapi-layer"

const previousConfigDir = process.env.GRAPHAGENT_TEST_CONFIG_DIR
const configDir = path.join(os.tmpdir(), `graphagent-permission-hot-${process.pid}`)
process.env.GRAPHAGENT_TEST_CONFIG_DIR = configDir

const it = testEffect(httpApiLayer)
const withLlm = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.provide(TestLLMServer.layer))

beforeEach(async () => {
  await fs.rm(configDir, { recursive: true, force: true })
  await fs.mkdir(configDir, { recursive: true })
})

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

afterAll(async () => {
  if (previousConfigDir === undefined) delete process.env.GRAPHAGENT_TEST_CONFIG_DIR
  else process.env.GRAPHAGENT_TEST_CONFIG_DIR = previousConfigDir
  await fs.rm(configDir, { recursive: true, force: true })
})

type Action = "allow" | "ask" | "deny"
type Outcome = "allow" | "ask" | "deny"
type Reply = "once" | "always" | "reject"

const json = { "content-type": "application/json" }
const TIMEOUT = { timeout: 60_000 }

const call = (directory: string, url: string, init: { method: string; body?: unknown }) =>
  requestInDirectory(url, directory, {
    method: init.method,
    ...(init.body === undefined ? {} : { headers: json, body: JSON.stringify(init.body) }),
  })

/** The user's global configuration: the scripted model, and the one rule under test. */
const writeGlobalConfig = (llmUrl: string, edit: Action) =>
  Effect.promise(() =>
    fs.writeFile(
      path.join(configDir, "graphagent.jsonc"),
      JSON.stringify({ ...testProviderConfig(llmUrl), permission: { edit } }, null, 2),
    ),
  )

const createSession = (directory: string) =>
  Effect.gen(function* () {
    // No `permission` field: the TUI creates its sessions without one.
    const response = yield* call(directory, "/session", {
      method: "POST",
      body: { title: "permission", agent: "build" },
    })
    expect(response.status).toBe(200)
    const created = yield* response.json
    if (!isRecord(created) || typeof created.id !== "string") throw new Error("session response has no id")
    return created.id
  })

const pendingOf = (directory: string, sessionID: string) =>
  Effect.gen(function* () {
    const response = yield* call(directory, "/permission", { method: "GET" })
    const listed = yield* response.json
    if (!Array.isArray(listed)) return []
    return listed.filter(isRecord).filter((item) => item.sessionID === sessionID)
  })

/** The state of every tool call of the session so far, oldest first. */
const toolCalls = (directory: string, sessionID: string) =>
  Effect.gen(function* () {
    const response = yield* call(directory, `/session/${sessionID}/message`, { method: "GET" })
    const messages = yield* response.json
    if (!Array.isArray(messages)) return []
    return messages
      .filter(isRecord)
      .flatMap((message) => (Array.isArray(message.parts) ? message.parts : []))
      .filter(isRecord)
      .filter((part) => part.type === "tool")
      .flatMap((part) => (isRecord(part.state) ? [part.state] : []))
  })

/** The turn the scripted model drives: accepted, and running from here on. */
const startTurn = (directory: string, sessionID: string) =>
  Effect.gen(function* () {
    const accepted = yield* call(directory, `/session/${sessionID}/prompt_async`, {
      method: "POST",
      body: {
        agent: "build",
        model: { providerID: "test", modelID: "test-model" },
        parts: [{ type: "text", text: "write the files" }],
      },
    })
    expect(accepted.status).toBe(204)
  })

/** The turn is over once the session no longer reports a status (idle sessions are left out of the map). */
const turnEnded = (directory: string, sessionID: string) =>
  pollWithTimeout(
    Effect.gen(function* () {
      const response = yield* call(directory, "/session/status", { method: "GET" })
      const status = yield* response.json
      return isRecord(status) && status[sessionID] === undefined ? (true as const) : undefined
    }),
    "the turn never ended",
    "15 seconds",
  )

/**
 * What became of the `index`-th tool call of the session: it is waiting for the user (`ask`, with the request to
 * answer), it ran (`allow`) or it was refused (`deny`). The earlier calls of the session are not looked at.
 */
const outcomeOf = (directory: string, sessionID: string, index: number) =>
  pollWithTimeout(
    Effect.gen(function* () {
      const pending = yield* pendingOf(directory, sessionID)
      if (pending.length > 0) return { outcome: "ask" as const, id: String(pending[0]?.id) }
      const state = (yield* toolCalls(directory, sessionID))[index]
      if (state?.status === "completed") return { outcome: "allow" as const }
      if (state?.status === "error") return { outcome: "deny" as const, error: String(state.error) }
      return undefined
    }),
    () => `tool call ${index} neither asked nor settled`,
    "15 seconds",
  )

const answer = (directory: string, id: string, reply: Reply) =>
  Effect.gen(function* () {
    const response = yield* call(directory, `/permission/${id}/reply`, { method: "POST", body: { reply } })
    expect(response.status).toBe(200)
  })

/** The outcome of the `index`-th tool call, answering the question it raised, if it raised one, with `reply`. */
const settle = (directory: string, sessionID: string, index: number, reply: Reply = "once") =>
  Effect.gen(function* () {
    const seen = yield* outcomeOf(directory, sessionID, index)
    if (seen.outcome === "ask") yield* answer(directory, seen.id, reply)
    return seen.outcome satisfies Outcome
  })

const isEvent = (type: string) => (event: GlobalEvent) => isRecord(event.payload) && event.payload.type === type

/** PATCH /global/config, then wait for what the TUI waits for: `config.updated`, or the instances disposed. */
const patchGlobal = (patch: Record<string, unknown>) =>
  Effect.gen(function* () {
    const settled = yield* waitGlobalBusEvent({
      message: "neither config.updated nor global.disposed followed the config write",
      predicate: (event) => isEvent("config.updated")(event) || isEvent("global.disposed")(event),
    }).pipe(Effect.forkScoped({ startImmediately: true }))
    const response = yield* request("/global/config", { method: "PATCH", headers: json, body: JSON.stringify(patch) })
    expect(response.status).toBe(200)
    yield* Fiber.join(settled)
  })

const editRule = (action: Action) => patchGlobal({ permission: { edit: action } })

/** Wait until the scripted model has been asked `count` times for the conversation (the title request is not one). */
const modelAsked = (llm: TestLLMServer["Service"], count: number) =>
  pollWithTimeout(
    Effect.gen(function* () {
      const hits = yield* llm.hits
      const asked = hits.filter((hit) => !JSON.stringify(hit.body).includes("Generate a title")).length
      return asked >= count ? (true as const) : undefined
    }),
    () => `the model was not asked ${count} times`,
    "15 seconds",
  )

/** A session in a new project directory, under the global rule `initial`. */
const openSession = (llm: TestLLMServer["Service"], initial: Action) =>
  Effect.gen(function* () {
    yield* writeGlobalConfig(llm.url, initial)
    const directory = yield* tmpdirScoped({ git: true })
    return { directory, sessionID: yield* createSession(directory) }
  })

type Session = { directory: string; sessionID: string }

/** One turn in which the model asks for one `write`; returns what the permission layer made of it. */
const probe = (llm: TestLLMServer["Service"], session: Session, name: string, reply?: Reply) =>
  Effect.gen(function* () {
    const before = (yield* toolCalls(session.directory, session.sessionID)).length
    yield* llm.tool("write", { filePath: path.join(session.directory, name), content: `${name}\n` })
    yield* startTurn(session.directory, session.sessionID)
    const outcome = yield* settle(session.directory, session.sessionID, before, reply)
    yield* turnEnded(session.directory, session.sessionID)
    return outcome
  })

/**
 * One session, one probe turn per configuration: the first under `initial`, then one after each edit in `changes`.
 * `firstReply` answers the first probe when it asks.
 */
const turns = (input: { initial: Action; firstReply?: Reply; changes: readonly Action[] }) =>
  withLlm(
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      const session = yield* openSession(llm, input.initial)
      const outcomes: Outcome[] = [yield* probe(llm, session, "probe-0.txt", input.firstReply)]
      for (const [index, action] of input.changes.entries()) {
        yield* editRule(action)
        outcomes.push(yield* probe(llm, session, `probe-${index + 1}.txt`))
      }
      return outcomes
    }),
  )

/** A turn of two `write` calls whose second model request is held back until `release` is called. */
const twoCallTurn = (llm: TestLLMServer["Service"], session: Session, closing: string) => {
  let release: () => void = () => {}
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  return Effect.gen(function* () {
    yield* llm.tool("write", { filePath: path.join(session.directory, "first.txt"), content: "first\n" })
    yield* llm.push(
      scripted()
        .wait(held)
        .tool("write", { filePath: path.join(session.directory, "second.txt"), content: "second\n" }),
    )
    yield* llm.text(closing)
    yield* startTurn(session.directory, session.sessionID)
    return release
  })
}

/**
 * One turn of two `write` calls, with the edits made while the model is still composing the second call: what the
 * rule decided for each of them. `firstReply` answers the first call when it asks; the second is answered `once`.
 */
const midTurn = (input: { initial: Action; firstReply?: Reply; changes: readonly Action[] }) =>
  withLlm(
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      const session = yield* openSession(llm, input.initial)
      const release = yield* twoCallTurn(llm, session, "done")
      const first = yield* settle(session.directory, session.sessionID, 0, input.firstReply)
      // The model's second request is out and held: the turn is in the middle of its work.
      yield* modelAsked(llm, 2)
      for (const action of input.changes) yield* editRule(action)
      release()
      const second = yield* settle(session.directory, session.sessionID, 1)
      yield* turnEnded(session.directory, session.sessionID)
      return { first, second }
    }),
  )

describe("a /config permission edit reaches the open session", () => {
  it.live(
    "ask -> allow: the next turn's call runs",
    () =>
      Effect.gen(function* () {
        expect(yield* turns({ initial: "ask", changes: ["allow"] })).toEqual(["ask", "allow"])
      }),
    TIMEOUT,
  )

  it.live(
    "allow -> ask: the next turn's call waits for the user",
    () =>
      Effect.gen(function* () {
        expect(yield* turns({ initial: "allow", changes: ["ask"] })).toEqual(["allow", "ask"])
      }),
    TIMEOUT,
  )

  it.live(
    "allow -> deny: the next turn's call is refused",
    () =>
      Effect.gen(function* () {
        expect(yield* turns({ initial: "allow", changes: ["deny"] })).toEqual(["allow", "deny"])
      }),
    TIMEOUT,
  )

  it.live(
    "'always allow' answered under ask, then allow, then ask again: the call waits for the user again",
    () =>
      Effect.gen(function* () {
        expect(yield* turns({ initial: "ask", firstReply: "always", changes: ["allow", "ask"] })).toEqual([
          "ask",
          "allow",
          "ask",
        ])
      }),
    { timeout: 90_000 },
  )

  it.live(
    "'always allow' answered under ask, then deny: the next turn's call is refused",
    () =>
      Effect.gen(function* () {
        expect(yield* turns({ initial: "ask", firstReply: "always", changes: ["deny"] })).toEqual(["ask", "deny"])
      }),
    TIMEOUT,
  )
})

describe("a /config permission edit in the middle of a running turn", () => {
  it.live(
    "allow -> ask: the turn goes on and its next call waits for the user",
    () =>
      Effect.gen(function* () {
        expect(yield* midTurn({ initial: "allow", changes: ["ask"] })).toEqual({ first: "allow", second: "ask" })
      }),
    TIMEOUT,
  )

  it.live(
    "ask -> allow: the turn goes on and its next call runs",
    () =>
      Effect.gen(function* () {
        expect(yield* midTurn({ initial: "ask", changes: ["allow"] })).toEqual({ first: "ask", second: "allow" })
      }),
    TIMEOUT,
  )

  it.live(
    "allow -> deny: the turn goes on and its next call is refused",
    () =>
      Effect.gen(function* () {
        expect(yield* midTurn({ initial: "allow", changes: ["deny"] })).toEqual({ first: "allow", second: "deny" })
      }),
    TIMEOUT,
  )

  it.live(
    "'always allow' answered to the first call, then allow, then ask: the second call waits for the user",
    () =>
      Effect.gen(function* () {
        expect(yield* midTurn({ initial: "ask", firstReply: "always", changes: ["allow", "ask"] })).toEqual({
          first: "ask",
          second: "ask",
        })
      }),
    { timeout: 90_000 },
  )

  it.live(
    "'always allow' answered to the first call is kept while the rule is only loosened",
    () =>
      Effect.gen(function* () {
        expect(yield* midTurn({ initial: "ask", firstReply: "always", changes: ["allow"] })).toEqual({
          first: "ask",
          second: "allow",
        })
      }),
    TIMEOUT,
  )

  it.live(
    "a question the user has not answered yet is not rejected, and answering it lets the call run",
    () =>
      withLlm(
        Effect.gen(function* () {
          const llm = yield* TestLLMServer
          const session = yield* openSession(llm, "ask")
          const { directory, sessionID } = session
          yield* llm.tool("write", { filePath: path.join(directory, "waiting.txt"), content: "waiting\n" })
          yield* startTurn(directory, sessionID)
          const asked = yield* outcomeOf(directory, sessionID, 0)
          if (asked.outcome !== "ask") throw new Error(`expected the call to ask, it was ${asked.outcome}`)

          // The edit arrives while the call waits: the rule changes, the waiting request stays the user's to decide.
          yield* editRule("allow")
          expect((yield* pendingOf(directory, sessionID)).map((item) => item.id)).toEqual([asked.id])
          expect((yield* toolCalls(directory, sessionID)).map((state) => state.status)).toEqual(["running"])

          yield* answer(directory, asked.id, "once")
          yield* turnEnded(directory, sessionID)
          expect((yield* toolCalls(directory, sessionID)).map((state) => state.status)).toEqual(["completed"])
          expect(yield* Effect.promise(() => Bun.file(path.join(directory, "waiting.txt")).text())).toBe("waiting\n")

          // And the new rule governs what comes next.
          expect(yield* probe(llm, session, "after.txt")).toBe("allow")
        }),
      ),
    TIMEOUT,
  )

  it.live(
    "an edit to other keys leaves the turn running to its end: no message of the session ends in an error",
    () =>
      withLlm(
        Effect.gen(function* () {
          const llm = yield* TestLLMServer
          const session = yield* openSession(llm, "allow")
          const { directory, sessionID } = session
          const release = yield* twoCallTurn(llm, session, "all done")
          yield* modelAsked(llm, 2)
          yield* patchGlobal({ permission: { bash: "ask", webfetch: "deny" } })
          release()
          yield* turnEnded(directory, sessionID)

          const response = yield* call(directory, `/session/${sessionID}/message`, { method: "GET" })
          const messages = yield* response.json
          if (!Array.isArray(messages)) throw new Error("messages is not a list")
          const errors = messages
            .filter(isRecord)
            .map((message) => (isRecord(message.info) ? message.info.error : undefined))
            .filter((error) => error !== undefined)
          expect(errors).toEqual([])
          expect((yield* toolCalls(directory, sessionID)).map((state) => state.status)).toEqual([
            "completed",
            "completed",
          ])
        }),
      ),
    TIMEOUT,
  )
})

describe("what a permission edit announces", () => {
  it.live(
    "config.updated names the key and no instance is disposed",
    () =>
      withLlm(
        Effect.gen(function* () {
          const llm = yield* TestLLMServer
          const session = yield* openSession(llm, "allow")
          yield* probe(llm, session, "warm.txt")
          const events: GlobalEvent[] = []
          const listener = (event: GlobalEvent) => events.push(event)
          GlobalBus.on("event", listener)
          yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", listener)))
          yield* editRule("ask")
          // A disposal would be forked behind the response; give a late event room to land.
          yield* Effect.sleep("300 millis")
          expect(
            events.filter((event) => isEvent("config.updated")(event)).map((event) => event.payload.properties),
          ).toEqual([{ keys: ["permission"] }])
          expect(
            events.some((event) => isEvent("global.disposed")(event) || isEvent("server.instance.disposed")(event)),
          ).toBe(false)
        }),
      ),
    TIMEOUT,
  )
})
