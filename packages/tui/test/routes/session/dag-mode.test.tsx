// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { Session } from "@graphagent/sdk"
import { useDagIndicator } from "../../../src/routes/session/dag-mode"
import type { DagIndicatorState } from "../../../src/shell/dag-indicator"
import { directory, json } from "../../fixture/tui-sdk"
import { dagModeStatus, mountRoute, sessionFixture, waitFor, type MountOptions } from "../dag-mode-harness"

const mainID = "ses_indicator_main"
const otherID = "ses_indicator_other"
const childID = "ses_indicator_child"

async function mountIndicator(
  sessions: readonly Session[],
  route: MountOptions["route"],
  extra: Partial<MountOptions> = {},
) {
  let indicator!: () => DagIndicatorState | undefined
  function Probe() {
    indicator = useDagIndicator()
    return <box />
  }
  const harness = await mountRoute({ route, view: () => <Probe />, sessions, ...extra })
  const lookups = (id: string) => harness.requested.filter((item) => item === `GET /session/${id}/dag-mode`).length
  const updated = async (info: Session) => {
    harness.events.emit({
      directory,
      payload: {
        id: `evt_${info.id}_${Math.random().toString(36).slice(2)}`,
        type: "session.updated",
        properties: { sessionID: info.id, info },
      },
    })
    await harness.settle()
  }
  return { ...harness, indicator: () => indicator(), lookups, updated }
}

test("a session with the mode off shows off and never asks for availability", async () => {
  const harness = await mountIndicator([sessionFixture(mainID, { dagMode: "off" })], {
    type: "session",
    sessionID: mainID,
  })
  try {
    expect(harness.indicator()).toBe("off")
    expect(harness.lookups(mainID)).toBe(0)
  } finally {
    await harness.dispose()
  }
})

test("a session without a recorded mode shows off", async () => {
  const harness = await mountIndicator([sessionFixture(mainID)], { type: "session", sessionID: mainID })
  try {
    expect(harness.indicator()).toBe("off")
  } finally {
    await harness.dispose()
  }
})

test("an available session with the mode on shows on after one lookup", async () => {
  const harness = await mountIndicator([sessionFixture(mainID, { dagMode: "on" })], {
    type: "session",
    sessionID: mainID,
  })
  try {
    expect(harness.indicator()).toBe("on")
    expect(harness.lookups(mainID)).toBe(1)
  } finally {
    await harness.dispose()
  }
})

test("an unavailable session with the mode on shows unavailable", async () => {
  const harness = await mountIndicator(
    [sessionFixture(mainID, { dagMode: "on" })],
    { type: "session", sessionID: mainID },
    { dagMode: () => dagModeStatus({ availability: "unavailable", unavailableReason: "start_denied" }) },
  )
  try {
    await waitFor(() => harness.indicator() === "unavailable")
    expect(harness.lookups(mainID)).toBe(1)
  } finally {
    await harness.dispose()
  }
})

test("a failed lookup leaves the plain on state", async () => {
  const harness = await mountIndicator(
    [sessionFixture(mainID, { dagMode: "on" })],
    { type: "session", sessionID: mainID },
    { dagMode: () => json({ name: "UnknownError" }, { status: 500 }) },
  )
  try {
    await harness.settle()
    expect(harness.lookups(mainID)).toBe(1)
    expect(harness.indicator()).toBe("on")
  } finally {
    await harness.dispose()
  }
})

test("home and sub-agent views have no indicator and no lookup", async () => {
  const home = await mountIndicator([sessionFixture(mainID, { dagMode: "on" })], { type: "home" })
  try {
    expect(home.indicator()).toBeUndefined()
    expect(home.lookups(mainID)).toBe(0)
  } finally {
    await home.dispose()
  }

  const child = await mountIndicator(
    [sessionFixture(mainID, { dagMode: "on" }), sessionFixture(childID, { parentID: mainID, dagMode: "on" })],
    { type: "session", sessionID: childID },
  )
  try {
    expect(child.indicator()).toBeUndefined()
    expect(child.lookups(childID)).toBe(0)
  } finally {
    await child.dispose()
  }
})

