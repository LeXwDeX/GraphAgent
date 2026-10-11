import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http"
import net, { type AddressInfo, type Socket } from "node:net"
import WebSocket, { WebSocketServer } from "ws"
import { APICallError } from "ai"
import { ProviderError } from "../../src/provider/error"
import { OpenAIWebSocket } from "../../src/plugin/openai/ws"
import { OpenAIWebSocketPool, TITLE_HEADER } from "../../src/plugin/openai/ws-pool"

describe("plugin.openai.ws", () => {
  test("derives websocket URLs and sends auth plus protocol headers", async () => {
    let headers: IncomingMessage["headers"] | undefined
    await using server = await createWebSocketServer((_socket, request) => {
      headers = request.headers
    })

    const socket = await OpenAIWebSocket.connectResponsesWebSocket({
      url: server.wsUrl,
      headers: { authorization: "Bearer test", "content-length": "123" },
    })

    expect(OpenAIWebSocket.toWebSocketUrl("http://example.com/v1/responses")).toBe("ws://example.com/v1/responses")
    expect(OpenAIWebSocket.toWebSocketUrl("https://example.com/v1/responses")).toBe("wss://example.com/v1/responses")
    expect(headers?.authorization).toBe("Bearer test")
    expect(headers?.["openai-beta"]).toBe(OpenAIWebSocket.PROTOCOL_HEADER)
    expect(headers?.["content-length"]).toBeUndefined()
    socket.terminate()
  })

  test("enforces websocket connect timeout", async () => {
    await using server = await createHangingTcpServer()

    await expect(
      OpenAIWebSocket.connectResponsesWebSocket({
        url: server.wsUrl,
        headers: {},
        timeout: 20,
      }),
    ).rejects.toThrow("WebSocket connect timed out")
  })

  test("surfaces websocket upgrade rejection messages", async () => {
    await using server = await createRejectingWebSocketServer(() => {})

    await expect(
      OpenAIWebSocket.connectResponsesWebSocket({
        url: server.wsUrl,
        headers: {},
      }),
    ).rejects.toThrow("Expected 101 status code")
  })

  test("enforces websocket send idle timeout", async () => {
    const socket = new (class extends EventEmitter {
      send(_data: string, _callback: (error?: Error) => void) {}
    })() as unknown as WebSocket
    const invalid: string[] = []
    const response = OpenAIWebSocket.streamResponsesWebSocket({
      socket,
      body: { stream: true, input: "hi" },
      idleTimeout: 20,
      onConnectionInvalid: (error) => invalid.push(error.message),
    })

    expect((await readTextError(response.text())).message).toContain("idle timeout sending websocket request")
    expect(invalid).toEqual(["idle timeout sending websocket request"])
  })

  test("streams websocket events as SSE and handles response.done", async () => {
    let requestBody: unknown
    await using server = await createWebSocketServer((socket) => {
      socket.once("message", (data) => {
        requestBody = JSON.parse(data.toString())
        socket.send(JSON.stringify({ type: "response.output_text.delta", delta: "hello" }))
        socket.send(JSON.stringify({ type: "response.done", response: { id: "resp_123" } }))
        socket.close(1000, "done")
      })
    })

    const socket = await OpenAIWebSocket.connectResponsesWebSocket({
      url: server.wsUrl,
      headers: { authorization: "Bearer test", "content-length": "123" },
    })
    const completed: Record<string, unknown>[] = []
    const response = OpenAIWebSocket.streamResponsesWebSocket({
      socket,
      body: { stream: true, background: true, input: "hi" },
      onComplete: (event) => completed.push(event),
    })

    expect(await response.text()).toBe(
      'data: {"type":"response.output_text.delta","delta":"hello"}\n\ndata: {"type":"response.done","response":{"id":"resp_123"}}\n\ndata: [DONE]\n\n',
    )
    expect(requestBody).toEqual({ type: "response.create", input: "hi" })
    expect(completed).toHaveLength(1)
    expect(completed[0]?.type).toBe("response.done")
  })

  test("errors the SSE stream when the server closes before a terminal event", async () => {
    const invalid: Error[] = []
    await using server = await createWebSocketServer((socket) => {
      socket.once("message", () => {
        socket.close(1009, "payload too large")
      })
    })

    const socket = await OpenAIWebSocket.connectResponsesWebSocket({ url: server.wsUrl, headers: {} })
    const response = OpenAIWebSocket.streamResponsesWebSocket({
      socket,
      body: { stream: true, input: "hi" },
      onConnectionInvalid: (error) => invalid.push(error),
    })

    expect((await readTextError(response.text())).message).toContain(
      "WebSocket closed before response.completed (code 1009: message too big: payload too large)",
    )
    expect(invalid[0]).toBeInstanceOf(ProviderError.ResponseStreamError)
    expect(invalid.map((error) => error.message)).toEqual([
      "WebSocket closed before response.completed (code 1009: message too big: payload too large)",
    ])
  })

  test("rejects unexpected binary websocket frames", async () => {
    const invalid: string[] = []
    await using server = await createWebSocketServer((socket) => {
      socket.once("message", () => {
        socket.send(Buffer.from("not json text"))
      })
    })

    const socket = await OpenAIWebSocket.connectResponsesWebSocket({ url: server.wsUrl, headers: {} })
    const response = OpenAIWebSocket.streamResponsesWebSocket({
      socket,
      body: { stream: true, input: "hi" },
      onConnectionInvalid: (error) => invalid.push(error.message),
    })

    expect((await readTextError(response.text())).message).toContain("Unexpected binary WebSocket frame")
    expect(invalid).toEqual(["Unexpected binary WebSocket frame"])
  })
})

