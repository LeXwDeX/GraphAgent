import { expect, test } from "bun:test"
import type { GlobalEvent } from "@graphagent/sdk/v2"
import type { WorkerEvents, WorkerMethods } from "@/cli/tui/rpc-contract"
import { Rpc } from "@/util/rpc"

function fakeWorker() {
  const sent: unknown[] = []
  const target = {
    postMessage(data: unknown) {
      sent.push(data)
    },
    onmessage: null as ((ev: MessageEvent<any>) => any) | null,
  }
  const deliver = (data: unknown) => target.onmessage!({ data } as MessageEvent)
  return { target, sent, deliver }
}

test("client sends a typed request frame and resolves the worker result", async () => {
  const { target, sent, deliver } = fakeWorker()
  const client = Rpc.client<WorkerMethods, WorkerEvents>(target)
  const body = new Uint8Array([123, 125])

  const pending = client.call("fetch", {
    url: "http://graphagent.test/session",
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  })

  expect(sent[0]).toEqual({
    t: "req",
    id: 0,
    method: "fetch",
    input: {
      url: "http://graphagent.test/session",
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    },
  })

  const resultBody = new Uint8Array([123, 125])
  deliver({
    t: "res",
    id: 0,
    ok: true,
    result: { status: 201, headers: [["content-type", "application/json"]], body: resultBody },
  })
  expect(await pending).toEqual({ status: 201, headers: [["content-type", "application/json"]], body: resultBody })
})

test("client rejects with the structured worker error", async () => {
  const { target, deliver } = fakeWorker()
  const client = Rpc.client<WorkerMethods, WorkerEvents>(target)

  const pending = client.call("reload")
  deliver({
    t: "res",
    id: 0,
    ok: false,
    error: { name: "RpcMethodNotFound", message: "Unknown RPC method: reload", data: { method: "reload" } },
  })

  await expect(pending).rejects.toMatchObject({
    name: "RpcMethodNotFound",
    message: "Unknown RPC method: reload",
    data: { method: "reload" },
  })
})

test("client aborts the request and sends a cancel frame", async () => {
  const { target, sent, deliver } = fakeWorker()
  const client = Rpc.client<WorkerMethods, WorkerEvents>(target)
  const controller = new AbortController()

  const pending = client.call(
    "fetch",
    { url: "http://graphagent.test/session", method: "GET", headers: {} },
    { signal: controller.signal },
  )

  controller.abort()
  await expect(pending).rejects.toMatchObject({ name: "AbortError" })
  expect(sent[1]).toEqual({ t: "cancel", id: 0 })

  // A response that arrives after the cancellation is ignored.
  deliver({ t: "res", id: 0, ok: true, result: { status: 200, headers: [], body: new Uint8Array() } })
})

test("client rejects an already-aborted call without sending a frame", async () => {
  const { target, sent } = fakeWorker()
  const client = Rpc.client<WorkerMethods, WorkerEvents>(target)
  const controller = new AbortController()
  controller.abort()

  await expect(client.call("snapshot", undefined, { signal: controller.signal })).rejects.toMatchObject({
    name: "AbortError",
  })
  expect(sent).toHaveLength(0)
})

test("client dispatches typed worker events and unsubscribes", async () => {
  const { target, deliver } = fakeWorker()
  const client = Rpc.client<WorkerMethods, WorkerEvents>(target)
  const event = { type: "test.event", properties: {} } as unknown as GlobalEvent
  const received: GlobalEvent[] = []

  const off = client.on("global.event", (data) => received.push(data))
  deliver({ t: "evt", name: "global.event", data: event })
  expect(received).toEqual([event])

  off()
  deliver({ t: "evt", name: "global.event", data: event })
  expect(received).toHaveLength(1)
})
