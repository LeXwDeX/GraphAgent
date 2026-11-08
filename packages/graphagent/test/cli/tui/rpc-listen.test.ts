import { expect, test } from "bun:test"
import { CANCELLABLE_POSTS, isCancellableRequest } from "@/cli/tui/rpc-contract"
import { listen } from "@/util/rpc"

function harness() {
  const posted: Array<{ data: unknown; transfer?: Transferable[] }> = []
  let handler!: (data: unknown) => void
  const transport = {
    postMessage(data: unknown, transfer?: Transferable[]) {
      posted.push({ data, transfer })
    },
    receive(next: (data: unknown) => void) {
      handler = next
    },
  }
  return { posted, send: (data: unknown) => handler(data), transport }
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 10))
}

test("listen resolves a request frame and transfers the response body", async () => {
  const { posted, send, transport } = harness()
  const body = new Uint8Array([1, 2, 3])

  listen(
    {
      async fetch() {
        return { status: 200, headers: [], body }
      },
    },
    transport,
  )

  send({ t: "req", id: 7, method: "fetch", input: undefined })
  await settle()

  expect(posted).toHaveLength(1)
  expect(posted[0]!.data).toMatchObject({ t: "res", id: 7, ok: true, result: { status: 200, headers: [] } })
  expect(posted[0]!.transfer).toEqual([body.buffer])
})

test("listen aborts the handler signal on a cancel frame", async () => {
  const { posted, send, transport } = harness()
  let signal: AbortSignal | undefined

  listen(
    {
      fetch(_input: unknown, context: { signal: AbortSignal }) {
        signal = context.signal
        return new Promise((_resolve, reject) => {
          context.signal.addEventListener("abort", () => {
            const error = new Error("The request was aborted")
            error.name = "AbortError"
            reject(error)
          })
        })
      },
    },
    transport,
  )

  send({ t: "req", id: 3, method: "fetch", input: undefined })
  expect(signal?.aborted).toBe(false)

  send({ t: "cancel", id: 3 })
  expect(signal?.aborted).toBe(true)
  await settle()

  expect(posted[0]!.data).toMatchObject({
    t: "res",
    id: 3,
    ok: false,
    error: { name: "AbortError", message: "The request was aborted" },
  })
})

test("listen reports an unknown method as a structured RpcMethodNotFound error", async () => {
  const { posted, send, transport } = harness()

  listen({}, transport)
  send({ t: "req", id: 1, method: "missing", input: undefined })
  await settle()

  expect(posted[0]!.data).toMatchObject({
    t: "res",
    id: 1,
    ok: false,
    error: { name: "RpcMethodNotFound", message: "Unknown RPC method: missing" },
  })
})

test("listen preserves status and data from handler errors", async () => {
  const { posted, send, transport } = harness()

  listen(
    {
      async fetch() {
        const error = Object.assign(new Error("bad request"), { status: 400, data: { field: "prompt" } })
        throw error
      },
    },
    transport,
  )

  send({ t: "req", id: 2, method: "fetch", input: undefined })
  await settle()

  expect(posted[0]!.data).toMatchObject({
    t: "res",
    id: 2,
    ok: false,
    error: { name: "Error", message: "bad request", status: 400, data: { field: "prompt" } },
  })
})

test("only reads and the whitelisted btw POST are cancellable", () => {
  expect(CANCELLABLE_POSTS).toHaveLength(1)
  expect(isCancellableRequest("GET", "/session/ses_1/message")).toBe(true)
  expect(isCancellableRequest("get", "/session/ses_1/message")).toBe(true)
  expect(isCancellableRequest("HEAD", "/session/ses_1/message")).toBe(true)
  expect(isCancellableRequest("POST", "/session/ses_1/btw")).toBe(true)
  expect(isCancellableRequest("POST", "/session/ses_1/message")).toBe(false)
  expect(isCancellableRequest("POST", "/session/ses_1/abort")).toBe(false)
  expect(isCancellableRequest("DELETE", "/session/ses_1/btw")).toBe(false)
  expect(isCancellableRequest("POST", "/session/ses_1/btw/extra")).toBe(false)
})