describe("plugin.openai.ws-pool", () => {
  test("reuses one healthy websocket for sequential requests", async () => {
    let connections = 0
    let messages = 0
    await using server = await createWebSocketServer((socket) => {
      connections += 1
      socket.on("message", () => {
        messages += 1
        socket.send(JSON.stringify({ type: "response.completed", response: { id: `resp_${messages}` } }))
      })
    })
    const fetch = OpenAIWebSocketPool.createWebSocketFetch({
      url: server.url,
    })

    const first = await fetch(server.url, streamRequest())
    expect(await first.text()).toContain("data: [DONE]")

    const second = await fetch(server.url, streamRequest())
    expect(await second.text()).toContain("data: [DONE]")
    expect(connections).toBe(1)
    expect(messages).toBe(2)
    fetch.close()
  })

  test("rotates a socket that exceeds max connection age", async () => {
    let connections = 0
    await using server = await createWebSocketServer((socket) => {
      connections += 1
      socket.on("message", () => {
        socket.send(JSON.stringify({ type: "response.completed", response: { id: `resp_${connections}` } }))
      })
    })
    const fetch = OpenAIWebSocketPool.createWebSocketFetch({
      url: server.url,
      maxConnectionAge: 0,
    })

    const first = await fetch(server.url, streamRequest())
    expect(await first.text()).toContain("data: [DONE]")

    const second = await fetch(server.url, streamRequest())
    expect(await second.text()).toContain("data: [DONE]")
    expect(connections).toBe(2)
    fetch.close()
  })

  test("falls back to HTTP after websocket setup retries are exhausted", async () => {
    const attempts: string[] = []
    await using server = await createRejectingWebSocketServer(() => attempts.push("websocket"))
    const fetch = OpenAIWebSocketPool.createWebSocketFetch({
      url: server.url,
      connectTimeout: 100,
      streamRetries: 1,
    })

    const first = await fetch(server.url, streamRequest({ [TITLE_HEADER]: "false" }))
    expect(await readTextError(first.text())).toBeInstanceOf(ProviderError.ResponseStreamError)
    const second = await fetch(server.url, streamRequest({ [TITLE_HEADER]: "false" }))
    const third = await fetch(server.url, streamRequest({ [TITLE_HEADER]: "false" }))

    expect(await second.text()).toBe("http")
    expect(await third.text()).toBe("http")
    expect(attempts).toEqual(["websocket", "websocket"])
    expect(server.httpRequests).toHaveLength(2)
    expect(server.httpRequests[0]?.headers[TITLE_HEADER]).toBeUndefined()
    expect(server.httpRequests[1]?.headers[TITLE_HEADER]).toBeUndefined()
    fetch.close()
  })

  test("keeps HTTP fallback active after its idle timeout", async () => {
    let websocketAttempts = 0
    await using server = await createRejectingWebSocketServer(() => websocketAttempts++)
    const fetch = OpenAIWebSocketPool.createWebSocketFetch({
      url: server.url,
      connectTimeout: 100,
      idleTimeout: 20,
      streamRetries: 0,
    })

    const first = await fetch(server.url, streamRequest())
    expect(await first.text()).toBe("http")
    await new Promise((resolve) => setTimeout(resolve, 50))
    const second = await fetch(server.url, streamRequest())

    expect(await second.text()).toBe("http")
    expect(websocketAttempts).toBe(1)
    expect(server.httpRequests).toHaveLength(2)
    fetch.close()
  })

  test("falls back immediately to HTTP when a websocket request is too large", async () => {
    let connections = 0
    await using server = await createWebSocketServer((socket) => {
      connections += 1
      socket.once("message", () => socket.close(1009, "payload too large"))
    })
    const fetch = OpenAIWebSocketPool.createWebSocketFetch({
      url: server.url,
    })

    const first = await fetch(server.url, streamRequest())
    const second = await fetch(server.url, streamRequest())

    expect(await first.text()).toBe("http")
    expect(await second.text()).toBe("http")
    expect(connections).toBe(1)
    expect(server.httpRequests).toHaveLength(2)
    fetch.close()
  })

  test("removes HTTP fallback when its session is deleted", async () => {
    let websocketAttempts = 0
    await using server = await createRejectingWebSocketServer(() => websocketAttempts++)
    const fetch = OpenAIWebSocketPool.createWebSocketFetch({
      url: server.url,
      connectTimeout: 100,
      streamRetries: 0,
    })

    const first = await fetch(server.url, streamRequest())
    expect(await first.text()).toBe("http")
    fetch.remove("session-1")
    const second = await fetch(server.url, streamRequest())

    expect(await second.text()).toBe("http")
    expect(websocketAttempts).toBe(2)
    expect(server.httpRequests).toHaveLength(2)
    fetch.close()
  })

  test("terminates active websocket connections when their session is deleted", async () => {
    let connections = 0
    await using server = await createWebSocketServer((socket) => {
      connections += 1
      socket.once("message", () => {
        if (connections === 1) {
          socket.send(JSON.stringify({ type: "response.output_text.delta", delta: "started" }))
          return
        }
        socket.send(JSON.stringify({ type: "response.completed", response: { id: "resp_after_remove" } }))
      })
    })
    const fetch = OpenAIWebSocketPool.createWebSocketFetch({
      url: server.url,
    })

    const first = await fetch(server.url, streamRequest())
    const firstText = first.text()
    fetch.remove("session-1")
    expect(await readTextError(firstText)).toMatchObject({ name: "AbortError", message: "WebSocket session removed" })

    const second = await fetch(server.url, streamRequest())

    expect(await second.text()).toContain("data: [DONE]")
    expect(connections).toBe(2)
    fetch.close()
  })

  test("prunes idle websocket connections after completed responses", async () => {
    let connections = 0
    let closed = 0
    await using server = await createWebSocketServer((socket) => {
      connections += 1
      socket.once("close", () => closed++)
      socket.once("message", () => {
        socket.send(JSON.stringify({ type: "response.completed", response: { id: `resp_${connections}` } }))
      })
    })
    const fetch = OpenAIWebSocketPool.createWebSocketFetch({
      url: server.url,
      idleTimeout: 20,
    })

    const first = await fetch(server.url, streamRequest())
    expect(await first.text()).toContain("data: [DONE]")
    await waitFor(() => closed === 1, "idle websocket was not pruned")

    const second = await fetch(server.url, streamRequest())

    expect(await second.text()).toContain("data: [DONE]")
    expect(connections).toBe(2)
    fetch.close()
  })

  test("invalidates but does not reuse a socket after terminal failure frames", async () => {
    let connections = 0
    await using server = await createWebSocketServer((socket) => {
      connections += 1
      socket.once("message", () => {
        socket.send(JSON.stringify({ type: connections === 1 ? "response.failed" : "response.completed" }))
      })
    })
    const fetch = OpenAIWebSocketPool.createWebSocketFetch({
      url: server.url,
    })

    const first = await fetch(server.url, streamRequest())
    expect(await first.text()).toContain('data: {"type":"response.failed"}')

    const second = await fetch(server.url, streamRequest())
    expect(await second.text()).toContain('data: {"type":"response.completed"}')
    expect(connections).toBe(2)
    expect(server.httpRequests).toHaveLength(0)
    fetch.close()
  })

  test("returns initial websocket error frames as HTTP-style API errors", async () => {
    const error = {
      type: "invalid_request_error",
      message: "The model is not supported when using Codex with a ChatGPT account.",
    }
    const event = {
      type: "error",
      status: 400,
      error,
      headers: {
        "x-codex-primary-window-minutes": 15,
        ignored: { nested: true },
      },
    }
    await using server = await createWebSocketServer((socket) => {
      socket.once("message", () => {
        socket.send(JSON.stringify(event))
      })
    })
    const fetch = OpenAIWebSocketPool.createWebSocketFetch({
      url: server.url,
    })

    const response = await fetch(server.url, streamRequest())

    expect(response.status).toBe(400)
    expect(response.headers.get("content-type")).toContain("application/json")
    expect(response.headers.get("x-codex-primary-window-minutes")).toBe("15")
    expect(response.headers.get("ignored")).toBeNull()
    expect(await response.json()).toEqual(event)
    fetch.close()
  })

  test("fails mid-stream wrapped websocket errors as HTTP-style API errors", async () => {
    const event = {
      type: "error",
      status_code: 429,
      error: {
        type: "usage_limit_reached",
        message: "The usage limit has been reached",
      },
      headers: {
        "x-codex-primary-used-percent": "100.0",
      },
    }
    await using server = await createWebSocketServer((socket) => {
      socket.once("message", () => {
        socket.send(JSON.stringify({ type: "response.output_text.delta", delta: "started" }))
        socket.send(JSON.stringify(event))
      })
    })
    const fetch = OpenAIWebSocketPool.createWebSocketFetch({
      url: server.url,
    })

    const response = await fetch(server.url, streamRequest())
    const error = await readTextError(response.text())

    expect(APICallError.isInstance(error)).toBe(true)
    if (!APICallError.isInstance(error)) throw new Error("Expected APICallError")
    expect(error.statusCode).toBe(429)
    expect(error.responseHeaders).toEqual({ "x-codex-primary-used-percent": "100.0" })
    expect(error.responseBody).toBe(JSON.stringify(event))
    fetch.close()
  })

  test("retries websocket connection limit errors on the next stream attempt", async () => {
    let connections = 0
    let messages = 0
    await using server = await createWebSocketServer((socket) => {
      connections += 1
      socket.once("message", () => {
        messages += 1
        if (connections === 1) {
          socket.send(
            JSON.stringify({
              type: "error",
              status: 400,
              error: {
                type: "invalid_request_error",
                code: "websocket_connection_limit_reached",
                message: "Responses websocket connection limit reached",
              },
            }),
          )
          return
        }
        socket.send(JSON.stringify({ type: "response.completed", response: { id: "resp_retry" } }))
      })
    })
    const fetch = OpenAIWebSocketPool.createWebSocketFetch({
      url: server.url,
    })

    const first = await fetch(server.url, streamRequest())
    expect((await readTextError(first.text())).message).toContain("Responses websocket connection limit reached")
    const second = await fetch(server.url, streamRequest())
    const text = await second.text()

    expect(text).not.toContain("websocket_connection_limit_reached")
    expect(text).toContain('data: {"type":"response.completed","response":{"id":"resp_retry"}}')
    expect(text).toContain("data: [DONE]")
    expect(connections).toBe(2)
    expect(messages).toBe(2)
    expect(server.httpRequests).toHaveLength(0)
    fetch.close()
  })

  test("falls back to HTTP after websocket connection limit retries are exhausted", async () => {
    let connections = 0
    await using server = await createWebSocketServer((socket) => {
      connections += 1
      socket.once("message", () => {
        socket.send(
          JSON.stringify({
            type: "error",
            status: 400,
            error: {
              type: "invalid_request_error",
              code: "websocket_connection_limit_reached",
              message: "Responses websocket connection limit reached",
            },
          }),
        )
      })
    })
    const fetch = OpenAIWebSocketPool.createWebSocketFetch({
      url: server.url,
      streamRetries: 2,
    })

    const first = await fetch(server.url, streamRequest())
    expect((await readTextError(first.text())).message).toContain("Responses websocket connection limit reached")
    const second = await fetch(server.url, streamRequest())
    expect((await readTextError(second.text())).message).toContain("Responses websocket connection limit reached")
    const third = await fetch(server.url, streamRequest())
    const fourth = await fetch(server.url, streamRequest())

    expect(await third.text()).toBe("http")
    expect(await fourth.text()).toBe("http")
    expect(connections).toBe(3)
    expect(server.httpRequests).toHaveLength(2)
    fetch.close()
  })

  test("shares the websocket retry budget across stream and connection limit failures", async () => {
    let connections = 0
    await using server = await createWebSocketServer((socket) => {
      connections += 1
      socket.once("message", () => {
        if (connections === 1) {
          socket.send(JSON.stringify({ type: "response.output_text.delta", delta: "started" }))
          socket.terminate()
          return
        }
        socket.send(
          JSON.stringify({
            type: "error",
            error: {
              code: "websocket_connection_limit_reached",
              message: "Responses websocket connection limit reached",
            },
          }),
        )
      })
    })
    const fetch = OpenAIWebSocketPool.createWebSocketFetch({
      url: server.url,
      streamRetries: 1,
    })

    const first = await fetch(server.url, streamRequest())
    expect((await readTextError(first.text())).message).toContain("WebSocket closed before response.completed")
    const second = await fetch(server.url, streamRequest())

    expect(await second.text()).toBe("http")
    expect(connections).toBe(2)
    expect(server.httpRequests).toHaveLength(1)
    fetch.close()
  })

  test("retries websocket idle failures before first event then falls back to HTTP", async () => {
    let connections = 0
    await using server = await createWebSocketServer((socket) => {
      connections += 1
      socket.once("message", () => {})
    })
    const fetch = OpenAIWebSocketPool.createWebSocketFetch({
      url: server.url,
      idleTimeout: 20,
      streamRetries: 1,
    })

    const first = await fetch(server.url, streamRequest())
    expect((await readTextError(first.text())).message).toContain("idle timeout waiting for websocket")
    const second = await fetch(server.url, streamRequest())
    const third = await fetch(server.url, streamRequest())

    expect(await second.text()).toBe("http")
    expect(await third.text()).toBe("http")
    expect(connections).toBe(2)
    expect(server.httpRequests).toHaveLength(2)
    fetch.close()
  })

  test("keeps websocket retry state until the failed stream becomes idle", async () => {
    let connections = 0
    await using server = await createWebSocketServer((socket) => {
      connections += 1
      socket.once("message", () => {})
    })
    const fetch = OpenAIWebSocketPool.createWebSocketFetch({
      url: server.url,
      idleTimeout: 500,
      streamRetries: 1,
    })

    await new Promise((resolve) => setTimeout(resolve, 250))
    const first = await fetch(server.url, streamRequest())
    expect((await readTextError(first.text())).message).toContain("idle timeout waiting for websocket")
    await new Promise((resolve) => setTimeout(resolve, 300))

    const second = await fetch(server.url, streamRequest())

    expect(await second.text()).toBe("http")
    expect(connections).toBe(2)
    expect(server.httpRequests).toHaveLength(1)
    fetch.close()
  })

  test("retries failed websocket streams before using HTTP fallback", async () => {
    const attempts: Array<(socket: WebSocket) => void> = []
    await using server = await createWebSocketServer((socket) => {
      socket.once("message", () => {
        socket.send(JSON.stringify({ type: "response.output_text.delta", delta: "started" }))
        attempts.shift()?.(socket)
      })
    })
    const fetch = OpenAIWebSocketPool.createWebSocketFetch({
      url: server.url,
      streamRetries: 1,
    })

    const firstAttempt = new Promise<WebSocket>((resolve) => attempts.push(resolve))
    const first = await fetch(server.url, streamRequest())
    const firstSocket = await firstAttempt
    firstSocket.terminate()
    expect((await readTextError(first.text())).message).toContain("WebSocket closed before response.completed")
    const secondAttempt = new Promise<WebSocket>((resolve) => attempts.push(resolve))
    const second = await fetch(server.url, streamRequest())
    const secondSocket = await secondAttempt
    secondSocket.terminate()
    expect((await readTextError(second.text())).message).toContain("WebSocket closed before response.completed")
    const third = await fetch(server.url, streamRequest())

    expect(await third.text()).toBe("http")
    expect(server.httpRequests).toHaveLength(1)
    fetch.close()
  })

  test("resets websocket stream failures after a completed response", async () => {
    let connections = 0
    let requests = 0
    await using server = await createWebSocketServer((socket) => {
      connections += 1
      socket.on("message", () => {
        requests += 1
        if (requests === 1 || requests === 3) {
          socket.send(JSON.stringify({ type: "response.output_text.delta", delta: "started" }))
          socket.terminate()
          return
        }
        socket.send(JSON.stringify({ type: "response.completed", response: { id: `resp_${requests}` } }))
      })
    })
    const fetch = OpenAIWebSocketPool.createWebSocketFetch({
      url: server.url,
      streamRetries: 1,
    })

    const first = await fetch(server.url, streamRequest())
    expect((await readTextError(first.text())).message).toContain("WebSocket closed before response.completed")
    const second = await fetch(server.url, streamRequest())
    expect(await second.text()).toContain("data: [DONE]")
    const third = await fetch(server.url, streamRequest())
    expect((await readTextError(third.text())).message).toContain("WebSocket closed before response.completed")
    const fourth = await fetch(server.url, streamRequest())

    expect(await fourth.text()).toContain("data: [DONE]")
    expect(connections).toBe(3)
    expect(requests).toBe(4)
    expect(server.httpRequests).toHaveLength(0)
    fetch.close()
  })

  test("falls back to HTTP for missing session and title requests", async () => {
    await using server = await createWebSocketServer(() => {})
    const fetch = OpenAIWebSocketPool.createWebSocketFetch()

    const missingSession = await fetch(server.url, {
      method: "POST",
      headers: { [TITLE_HEADER]: "false" },
      body: JSON.stringify({ stream: true }),
    })
    const title = await fetch(server.url, streamRequest({ [TITLE_HEADER]: "true" }))

    expect(await missingSession.text()).toBe("http")
    expect(await title.text()).toBe("http")
    expect(server.httpRequests).toHaveLength(2)
    expect(server.httpRequests[0]?.headers[TITLE_HEADER]).toBeUndefined()
    expect(server.httpRequests[1]?.headers[TITLE_HEADER]).toBeUndefined()
    fetch.close()
  })

  test("falls back to HTTP while a websocket lane is busy", async () => {
    let connections = 0
    await using server = await createWebSocketServer((socket) => {
      connections += 1
      socket.once("message", () => {
        socket.send(JSON.stringify({ type: "response.output_text.delta", delta: "started" }))
      })
    })
    const abort = new AbortController()
    const fetch = OpenAIWebSocketPool.createWebSocketFetch({
      url: server.url,
    })

    const first = await fetch(server.url, streamRequest({}, abort.signal))
    const firstText = first.text()
    await waitFor(() => connections === 1, "websocket did not connect")
    const second = await fetch(server.url, streamRequest())

    expect(await second.text()).toBe("http")
    expect(server.httpRequests).toHaveLength(1)
    expect(connections).toBe(1)
    abort.abort(new Error("stop"))
    expect((await readTextError(firstText)).message).toContain("stop")
    fetch.close()
  })

  test("reserves a websocket lane while its socket is connecting", async () => {
    await using server = await createHangingTcpServer()
    await using fallback = await createHttpServer()
    const fetch = OpenAIWebSocketPool.createWebSocketFetch({
      url: server.url,
      connectTimeout: 20,
      streamRetries: 0,
    })

    const first = fetch(fallback.url, streamRequest())
    await waitFor(() => server.connections() === 1, "first websocket did not begin connecting")
    const second = fetch(fallback.url, streamRequest())

    expect(await (await second).text()).toBe("http")
    expect(await (await first).text()).toBe("http")
    expect(server.connections()).toBe(1)
    expect(fallback.httpRequests).toHaveLength(2)
    fetch.close()
  })

  for (const cleanup of ["close", "remove"] as const) {
    test(`cancels a pending websocket handshake on ${cleanup} without HTTP replay`, async () => {
      await using server = await createDelayedWebSocketServer()
      const fetch = OpenAIWebSocketPool.createWebSocketFetch({ url: server.url, streamRetries: 0 })
      try {
        const first = readTextError(fetch(server.url, streamRequest()).then((response) => response.text()))
        await waitFor(() => server.pending.has("session-1"), "websocket handshake did not start")

        if (cleanup === "close") fetch.close()
        else fetch.remove("session-1")

        expect(await first).toMatchObject({ name: "AbortError" })
        await waitFor(() => server.sockets.size === 0, "pending socket was not closed")
        server.release("session-1")
        expect(server.messages).toEqual([])
        expect(server.httpRequests).toHaveLength(0)
        if (cleanup === "close") {
          expect(
            await readTextError(fetch(server.url, streamRequest()).then((response) => response.text())),
          ).toMatchObject({
            name: "AbortError",
            message: "WebSocket pool closed",
          })
          expect(server.pending.size).toBe(0)
          expect(server.httpRequests).toHaveLength(0)
        }
      } finally {
        fetch.close()
      }
    })
  }

  test("keeps another session and a fresh entry usable after removing a pending handshake", async () => {
    await using server = await createDelayedWebSocketServer()
    const fetch = OpenAIWebSocketPool.createWebSocketFetch({ url: server.url, streamRetries: 0 })
    try {
      const other = fetch(server.url, streamRequest({ "session-id": "session-2" }))
      await waitFor(() => server.pending.has("session-2"), "other session did not start connecting")
      server.release("session-2")
      expect(await (await other).text()).toContain("data: [DONE]")

      const first = readTextError(fetch(server.url, streamRequest()).then((response) => response.text()))
      await waitFor(() => server.pending.has("session-1"), "removed session did not start connecting")
      fetch.remove("session-1")
      server.release("session-1")
      const fresh = fetch(server.url, streamRequest())
      expect(await first).toMatchObject({ name: "AbortError" })
      await waitFor(() => server.pending.has("session-1"), "fresh session entry did not start connecting")
      await waitFor(() => server.sockets.size === 2, "removed session retained its pending socket")

      const reused = await fetch(server.url, streamRequest({ "session-id": "session-2" }))
      expect(await reused.text()).toContain("data: [DONE]")
      server.release("session-1")
      expect(await (await fresh).text()).toContain("data: [DONE]")
      expect(server.messages).toEqual(["session-2", "session-2", "session-1"])
      expect(server.httpRequests).toHaveLength(0)
    } finally {
      fetch.close()
    }
    await waitFor(() => server.sockets.size === 0, "remaining sockets were not closed")
  })

  for (const firstEvent of [false, true]) {
    test(`pool close cancels active websocket work ${firstEvent ? "after" : "before"} its first event`, async () => {
      let requests = 0
      let closed = 0
      await using server = await createWebSocketServer((socket) => {
        socket.once("close", () => closed++)
        socket.once("message", () => {
          requests++
          if (firstEvent) socket.send(JSON.stringify({ type: "response.output_text.delta", delta: "started" }))
        })
      })
      const fetch = OpenAIWebSocketPool.createWebSocketFetch({ url: server.url, streamRetries: 0 })
      try {
        const response = fetch(server.url, streamRequest())
        const failure = readTextError(response.then((result) => result.text()))
        await waitFor(() => requests === 1, "websocket request was not sent")
        if (firstEvent) await response
        fetch.close()
        expect(await failure).toMatchObject({ name: "AbortError", message: "WebSocket pool closed" })
        await waitFor(() => closed === 1, "active websocket was not closed")
        expect(server.httpRequests).toHaveLength(0)
      } finally {
        fetch.close()
      }
    })
  }

  for (const mode of ["sticky", "setup failure", "stream failure", "busy"] as const) {
    for (const phase of ["headers", "body"] as const) {
      for (const cleanup of ["close", "remove"] as const) {
        test(`${cleanup} cancels ${mode} HTTP fallback while waiting for ${phase}`, async () => {
          await using http = await createControlledHttpServer()
          await using ws =
            mode === "busy" || mode === "stream failure"
              ? await createWebSocketServer((socket) => {
                  socket.once("message", () => {
                    if (mode === "busy")
                      socket.send(JSON.stringify({ type: "response.output_text.delta", delta: "ws" }))
                    else socket.close(1001, "failed")
                  })
                })
              : await createRejectingWebSocketServer(() => {})
          const transport = OpenAIWebSocketPool.createWebSocketFetch({ url: ws.url, streamRetries: 0 })
          try {
            let wsFailure: Promise<Error> | undefined
            if (mode === "sticky") {
              const prime = transport(http.url, streamRequest())
              await waitFor(() => http.requests.length === 1, "priming HTTP fallback did not start")
              http.requests[0].response.end("prime")
              expect(await (await prime).text()).toBe("prime")
            } else if (mode === "busy") {
              const response = await transport(http.url, streamRequest())
              wsFailure = readTextError(response.text())
            }
            const previous = http.requests.length
            const pending = transport(http.url, streamRequest())
            const failure = readTextError(pending.then((response) => response.text()))
            await waitFor(() => http.requests.length === previous + 1, "HTTP fallback did not start")
            const request = http.requests[previous]
            if (phase === "body") {
              request.response.writeHead(200, { "content-type": "text/event-stream" })
              request.response.write("data: partial\n\n")
              await pending
            }

            if (cleanup === "close") transport.close()
            else transport.remove("session-1")
            expect(await failure).toMatchObject({ name: "AbortError" })
            if (wsFailure) expect(await wsFailure).toMatchObject({ name: "AbortError" })
            await waitFor(() => request.closed, "HTTP connection remained open after cleanup")
            expect(http.requests).toHaveLength(previous + 1)
            expect(ws.httpRequests).toHaveLength(0)
          } finally {
            transport.close()
          }
        })
      }
    }
  }

  test("caller abort cancels one busy HTTP fallback without stopping sibling HTTP or websocket work", async () => {
    await using http = await createControlledHttpServer()
    await using ws = await createWebSocketServer((socket) => {
      socket.once("message", () => socket.send(JSON.stringify({ type: "response.output_text.delta", delta: "ws" })))
    })
    const transport = OpenAIWebSocketPool.createWebSocketFetch({ url: ws.url })
    try {
      const websocket = await transport(http.url, streamRequest())
      const wsFailure = readTextError(websocket.text())
      const caller = new AbortController()
      const canceled = readTextError(
        transport(http.url, streamRequest({}, caller.signal)).then((response) => response.text()),
      )
      const sibling = transport(http.url, streamRequest())
      await waitFor(() => http.requests.length === 2, "concurrent HTTP fallbacks did not start")
      caller.abort(new DOMException("caller stopped", "AbortError"))
      expect(await canceled).toMatchObject({ name: "AbortError", message: "caller stopped" })
      await waitFor(() => http.requests[0].closed, "caller-aborted HTTP was not closed")
      expect(http.requests[1].closed).toBe(false)
      http.requests[1].response.end("sibling")
      expect(await (await sibling).text()).toBe("sibling")
      expect(ws.httpRequests).toHaveLength(0)
      transport.remove("session-1")
      expect(await wsFailure).toMatchObject({ name: "AbortError", message: "WebSocket session removed" })
    } finally {
      transport.close()
    }
  })

  test("keeps HTTP fallback owned across later websocket calls and isolates removed session entries", async () => {
    await using http = await createControlledHttpServer()
    const sockets: WebSocket[] = []
    await using ws = await createWebSocketServer((socket, request) => {
      sockets.push(socket)
      socket.on("message", () => {
        const event =
          request.headers["session-id"] === "session-2" || sockets.length > 1
            ? { type: "response.completed", response: { id: "fresh" } }
            : { type: "response.output_text.delta", delta: "ws" }
        socket.send(JSON.stringify(event))
      })
    })
    const transport = OpenAIWebSocketPool.createWebSocketFetch({ url: ws.url })
    try {
      const first = await transport(http.url, streamRequest())
      const firstText = first.text()
      const pendingHttp = transport(http.url, streamRequest())
      const httpFailure = readTextError(pendingHttp.then((response) => response.text()))
      await waitFor(() => http.requests.length === 1, "busy HTTP fallback did not start")
      http.requests[0].response.writeHead(200, { "content-type": "text/event-stream" })
      http.requests[0].response.write("data: partial\n\n")
      await pendingHttp
      sockets[0].send(JSON.stringify({ type: "response.completed", response: { id: "first" } }))
      expect(await firstText).toContain("data: [DONE]")
      const nextWs = await transport(http.url, streamRequest())
      const wsFailure = readTextError(nextWs.text())
      const other = await transport(http.url, streamRequest({ "session-id": "session-2" }))
      expect(await other.text()).toContain("data: [DONE]")

      transport.remove("session-1")
      const fresh = transport(http.url, streamRequest())
      expect(await httpFailure).toMatchObject({ name: "AbortError" })
      expect(await wsFailure).toMatchObject({ name: "AbortError" })
      expect(await (await fresh).text()).toContain("data: [DONE]")
      const reused = await transport(http.url, streamRequest({ "session-id": "session-2" }))
      expect(await reused.text()).toContain("data: [DONE]")
      await waitFor(() => http.requests[0].closed, "old HTTP stream was not closed")
      expect(http.requests).toHaveLength(1)
      expect(sockets).toHaveLength(3)
    } finally {
      transport.close()
    }
  })

  for (const completion of ["finish", "fail", "cancel", "caller abort"] as const) {
    test(`idle prune waits for active HTTP fallback and resumes after body ${completion}`, async () => {
      await using http = await createControlledHttpServer()
      let closed = 0
      let socket: WebSocket | undefined
      await using ws = await createWebSocketServer((next) => {
        socket = next
        next.once("close", () => closed++)
        next.once("message", () => next.send(JSON.stringify({ type: "response.output_text.delta", delta: "ws" })))
      })
      const idleTimeout = 200
      const transport = OpenAIWebSocketPool.createWebSocketFetch({ url: ws.url, idleTimeout })
      try {
        const caller = new AbortController()
        const websocket = await transport(http.url, streamRequest())
        const text = websocket.text()
        const pending = transport(http.url, streamRequest({}, caller.signal))
        await waitFor(() => http.requests.length === 1, "busy HTTP fallback did not start")
        http.requests[0].response.writeHead(202, "Accepted", {
          "content-type": "text/event-stream",
          "x-regression": "preserved",
        })
        http.requests[0].response.write("data: partial\n\n")
        const response = await pending
        expect(response.status).toBe(202)
        expect(response.statusText).toBe("Accepted")
        expect(response.headers.get("content-type")).toBe("text/event-stream")
        expect(response.headers.get("x-regression")).toBe("preserved")
        socket!.send(JSON.stringify({ type: "response.completed", response: { id: "done" } }))
        expect(await text).toContain("data: [DONE]")
        await Bun.sleep(idleTimeout * 3)
        expect(closed).toBe(0)
        if (completion === "finish") {
          const reader = response.body!.getReader()
          const decoder = new TextDecoder()
          expect(decoder.decode((await reader.read()).value)).toBe("data: partial\n\n")
          http.requests[0].response.write("data: second\n\n")
          expect(decoder.decode((await reader.read()).value)).toBe("data: second\n\n")
          http.requests[0].response.end("data: [DONE]\n\n")
          expect(decoder.decode((await reader.read()).value)).toBe("data: [DONE]\n\n")
          expect((await reader.read()).done).toBe(true)
          reader.releaseLock()
        } else if (completion === "fail") {
          const failure = readTextError(response.text())
          http.requests[0].response.destroy()
          expect(await failure).toBeInstanceOf(Error)
        } else if (completion === "cancel") {
          await response.body!.cancel("finished reading")
        } else {
          caller.abort(new DOMException("caller stopped", "AbortError"))
          expect(await readTextError(response.text())).toMatchObject({ name: "AbortError" })
        }
        await waitFor(() => closed === 1, "completed or canceled HTTP fallback prevented idle pruning")
        expect(http.requests).toHaveLength(1)
        expect(ws.httpRequests).toHaveLength(0)
      } finally {
        transport.close()
      }
    })
  }

  test("a rejected HTTP fallback releases idle ownership without retrying the request", async () => {
    await using http = await createControlledHttpServer()
    let closed = 0
    let socket: WebSocket | undefined
    await using ws = await createWebSocketServer((next) => {
      socket = next
      next.once("close", () => closed++)
      next.once("message", () => next.send(JSON.stringify({ type: "response.output_text.delta", delta: "ws" })))
    })
    const idleTimeout = 200
    const transport = OpenAIWebSocketPool.createWebSocketFetch({ url: ws.url, idleTimeout })
    try {
      const websocket = await transport(http.url, streamRequest())
      const text = websocket.text()
      const caller = new AbortController()
      const failure = readTextError(
        transport(http.url, streamRequest({}, caller.signal)).then((response) => response.text()),
      )
      await waitFor(() => http.requests.length === 1, "busy HTTP fallback did not start")
      socket!.send(JSON.stringify({ type: "response.completed", response: { id: "done" } }))
      expect(await text).toContain("data: [DONE]")
      await Bun.sleep(idleTimeout * 3)
      expect(closed).toBe(0)
      caller.abort(new DOMException("caller stopped", "AbortError"))
      expect(await failure).toMatchObject({ name: "AbortError" })
      await waitFor(() => closed === 1, "rejected HTTP fallback prevented idle pruning")
      expect(http.requests).toHaveLength(1)
      expect(ws.httpRequests).toHaveLength(0)
    } finally {
      transport.close()
    }
  })

  test("retries unexpected closes before first event then falls back to HTTP", async () => {
    let connections = 0
    await using server = await createWebSocketServer((socket) => {
      connections += 1
      socket.once("message", () => {
        socket.close(1001, "server shutdown")
      })
    })
    const fetch = OpenAIWebSocketPool.createWebSocketFetch({
      url: server.url,
      streamRetries: 1,
    })

    const first = await fetch(server.url, streamRequest())
    expect((await readTextError(first.text())).message).toContain("WebSocket closed before response.completed")
    const second = await fetch(server.url, streamRequest())
    const third = await fetch(server.url, streamRequest())

    expect(await second.text()).toBe("http")
    expect(await third.text()).toBe("http")
    expect(connections).toBe(2)
    expect(server.httpRequests).toHaveLength(2)
    fetch.close()
  })

  test("does not keep HTTP fallback active after aborting a websocket response", async () => {
    let connections = 0
    await using server = await createWebSocketServer((socket) => {
      connections += 1
      socket.once("message", () => {
        if (connections === 1) {
          socket.send(JSON.stringify({ type: "response.output_text.delta", delta: "started" }))
          return
        }
        socket.send(JSON.stringify({ type: "response.completed", response: { id: "resp_456" } }))
      })
    })
    const abort = new AbortController()
    const fetch = OpenAIWebSocketPool.createWebSocketFetch({
      url: server.url,
    })

    const first = await fetch(server.url, streamRequest({}, abort.signal))
    const firstText = first.text()
    await waitFor(() => connections === 1, "first websocket did not connect")
    abort.abort(new Error("stop"))
    expect((await readTextError(firstText)).message).toContain("stop")

    const second = await fetch(server.url, streamRequest())

    expect(await second.text()).toContain("data: [DONE]")
    expect(connections).toBe(2)
    expect(server.httpRequests).toHaveLength(0)
    fetch.close()
  })

  test("releases the websocket lane when the response body is cancelled", async () => {
    let connections = 0
    await using server = await createWebSocketServer((socket) => {
      connections += 1
      socket.once("message", () => {
        if (connections === 1) {
          socket.send(JSON.stringify({ type: "response.output_text.delta", delta: "started" }))
          return
        }
        socket.send(JSON.stringify({ type: "response.completed", response: { id: "resp_after_cancel" } }))
      })
    })
    const fetch = OpenAIWebSocketPool.createWebSocketFetch({
      url: server.url,
    })

    const first = await fetch(server.url, streamRequest())
    await waitFor(() => connections === 1, "first websocket did not connect")
    await first.body!.cancel("stop")

    const second = await fetch(server.url, streamRequest())

    expect(await second.text()).toContain("data: [DONE]")
    expect(connections).toBe(2)
    expect(server.httpRequests).toHaveLength(0)
    fetch.close()
  })
})

