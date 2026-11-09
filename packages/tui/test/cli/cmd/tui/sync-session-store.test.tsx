// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { GlobalEvent } from "@graphagent/sdk"
import { tmpdir } from "../../../fixture/fixture"
import { json, mount, wait } from "./sync-fixture"

const sessionOld = {
  id: "ses_aaa111",
  slug: "old",
  projectID: "proj_test",
  title: "old",
  time: { created: 1, updated: 1 },
  version: "1.15.13",
  directory: "/tmp/opencode/packages/graphagent",
}

const sessionMid = {
  id: "ses_bbb222",
  slug: "mid",
  projectID: "proj_test",
  title: "mid",
  time: { created: 2, updated: 2 },
  version: "1.15.13",
  directory: "/tmp/opencode/packages/graphagent",
}

const sessionNew = {
  id: "ses_ccc333",
  slug: "new",
  projectID: "proj_test",
  title: "new",
  time: { created: 3, updated: 3 },
  version: "1.15.13",
  directory: "/tmp/opencode/packages/graphagent",
}

function global(payload: GlobalEvent["payload"]): GlobalEvent {
  return { directory: "/tmp/other", project: "proj_test", payload }
}

test("session.updated keeps one entry per session id regardless of recency order", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const sessions = [sessionNew, sessionMid, sessionOld]
  const { app, emit, sync } = await mount((url) => {
    if (url.pathname === "/session") return json(sessions)
    return undefined
  }, tmp.path)

  try {
    await sync.session.refresh()
    expect(sync.data.session.map((session) => session.id)).toStrictEqual([sessionOld.id, sessionMid.id, sessionNew.id])
    // Touching the oldest session moves it to most-recent by time.updated;
    // the id-keyed store must reconcile in place, never duplicate.
    emit(
      global({
        id: "evt_touch_old",
        type: "session.updated",
        properties: { sessionID: sessionOld.id, info: { ...sessionOld, time: { ...sessionOld.time, updated: 99 } } },
      }),
    )
    await wait(() => sync.data.session.find((session) => session.id === sessionOld.id)?.time.updated === 99)
    expect(sync.data.session.map((session) => session.id)).toStrictEqual([sessionOld.id, sessionMid.id, sessionNew.id])
  } finally {
    app.renderer.destroy()
  }
})

test("session.deleted removes the session even when recency order diverges from id order", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const sessions = [sessionNew, sessionOld, sessionMid]
  const { app, emit, sync } = await mount((url) => {
    if (url.pathname === "/session") return json(sessions)
    return undefined
  }, tmp.path)

  try {
    await sync.session.refresh()
    emit(
      global({
        id: "evt_delete_mid",
        type: "session.deleted",
        properties: { sessionID: sessionMid.id, info: sessionMid },
      }),
    )
    await wait(() => !sync.data.session.some((session) => session.id === sessionMid.id))
    expect(sync.data.session.map((session) => session.id)).toStrictEqual([sessionOld.id, sessionNew.id])
  } finally {
    app.renderer.destroy()
  }
})
