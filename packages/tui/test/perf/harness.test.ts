// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import type { GlobalEvent } from "@graphagent/sdk"
import { directory } from "../fixture/tui-sdk"
import { createFixture } from "./fixtures"
import { mountHarness } from "./harness"

function deltaEvent(sessionID: string, messageID: string, partID: string, delta: string, id: string): GlobalEvent {
  return {
    directory,
    project: "proj_test",
    payload: {
      id,
      type: "message.part.delta",
      properties: { sessionID, messageID, partID, field: "text", delta },
    },
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- synthetic fixture: only the fields the sync layer reads are populated.
  } as GlobalEvent
}

describe("perf harness store write counters", () => {
  test("count the writes the sync store performs, not the events that were sent", async () => {
    const fixture = createFixture("S", true)
    const harness = await mountHarness(fixture)
    const part = fixture.streamPart

    try {
      // A part snapshot is the one event that writes store.part, once per frame.
      const updated = harness.snapshot()
      harness.updateStream("snapshot text", 1)
      await harness.app.renderOnce()
      expect(harness.counters.delta(updated)).toMatchObject({ storePartWrites: 1, storeMessageWrites: 0 })

      // Deltas are applied (they are readable) but go to the stream buffer, so the store sees no write.
      const base = harness.sync.readPartText(harness.sync.data.part[part.messageID][0])
      const streamed = harness.snapshot()
      for (let index = 0; index < 100; index++) {
        harness.emit(deltaEvent(part.sessionID, part.messageID, part.id, "d", `evt_delta_${index}`))
      }
      await harness.app.renderOnce()
      expect(harness.counters.delta(streamed)).toMatchObject({ storePartWrites: 0, storeMessageWrites: 0 })
      expect(harness.sync.readPartText(harness.sync.data.part[part.messageID][0])).toBe(`${base}${"d".repeat(100)}`)

      // Background sessions reach the summary reducer only.
      const background = harness.snapshot()
      harness.tickBackground(1)
      await harness.app.renderOnce()
      expect(harness.counters.delta(background)).toMatchObject({ storePartWrites: 0, storeMessageWrites: 0 })
    } finally {
      await harness.dispose()
    }
  })
})