function streamRequest(headers?: Record<string, string>, signal?: AbortSignal): RequestInit {
  return {
    method: "POST",
    headers: {
      "session-id": "session-1",
      authorization: "Bearer test",
      ...headers,
    },
    body: JSON.stringify({ stream: true, input: "hi" }),
    signal,
  }
}

async function readTextError(promise: Promise<string>) {
  // Bun 1.3.14 hangs on expect(response.text()).rejects for streams errored from ws callbacks.
  return promise.then(
    () => {
      throw new Error("Expected response text to reject")
    },
    (error) => {
      expect(error).toBeInstanceOf(Error)
      return error as Error
    },
  )
}

async function createWebSocketServer(onConnection: (socket: WebSocket, request: IncomingMessage) => void) {
  const http = await createHttpServer()
  const server = new WebSocketServer({ server: http.server })
  server.on("connection", onConnection)
  return websocketServerHandle(server, http)
}

async function createHangingTcpServer() {
  const sockets = new Set<Socket>()
  let connections = 0
  const server = net.createServer((socket) => {
    connections += 1
    sockets.add(socket)
    socket.on("close", () => sockets.delete(socket))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${address.port}/v1/responses`,
    wsUrl: `ws://127.0.0.1:${address.port}/v1/responses`,
    connections: () => connections,
    async [Symbol.asyncDispose]() {
      for (const socket of sockets) socket.destroy()
      server.close()
    },
  }
}

async function createRejectingWebSocketServer(onAttempt: () => void) {
  const http = await createHttpServer()
  const server = new WebSocketServer({
    server: http.server,
    verifyClient(_info, callback) {
      onAttempt()
      callback(false, 401, "denied")
    },
  })
  return websocketServerHandle(server, http)
}

async function createDelayedWebSocketServer() {
  const http = await createHttpServer()
  const sockets = new Set<Socket>()
  const pending = new Map<string, (accepted: boolean) => void>()
  const messages: string[] = []
  http.server.on("connection", (socket) => {
    sockets.add(socket)
    socket.once("close", () => sockets.delete(socket))
  })
  const server = new WebSocketServer({
    server: http.server,
    verifyClient(info, callback) {
      pending.set(String(info.req.headers["session-id"]), callback)
    },
  })
  server.on("connection", (socket, request) => {
    socket.on("message", () => {
      messages.push(String(request.headers["session-id"]))
      socket.send(JSON.stringify({ type: "response.completed", response: { id: "resp_test" } }))
    })
  })
  return {
    ...websocketServerHandle(server, http),
    sockets,
    pending,
    messages,
    release(sessionID: string) {
      const accept = pending.get(sessionID)
      pending.delete(sessionID)
      accept?.(true)
    },
    async [Symbol.asyncDispose]() {
      for (const socket of sockets) socket.destroy()
      for (const socket of server.clients) socket.terminate()
      server.close()
      await closeHttpServer(http.server)
    },
  }
}

async function createHttpServer() {
  const httpRequests: IncomingMessage[] = []
  const server = createServer((request, response) => {
    httpRequests.push(request)
    response.writeHead(200, { "content-type": "text/plain" })
    response.end("http")
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address() as AddressInfo
  return {
    server,
    httpRequests,
    url: `http://127.0.0.1:${address.port}/v1/responses`,
    async [Symbol.asyncDispose]() {
      await closeHttpServer(server)
    },
  }
}

async function createControlledHttpServer() {
  const requests: Array<{ response: ServerResponse; closed: boolean }> = []
  const sockets = new Set<Socket>()
  const server = createServer((_request, response) => {
    const entry = { response, closed: false }
    requests.push(entry)
    response.once("close", () => (entry.closed = true))
  })
  server.on("connection", (socket) => {
    sockets.add(socket)
    socket.once("close", () => sockets.delete(socket))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Expected HTTP server port")
  return {
    url: `http://127.0.0.1:${address.port}/v1/responses`,
    requests,
    async [Symbol.asyncDispose]() {
      for (const socket of sockets) socket.destroy()
      await closeHttpServer(server)
    },
  }
}

function websocketServerHandle(server: WebSocketServer, http: Awaited<ReturnType<typeof createHttpServer>>) {
  return {
    url: http.url,
    wsUrl: http.url.replace(/^http/, "ws"),
    httpRequests: http.httpRequests,
    async [Symbol.asyncDispose]() {
      for (const socket of server.clients) socket.terminate()
      server.close()
      http.server.close()
    },
  }
}

function closeHttpServer(server: HttpServer) {
  return new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
}

async function waitFor(predicate: () => boolean, message: string) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > 1_000) throw new Error(message)
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}
