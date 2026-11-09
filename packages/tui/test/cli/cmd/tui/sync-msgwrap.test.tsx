// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { GlobalEvent } from "@graphagent/sdk"
import { tmpdir } from "../../../fixture/fixture"
import { json, mount, wait } from "./sync-fixture"

const sessionID = "ses_msgwrap"

const session = {
  id: sessionID,
  title: "wrap",
  time: { created: 0, updated: 0 },
  version: "1.15.13",
  directory: "/tmp/opencode/packages/graphagent",
}

const preWrapAssistant = {
  id: "msg_fffac212c001",
  sessionID,
  role: "assistant" as const,
  agent: "build",
  modelID: "test-model",
  providerID: "test",
  mode: "build",
  parentID: "msg_fffac212c000",
  path: { cwd: session.directory, root: session.directory },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1786700000000, completed: 1786700001000 },
}

const postWrapUser = {
  id: "msg_00090cb04001",
  sessionID,
  role: "user" as const,
  agent: "build",
  model: { providerID: "test", modelID: "test-model" },
  time: { created: 1786707000000 },
}

function global(payload: GlobalEvent["payload"]): GlobalEvent {
  return { directory: "/tmp/other", project: "proj_test", payload }
}

test("message.updated with a cross-era id appends after pre-wrap messages", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const { app, emit, sync } = await mount((url) => {
    if (url.pathname === `/session/${sessionID}`) return json(session)
    if (url.pathname === `/session/${sessionID}/message`) return json([{ info: preWrapAssistant, parts: [] }])
    if (url.pathname === `/session/${sessionID}/todo` || url.pathname === `/session/${sessionID}/diff`) return json([])
    return undefined
  }, tmp.path)

  try {
    await sync.session.sync(sessionID)
    expect(sync.data.message[sessionID]?.map((message) => message.id)).toStrictEqual([preWrapAssistant.id])
    emit(global({ id: "evt_new_user", type: "message.updated", properties: { sessionID, info: postWrapUser } }))
    await wait(() => sync.data.message[sessionID]?.length === 2)
    expect(sync.data.message[sessionID]?.map((message) => message.id)).toStrictEqual([
      preWrapAssistant.id,
      postWrapUser.id,
    ])
  } finally {
    app.renderer.destroy()
  }
})