test("the server's session.updated drives the mode and a lookup runs only while it is on", async () => {
  const harness = await mountIndicator([sessionFixture(mainID, { dagMode: "off" })], {
    type: "session",
    sessionID: mainID,
  })
  try {
    expect(harness.indicator()).toBe("off")

    await harness.updated(sessionFixture(mainID, { dagMode: "on" }))
    expect(harness.indicator()).toBe("on")
    expect(harness.lookups(mainID)).toBe(1)

    await harness.updated(sessionFixture(mainID, { dagMode: "off" }))
    expect(harness.indicator()).toBe("off")
    expect(harness.lookups(mainID)).toBe(1)
  } finally {
    await harness.dispose()
  }
})

test("a new model or agent re-reads availability, an unrelated update does not", async () => {
  let status = dagModeStatus()
  const harness = await mountIndicator(
    [sessionFixture(mainID, { dagMode: "on", agent: "build", model: { id: "m1", providerID: "p" } })],
    { type: "session", sessionID: mainID },
    { dagMode: () => status },
  )
  try {
    expect(harness.indicator()).toBe("on")
    expect(harness.lookups(mainID)).toBe(1)

    await harness.updated(
      sessionFixture(mainID, { dagMode: "on", agent: "build", model: { id: "m1", providerID: "p" }, title: "renamed" }),
    )
    expect(harness.lookups(mainID)).toBe(1)

    status = dagModeStatus({ availability: "unavailable", unavailableReason: "model_no_tool_calling" })
    await harness.updated(
      sessionFixture(mainID, { dagMode: "on", agent: "build", model: { id: "m2", providerID: "p" } }),
    )
    await waitFor(() => harness.indicator() === "unavailable")
    expect(harness.lookups(mainID)).toBe(2)

    status = dagModeStatus()
    await harness.updated(
      sessionFixture(mainID, { dagMode: "on", agent: "plan", model: { id: "m2", providerID: "p" } }),
    )
    await waitFor(() => harness.indicator() === "on")
    expect(harness.lookups(mainID)).toBe(3)
  } finally {
    await harness.dispose()
  }
})

test("a reconnect re-reads availability", async () => {
  let status = dagModeStatus()
  const harness = await mountIndicator(
    [sessionFixture(mainID, { dagMode: "on" })],
    { type: "session", sessionID: mainID },
    { dagMode: () => status },
  )
  try {
    expect(harness.indicator()).toBe("on")
    status = dagModeStatus({ availability: "unavailable", unavailableReason: "workflow_tool_disabled" })
    harness.events.reconnect()
    await waitFor(() => harness.indicator() === "unavailable")
    expect(harness.lookups(mainID)).toBe(2)
  } finally {
    await harness.dispose()
  }
})

test("switching sessions never carries availability over", async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  const harness = await mountIndicator(
    [sessionFixture(mainID, { dagMode: "on" }), sessionFixture(otherID, { dagMode: "on" })],
    { type: "session", sessionID: mainID },
    {
      dagMode: async (id) => {
        if (id === mainID) return dagModeStatus({ availability: "unavailable", unavailableReason: "start_denied" })
        await gate
        return dagModeStatus()
      },
    },
  )
  try {
    await waitFor(() => harness.indicator() === "unavailable")

    harness.route().navigate({ type: "session", sessionID: otherID })
    await harness.settle()
    // The other session's lookup is still pending: it must not inherit the first answer.
    expect(harness.lookups(otherID)).toBe(1)
    expect(harness.indicator()).toBe("on")
    release()
    await harness.settle()
    expect(harness.indicator()).toBe("on")

    harness.route().navigate({ type: "home" })
    await harness.settle()
    expect(harness.indicator()).toBeUndefined()
  } finally {
    release()
    await harness.dispose()
  }
})

test("the indicator reads no write endpoint", async () => {
  const harness = await mountIndicator([sessionFixture(mainID, { dagMode: "on" })], {
    type: "session",
    sessionID: mainID,
  })
  try {
    await harness.settle()
    expect(harness.writes()).toEqual([])
  } finally {
    await harness.dispose()
  }
})
