/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type { GlobalEvent } from "@graphagent/sdk/v2"
import { onMount } from "solid-js"
import { SDKProvider, useSDK, type EventSource } from "../../src/context/sdk"
import { createFetch, directory } from "../fixture/tui-sdk"
import { TestTuiContexts } from "../fixture/tui-environment"

function event(id: string): GlobalEvent {
  return {
    directory,
    payload: { id, type: "vcs.branch.updated", properties: { branch: id } },
  } as unknown as GlobalEvent
}

async function mount(source: EventSource) {
  const seen: string[] = []
  let ready!: () => void
  let sdk!: ReturnType<typeof useSDK>
  const mounted = new Promise<void>((resolve) => {
    ready = resolve
  })

  function Probe() {
    sdk = useSDK()
    onMount(() => {
      sdk.event.on("event", (evt) => seen.push(evt.payload.id!))
      void sdk.setInterest(["ses_a"]).then(ready)
    })
    return <box />
  }

  const app = await testRender(() => (
    <TestTuiContexts>
      <SDKProvider url="http://test" directory={directory} events={source} fetch={createFetch().fetch}>
        <Probe />
      </SDKProvider>
    </TestTuiContexts>
  ))
  await mounted
  return { app, seen, sdk }
}

describe("SDK event transport", () => {
  test("prefers a worker batch and flushes it as one frame batch", async () => {
    let handler: ((events: GlobalEvent[]) => void) | undefined
    const source: EventSource = {
      subscribe: async () => () => {},
      subscribeBatch: async (next) => {
        handler = next
        return () => {
          handler = undefined
        }
      },
      setInterest: async () => {},
    }
    const { app, seen, sdk } = await mount(source)

    try {
      handler!([event("evt_1"), event("evt_2")])
      // The frame clock owns the batch; until it flushes nothing is emitted.
      expect(seen).toEqual([])
      sdk.frameClock.flushNow()
      expect(seen).toEqual(["evt_1", "evt_2"])
    } finally {
      app.renderer.destroy()
    }
  })

  test("forwards setInterest through the event source", async () => {
    const interest: Array<readonly string[]> = []
    const source: EventSource = {
      subscribe: async () => () => {},
      setInterest: async (full) => {
        interest.push(full)
      },
    }
    const { app } = await mount(source)

    try {
      expect(interest).toEqual([["ses_a"]])
    } finally {
      app.renderer.destroy()
    }
  })

  test("falls back to per-event subscription for sources without batching", async () => {
    let handler: ((event: GlobalEvent) => void) | undefined
    const source: EventSource = {
      subscribe: async (next) => {
        handler = next
        return () => {
          handler = undefined
        }
      },
    }
    const { app, seen, sdk } = await mount(source)

    try {
      handler!(event("evt_3"))
      sdk.frameClock.flushNow()
      expect(seen).toEqual(["evt_3"])
    } finally {
      app.renderer.destroy()
    }
  })
})
