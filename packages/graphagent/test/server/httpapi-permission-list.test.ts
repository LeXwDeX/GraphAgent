// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// #1557: GET /permission lists the pending requests of the instance in one response, encoded as strict JSON. A request
// whose metadata held an `undefined` leaf (apply_patch wrote `movePath: undefined` for a file it does not move) made
// the whole list answer 400, so every session's pending requests became unreadable while an edit question was open.
// The real apply_patch tool, the real Permission service and the real route tree are used; only the model is absent.
import { afterEach, describe, expect } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { Effect, Fiber, Layer, Schema } from "effect"
import { LayerNode } from "@graphagent/core/effect/layer-node"
import { Database } from "@graphagent/core/database/database"
import { FSUtil } from "@graphagent/core/fs-util"
import { Ripgrep } from "@graphagent/core/ripgrep"
import { LSP } from "@/lsp/lsp"
import { FileState } from "@/session/file-state"
import { Truncate } from "@/tool/truncate"
import { Agent } from "../../src/agent/agent"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Format } from "../../src/format"
import { Permission } from "../../src/permission"
import { InstanceBootstrap } from "../../src/project/bootstrap-service"
import { InstanceStore } from "../../src/project/instance-store"
import { Project } from "../../src/project/project"
import { MessageID, SessionID } from "../../src/session/schema"
import { ApplyPatchTool } from "../../src/tool/apply_patch"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { httpApiLayerWith, requestInDirectory } from "./httpapi-layer"

const instanceStoreLayer = InstanceStore.defaultLayer.pipe(
  Layer.provide(Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))),
)

// The route tree builds its Permission service from the very layer the test holds, so both resolve to one instance
// through the layer memo map and a request the tool leaves pending is the one the endpoint lists.
const it = testEffect(
  Layer.mergeAll(
    instanceStoreLayer,
    Project.defaultLayer,
    Database.defaultLayer,
    Permission.defaultLayer,
    LSP.defaultLayer,
    FSUtil.defaultLayer,
    Format.defaultLayer,
    EventV2Bridge.defaultLayer,
    Truncate.defaultLayer,
    Agent.defaultLayer,
    FileState.defaultLayer,
    httpApiLayerWith([LayerNode.replace(Permission.node, Permission.defaultLayer)]),
  ).pipe(Layer.provide(Ripgrep.defaultLayer)),
)

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

const patch = (...lines: string[]) => ["*** Begin Patch", ...lines, "*** End Patch"].join("\n")

// What the endpoint answers, read as plain data: the files each pending edit says it touches.
const Listed = Schema.Array(
  Schema.Struct({
    permission: Schema.String,
    patterns: Schema.Array(Schema.String),
    metadata: Schema.Struct({ files: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)) }),
  }),
)

describe("GET /permission with a pending apply_patch edit", () => {
  it.instance(
    "answers 200 and lists the edit, a file that is not moved carries no movePath",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const permission = yield* Permission.Service
        const tool = yield* (yield* ApplyPatchTool).init()
        yield* Effect.promise(async () => {
          await writeFile(path.join(test.directory, "a.txt"), "one\n")
          await mkdir(path.join(test.directory, "old"), { recursive: true })
          await writeFile(path.join(test.directory, "old", "b.txt"), "old content\n")
        })

        const sessionID = SessionID.make("ses_permission_list")
        const ctx = {
          sessionID,
          messageID: MessageID.make("msg_permission_list"),
          callID: "",
          agent: "build",
          abort: AbortSignal.any([]),
          messages: [],
          metadata: () => Effect.void,
          // The question the session would raise: nobody answers it, so the tool stays suspended on it.
          ask: (input: Omit<Parameters<typeof permission.ask>[0], "sessionID" | "ruleset">) =>
            permission.ask({ ...input, sessionID, ruleset: [] }).pipe(Effect.asVoid, Effect.orDie),
        }
        const update = yield* tool
          .execute({ patchText: patch("*** Update File: a.txt", "@@", "-one", "+two") }, ctx)
          .pipe(Effect.forkScoped)
        const move = yield* tool
          .execute(
            {
              patchText: patch(
                "*** Update File: old/b.txt",
                "*** Move to: renamed/b.txt",
                "@@",
                "-old content",
                "+new content",
              ),
            },
            ctx,
          )
          .pipe(Effect.forkScoped)
        yield* pollWithTimeout(
          permission.list().pipe(Effect.map((items) => (items.length === 2 ? items : undefined))),
          "both edit questions should be pending",
        )

        const response = yield* requestInDirectory("/permission", test.directory)
        const body = yield* response.text
        // A failure shows the body: the 400 this used to be says which value could not be encoded.
        expect({ status: response.status, body: response.status === 200 ? "list" : body }).toEqual({
          status: 200,
          body: "list",
        })
        const listed = Schema.decodeUnknownSync(Listed)(JSON.parse(body))
        expect(listed).toHaveLength(2)
        expect(listed.every((item) => item.permission === "edit")).toBe(true)

        const byPattern = (pattern: string) => listed.find((item) => item.patterns.includes(pattern))
        const updated = byPattern("a.txt")?.metadata.files ?? []
        expect(updated.map((file) => file.type)).toEqual(["update"])
        expect(updated.map((file) => Object.hasOwn(file, "movePath"))).toEqual([false])
        const moved = byPattern("old/b.txt")?.metadata.files ?? []
        expect(moved.map((file) => [file.type, file.movePath])).toEqual([
          ["move", path.join(test.directory, "renamed/b.txt")],
        ])

        // Rejecting one request rejects the other pending requests of its session as well.
        const [first] = yield* permission.list()
        if (first) yield* permission.reply({ requestID: first.id, reply: "reject" })
        yield* Fiber.await(update)
        yield* Fiber.await(move)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )
})
