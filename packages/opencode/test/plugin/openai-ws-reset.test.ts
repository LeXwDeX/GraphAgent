import { expect, test } from "bun:test"
import { createServer, type Server as HttpServer, type ServerResponse } from "node:http"
import WebSocket, { WebSocketServer } from "ws"
import { createWebSocketFetch } from "../../src/plugin/openai/ws-pool"

test("reset drops idle sockets, ignores unknown sessions, and leaves other sessions connected", async () => {
  let upgrades = 0
  const messages: string[] = []
  await using server = await createWebSocketServer((socket, request) => {
    upgrades++
    socket.on("message", () => {
      messages.push(String(request.headers["session-id"]))
      socket.send(JSON.stringify({ type: "response.completed", response: { id: `resp_${messages.length}` } }))
    })
  })
  const transport = createWebSocketFetch({ url: server.url })
  try {
    expect(await (await transport(server.url, streamRequest())).text()).toContain("data: [DONE]")
    expect(await (await transport(server.url, streamRequest({ "session-id": "session-2" }))).text()).toContain(
      "data: [DONE]",
    )
    expect(upgrades).toBe(2)

    transport.reset("session-1")
    transport.reset("session-1")
    transport.reset("unknown")
    expect(await (await transport(server.url, streamRequest())).text()).toContain("data: [DONE]")
    expect(await (await transport(server.url, streamRequest({ "session-id": "session-2" }))).text()).toContain(
      "data: [DONE]",
    )

    expect(upgrades).toBe(3)
    expect(messages).toEqual(["session-1", "session-2", "session-1", "session-2"])
  } finally {
    transport.close()
  }
})

test("reset after a completed response reuses no stale socket", async () => {
  let upgrades = 0
  await using server = await createWebSocketServer((socket) => {
    upgrades++
    socket.once("message", () => {
      socket.send(JSON.stringify({ type: "response.completed", response: { id: `resp_${upgrades}` } }))
    })
  })
  const transport = createWebSocketFetch({ url: server.url })
  try {
    expect(await (await transport(server.url, streamRequest())).text()).toContain("data: [DONE]")
    transport.reset("session-1")
    expect(await (await transport(server.url, streamRequest())).text()).toContain("data: [DONE]")
    expect(upgrades).toBe(2)
  } finally {
    transport.close()
  }
})

test("a busy reset keeps the in-flight request and replaces the socket after its terminal", async () => {
  let upgrades = 0
  let requests = 0
  let socket: WebSocket | undefined
  await using server = await createWebSocketServer((next) => {
    upgrades++
    socket = next
    next.on("message", () => {
      requests++
      next.send(
        JSON.stringify({
          type: requests === 1 ? "response.output_text.delta" : "response.completed",
          ...(requests === 1 ? { delta: "started" } : { response: { id: "resp_1" } }),
        }),
      )
    })
  })
  const transport = createWebSocketFetch({ url: server.url })
  try {
    const first = await transport(server.url, streamRequest())
    const firstText = first.text()
    await waitFor(() => requests === 1, "the first request did not start")
    transport.reset("session-1")
    // The in-flight response still receives its terminal event.
    socket!.send(JSON.stringify({ type: "response.completed", response: { id: "resp_first" } }))
    expect(await firstText).toContain("data: [DONE]")

    expect(await (await transport(server.url, streamRequest())).text()).toContain("data: [DONE]")
    expect(upgrades).toBe(2)
    expect(requests).toBe(2)
  } finally {
    transport.close()
  }
})

test("a reset while the socket is connecting is deferred until the owned request completes", async () => {
  let connections = 0
  await using server = await createDelayedWebSocketServer((socket) => {
    connections++
    socket.once("message", () => {
      socket.send(JSON.stringify({ type: "response.completed", response: { id: `resp_${connections}` } }))
    })
  })
  const transport = createWebSocketFetch({ url: server.url, streamRetries: 0 })
  try {
    const first = transport(server.url, streamRequest())
    await waitFor(() => server.pending.has("session-1"), "the websocket handshake did not start")
    transport.reset("session-1")
    server.release("session-1")
    expect(await (await first).text()).toContain("data: [DONE]")

    const second = transport(server.url, streamRequest())
    await waitFor(() => server.pending.has("session-1"), "the replacement websocket did not start connecting")
    server.release("session-1")
    expect(await (await second).text()).toContain("data: [DONE]")
    expect(connections).toBe(2)
    expect(server.httpRequests).toHaveLength(0)
  } finally {
    transport.close()
  }
})

test("reset preserves the stream failure budget and a sticky HTTP fallback decision", async () => {
  let upgrades = 0
  await using server = await createWebSocketServer((socket) => {
    upgrades++
    socket.once("message", () => {
      socket.send(JSON.stringify({ type: "response.output_text.delta", delta: "started" }))
      socket.terminate()
    })
  })
  await using fallback = await createHttpServer()
  const transport = createWebSocketFetch({ url: server.url, streamRetries: 2 })
  try {
    const failure = async () => {
      const response = await transport(fallback.url, streamRequest())
      return readTextError(response.text())
    }
    expect((await failure()).message).toContain("WebSocket closed before response.completed")
    transport.reset("session-1")
    expect((await failure()).message).toContain("WebSocket closed before response.completed")

    // The third failure crosses the budget only when reset kept the counter.
    expect(await (await transport(fallback.url, streamRequest())).text()).toBe("http")
    transport.reset("session-1")
    expect(await (await transport(fallback.url, streamRequest())).text()).toBe("http")

    expect(upgrades).toBe(3)
    expect(fallback.httpRequests).toHaveLength(2)
  } finally {
    transport.close()
  }
})

