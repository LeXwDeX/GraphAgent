// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { batch } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import { probeStoreWrites } from "./store-write-probe"

type Part = { id: string; text: string; state: { output: string } }

function fixture() {
  const [store, set] = createStore<{
    part: Record<string, Part[]>
    message: Record<string, Array<{ id: string }>>
    status: string
  }>({
    part: { msg_1: [{ id: "prt_1", text: "a", state: { output: "x" } }] },
    message: { ses_1: [{ id: "msg_1" }] },
    status: "idle",
  })
  return { store, set }
}

describe("probeStoreWrites", () => {
  test("counts a nested write once, on its own slice only", () => {
    const { store, set } = fixture()
    const probe = probeStoreWrites(store, ["part", "message"])

    set("part", "msg_1", 0, "text", "b")
    expect(probe.writes("part")).toBe(1)
    set("part", "msg_1", 0, "state", "output", "y")
    expect(probe.writes("part")).toBe(2)
    expect(probe.writes("message")).toBe(0)
    expect(probe.total()).toBe(2)
    probe.dispose()
  })

  test("coalesces the writes of one batch into a single count", () => {
    const { store, set } = fixture()
    const probe = probeStoreWrites(store, ["part"])

    batch(() => {
      for (let index = 0; index < 100; index++) set("part", "msg_1", 0, "text", `t${index}`)
    })
    expect(probe.writes("part")).toBe(1)
    // Outside a batch every write is its own flush.
    for (let index = 0; index < 5; index++) set("part", "msg_1", 0, "text", `u${index}`)
    expect(probe.writes("part")).toBe(6)
    probe.dispose()
  })

  test("a write that changes nothing counts zero", () => {
    const { store, set } = fixture()
    const probe = probeStoreWrites(store, ["part", "message"])

    set("part", "msg_1", 0, "text", "a")
    set("part", "msg_1", 0, reconcile({ id: "prt_1", text: "a", state: { output: "x" } }))
    set("status", "idle")
    expect(probe.total()).toBe(0)
    probe.dispose()
  })

  test("counts reconcile and produce writes the way the sync store issues them", () => {
    const { store, set } = fixture()
    const probe = probeStoreWrites(store, ["part"])

    set("part", "msg_1", 0, reconcile({ id: "prt_1", text: "changed", state: { output: "x" } }))
    expect(probe.writes("part")).toBe(1)
    set(
      "part",
      "msg_1",
      produce((draft) => {
        draft.splice(1, 0, { id: "prt_2", text: "", state: { output: "" } })
      }),
    )
    expect(probe.writes("part")).toBe(2)
    probe.dispose()
  })

  test("counts a key that appears or disappears after the probe attached", () => {
    const { store, set } = fixture()
    const probe = probeStoreWrites(store, ["part"])

    set("part", "msg_2", [{ id: "prt_9", text: "n", state: { output: "" } }])
    expect(probe.writes("part")).toBe(1)
    set("part", "msg_2", 0, "text", "m")
    expect(probe.writes("part")).toBe(2)
    set(
      "part",
      produce((draft) => {
        delete draft.msg_1
      }),
    )
    expect(probe.writes("part")).toBe(3)
    probe.dispose()
  })

  test("reports the slice and key of every counted write", () => {
    const { store, set } = fixture()
    const seen: Array<[string, string]> = []
    const probe = probeStoreWrites(store, ["part", "message"], (slice, key) => seen.push([slice, key]))

    set("message", "ses_1", 0, "id", "msg_9")
    set("part", "msg_1", 0, "text", "z")
    expect(seen).toEqual([
      ["message", "ses_1"],
      ["part", "msg_1"],
    ])
    probe.dispose()
  })

  test("stops counting after dispose", () => {
    const { store, set } = fixture()
    const probe = probeStoreWrites(store, ["part"])

    set("part", "msg_1", 0, "text", "b")
    probe.dispose()
    set("part", "msg_1", 0, "text", "c")
    set("part", "msg_3", [])
    expect(probe.writes("part")).toBe(1)
  })

  test("rejects a slice that is not an object", () => {
    const { store } = fixture()
    expect(() => probeStoreWrites(store, ["status"])).toThrow('store slice "status" is not an object or array')
  })
})
