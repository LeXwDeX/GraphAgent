import { expect, test } from "bun:test"
import type { GlobalEvent } from "@graphagent/sdk/v2"
import type { WorkerEvents, WorkerMethods } from "@/cli/tui/rpc-contract"
import { Rpc } from "@/util/rpc"

function fakeWorker() {
  const sent: string[] = []
  const target = {
    postMessage(data: string) {
      sent.push(data)
    },
    onmessage: null as ((ev: MessageEvent<any>) => any) | null,
  }
  const deliver = (data: unknown) => target.onmessage!({ data: JSON.stringify(data) } as MessageEvent)
  return { target, sent, deliver }
}

test("client sends a typed request and resolves the worker result", async () => {
  const { target, sent, deliver } = fakeWorker()
  const client = Rpc.client<WorkerMethods, WorkerEvents>(target)

  const pending = client.call("fetch", {
    url: "http://graphagent.internal/session",
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  })

  expect(JSON.parse(sent[0]!)).toEqual({
    type: "rpc.request",
    id: 0,
    method: "fetch",
    input: {
      url: "http://graphagent.internal/session",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    },
  })

  deliver({
    type: "rpc.result",
    id: 0,
    result: { status: 201, headers: { "content-type": "application/json" }, body: "{}" },
  })
  expect(await pending).toEqual({ status: 201, headers: { "content-type": "application/json" }, body: "{}" })
})

test("client rejects with the worker error message", async () => {
  const { target, deliver } = fakeWorker()
  const client = Rpc.client<WorkerMethods, WorkerEvents>(target)

  const pending = client.call("reload")
  deliver({ type: "rpc.result", id: 0, error: "RpcMethodNotFound: reload" })

  await expect(pending).rejects.toThrow("RpcMethodNotFound: reload")
})

test("client dispatches typed worker events and unsubscribes", async () => {
  const { target, deliver } = fakeWorker()
  const client = Rpc.client<WorkerMethods, WorkerEvents>(target)
  const event = { type: "test.event", properties: {} } as unknown as GlobalEvent
  const received: GlobalEvent[] = []

  const off = client.on("global.event", (data) => received.push(data))
  deliver({ type: "rpc.event", event: "global.event", data: event })
  expect(received).toEqual([event])

  off()
  deliver({ type: "rpc.event", event: "global.event", data: event })
  expect(received).toHaveLength(1)
})
