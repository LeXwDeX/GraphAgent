import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@graphagent/core/database/database"

import { Session } from "@/session/session"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

const it = testEffect(Layer.mergeAll(Session.defaultLayer, Database.defaultLayer, httpApiLayer))

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

type Probe = readonly [method: string, path: string]

// #1552: the five requests of the Issue, then sibling routes behind the same routing middleware
// or the same param declaration.
const malformed: ReadonlyArray<Probe> = [
  ["GET", "/session/not-a-session-id"],
  ["GET", "/session/not-a-session-id/message"],
  ["DELETE", "/session/not-a-session-id"],
  ["POST", "/session/not-a-session-id/abort"],
  ["GET", "/dag/session/not-a-session-id"],
  ["GET", "/dag/session/not-a-session-id/summary"],
  ["GET", "/session/not-a-session-id/children"],
  ["POST", "/experimental/session/not-a-session-id/background"],
]

// A session ID that is well formed but names no session.
const missing = "ses_doesnotexist"

const call = Effect.fnUntraced(function* (directory: string, [method, path]: Probe) {
  const response = yield* requestInDirectory(path, directory, { method })
  const text = yield* response.text
  return { status: response.status, body: text ? JSON.parse(text) : undefined }
})

describe("malformed session IDs over HTTP", () => {
  it.instance(
    "answer 400 with the BadRequest body of a malformed messageID",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        // The contract to match: a malformed messageID under a session that does not exist.
        const reference = yield* call(test.directory, ["GET", `/session/${missing}/message/not-a-message-id`])
        expect(reference.status).toBe(400)
        expect(reference.body).toMatchObject({ name: "BadRequest", data: { kind: "Params" } })

        const results = []
        for (const probe of malformed) {
          const { status, body } = yield* call(test.directory, probe)
          results.push({
            request: probe.join(" "),
            status,
            name: body?.name,
            kind: body?.data?.kind,
            fields: Object.keys(body?.data ?? {}).sort(),
            names: String(body?.data?.message).includes("sessionID"),
          })
        }

        expect(results).toEqual(
          malformed.map((probe) => ({
            request: probe.join(" "),
            status: 400,
            name: reference.body.name,
            kind: reference.body.data.kind,
            fields: Object.keys(reference.body.data).sort(),
            names: true,
          })),
        )
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "keep 404 for a well-formed ID that names no session",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const probes: ReadonlyArray<Probe> = [
          ["GET", `/session/${missing}`],
          ["GET", `/session/${missing}/message`],
          ["DELETE", `/session/${missing}`],
          ["GET", `/dag/session/${missing}`],
          ["GET", `/dag/session/${missing}/summary`],
        ]

        const results = []
        for (const probe of probes) {
          const { status, body } = yield* call(test.directory, probe)
          results.push({ request: probe.join(" "), status, name: body?.name })
        }

        expect(results).toEqual(
          probes.map((probe) => ({ request: probe.join(" "), status: 404, name: "NotFoundError" })),
        )

        // Abort is idempotent: it has no not-found answer for an unknown session, and it must
        // stay that way. What matters here is that the ID is not rejected as malformed.
        expect(yield* call(test.directory, ["POST", `/session/${missing}/abort`])).toEqual({
          status: 200,
          body: true,
        })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "still serve an existing session",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const created = yield* Session.Service.use((session) => session.create({}))

        const session = yield* call(test.directory, ["GET", `/session/${created.id}`])
        expect(session.status).toBe(200)
        expect(session.body).toMatchObject({ id: created.id })
        // No workflow was started for it: both DAG reads answer an empty list, not a 404.
        expect(yield* call(test.directory, ["GET", `/dag/session/${created.id}`])).toEqual({ status: 200, body: [] })
        expect(yield* call(test.directory, ["GET", `/dag/session/${created.id}/summary`])).toEqual({
          status: 200,
          body: [],
        })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )
})
