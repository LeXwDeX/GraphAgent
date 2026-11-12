// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { createFixture, deltaEvent } from "./fixtures"
import { mountHarness } from "./harness"

describe("perf harness store write counters", () => {
  test("count the writes the sync store performs, not the events that were sent", async () => {
    const fixture = createFixture("S", true)
    const harness = await mountHarness(fixture)

    try {
      // Opening a reply is the one snapshot that writes store.part: the part is new.
      const opened = harness.snapshot()
      const stream = harness.openStream()
      await harness.app.renderOnce()
      expect(harness.counters.delta(opened)).toMatchObject({ storePartWrites: 1, storeMessageWrites: 0 })

      // The reply sits at the tail of the last assistant message, where a live reply belongs.
      const tail = fixture.messages.at(-1)!.info
      expect(stream.part.messageID).toBe(tail.id)
      expect(harness.sync.data.part[tail.id]?.at(-1)?.id).toBe(stream.part.id)

      // Deltas are applied (they are readable) but go to the stream buffer, so the store sees no write.
      const streamed = harness.snapshot()
      for (let index = 0; index < 100; index++) stream.delta("d")
      await harness.app.renderOnce()
      expect(harness.counters.delta(streamed)).toMatchObject({ storePartWrites: 0, storeMessageWrites: 0 })
      const stored = harness.sync.data.part[tail.id]?.find((part) => part.id === stream.part.id)
      expect(stored?.type === "text" ? stored.text : undefined).toBe("")
      expect(harness.sync.readPartText(stored!)).toBe("d".repeat(100))
      expect(stream.text()).toBe("d".repeat(100))

      // The terminal snapshot is the second and last store write, and it settles the buffer.
      const finished = harness.snapshot()
      stream.finish()
      await harness.app.renderOnce()
      expect(harness.counters.delta(finished)).toMatchObject({ storePartWrites: 1, storeMessageWrites: 0 })
      const settled = harness.sync.data.part[tail.id]?.find((part) => part.id === stream.part.id)
      expect(settled?.type === "text" ? settled.text : undefined).toBe("d".repeat(100))
      expect(settled?.type === "text" ? settled.time?.end : undefined).toBeDefined()

      // Background sessions reach the summary reducer only.
      const background = harness.snapshot()
      harness.tickBackground(1)
      await harness.app.renderOnce()
      expect(harness.counters.delta(background)).toMatchObject({ storePartWrites: 0, storeMessageWrites: 0 })
    } finally {
      await harness.dispose()
    }
  })

  test("a delta for a part the store does not hold is dropped, so a zero-write reading alone proves nothing", async () => {
    const fixture = createFixture("S")
    const harness = await mountHarness(fixture)

    try {
      // The head of an `L` transcript is outside the loaded page; a part there never reaches the store.
      const absent = { ...fixture.parts[0], id: "prt_absent", messageID: "msg_absent" }
      const dropped = harness.snapshot()
      harness.emit(deltaEvent(absent, "x", "evt_absent_delta"))
      await harness.app.renderOnce()

      expect(harness.counters.delta(dropped)).toMatchObject({ storePartWrites: 0, storeMessageWrites: 0 })
      expect(harness.sync.data.part["msg_absent"]).toBeUndefined()
    } finally {
      await harness.dispose()
    }
  })
})