test("reset while an idle entry still owns HTTP fallback keeps it readable until remove cancels it", async () => {
  let socket: WebSocket | undefined
  await using ws = await createWebSocketServer((next) => {
    socket = next
    next.on("message", () => next.send(JSON.stringify({ type: "response.output_text.delta", delta: "started" })))
  })
  await using http = await createControlledHttpServer()
  const transport = createWebSocketFetch({ url: ws.url })
  try {
    const first = await transport(http.url, streamRequest())
    const firstText = first.text()
    const pending = transport(http.url, streamRequest())
    await waitFor(() => http.requests.length === 1, "the HTTP fallback did not start")
    http.requests[0].response.writeHead(200, { "content-type": "text/event-stream" })
    http.requests[0].response.write("data: partial\n\n")
    const second = await pending
    const reader = second.body!.getReader()
    const decoder = new TextDecoder()
    expect(decoder.decode((await reader.read()).value)).toBe("data: partial\n\n")

    socket!.send(JSON.stringify({ type: "response.completed", response: { id: "resp_done" } }))
    expect(await firstText).toContain("data: [DONE]")

    transport.reset("session-1")
    http.requests[0].response.write("data: after-reset\n\n")
    expect(decoder.decode((await reader.read()).value)).toBe("data: after-reset\n\n")

    transport.remove("session-1")
    expect(await readTextError(reader.read().then(() => "unexpected stream completion"))).toMatchObject({
      name: "AbortError",
    })
    reader.releaseLock()
  } finally {
    transport.close()
  }
})

function streamRequest(headers?: Record<string, string>): RequestInit {
  return {
    method: "POST",
    headers: {
      "session-id": "session-1",
      authorization: "Bearer test",
      ...headers,
    },
    body: JSON.stringify({ stream: true, input: "hi" }),
  }
}

async function readTextError(promise: Promise<string>) {
  try {
    await promise
  } catch (error) {
    if (!(error instanceof Error)) throw new Error(`Expected an Error, received ${String(error)}`, { cause: error })
    return error
  }
  throw new Error("Expected response text to reject")
}

async function createWebSocketServer(
  onConnection: (socket: WebSocket, request: import("node:http").IncomingMessage) => void,
) {
  const http = await createHttpServer()
  const server = new WebSocketServer({ server: http.server })
  server.on("connection", onConnection)
  return websocketServerHandle(server, http)
}

async function createDelayedWebSocketServer(onConnection: (socket: WebSocket) => void) {
  const http = await createHttpServer()
  const pending = new Map<string, (accepted: boolean) => void>()
  const server = new WebSocketServer({
    server: http.server,
    verifyClient(info, callback) {
      pending.set(String(info.req.headers["session-id"]), callback)
    },
  })
  server.on("connection", (socket) => onConnection(socket))
  return {
    ...websocketServerHandle(server, http),
    pending,
    release(sessionID: string) {
      const accept = pending.get(sessionID)
      pending.delete(sessionID)
      accept?.(true)
    },
  }
}

async function createHttpServer() {
  const httpRequests: import("node:http").IncomingMessage[] = []
  const server = createServer((request, response) => {
    httpRequests.push(request)
    response.writeHead(200, { "content-type": "text/plain" })
    response.end("http")
  })
  await listen(server)
  return {
    server,
    httpRequests,
    url: `http://127.0.0.1:${serverPort(server)}/v1/responses`,
    async [Symbol.asyncDispose]() {
      await close(server)
    },
  }
}

async function createControlledHttpServer() {
  const requests: Array<{ response: ServerResponse; closed: boolean }> = []
  const server = createServer((_request, response) => {
    const entry = { response, closed: false }
    requests.push(entry)
    response.once("close", () => (entry.closed = true))
  })
  await listen(server)
  return {
    url: `http://127.0.0.1:${serverPort(server)}/v1/responses`,
    requests,
    async [Symbol.asyncDispose]() {
      for (const entry of requests) entry.response.destroy()
      await close(server)
    },
  }
}

function websocketServerHandle(server: WebSocketServer, http: Awaited<ReturnType<typeof createHttpServer>>) {
  return {
    url: http.url,
    httpRequests: http.httpRequests,
    async [Symbol.asyncDispose]() {
      for (const socket of server.clients) socket.terminate()
      server.close()
      await close(http.server)
    },
  }
}

function listen(server: HttpServer) {
  return new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
}

function serverPort(server: HttpServer) {
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Expected an HTTP server port")
  return address.port
}

function close(server: HttpServer) {
  return new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
}

async function waitFor(predicate: () => boolean, message: string) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > 1_000) throw new Error(message)
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}
