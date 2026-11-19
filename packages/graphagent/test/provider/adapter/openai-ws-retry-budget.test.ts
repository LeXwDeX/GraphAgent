// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// The pool flags its HTTP fallback while a websocket stream is failing, and the flag only helps the next
// attempt: a stream that already delivered frames cannot be replayed. So the pool's budget has to run out
// before the session's retry budget does, or the turn gives up on the very attempt that flagged the fallback.
import { expect, test } from "bun:test"
import { createServer, type IncomingMessage, type Server as HttpServer } from "node:http"
import WebSocket, { WebSocketServer } from "ws"
import { ProviderV2 } from "@graphagent/core/provider"
import { OpenAIWebSocketPool } from "../../../src/provider/openai-ws/ws-pool"
import { MessageV2 } from "../../../src/session/message-v2"
import { SessionRetry } from "../../../src/session/retry"

const providerID = ProviderV2.ID.make("openai")
const RETRIES = OpenAIWebSocketPool.DEFAULT_STREAM_RETRIES

// What a relay that cuts the connection after a few server frames looks like to the pool.
const frames = [
  { type: "response.created", response: { id: "resp_ws" } },
  { type: "response.in_progress", response: { id: "resp_ws" } },
  { type: "response.output_text.delta", delta: "partial" },
]

test("the default websocket retry budget leaves the session's last attempt to the HTTP fallback", () => {
  // RETRIES retries are RETRIES + 1 websocket attempts. The last one flags the fallback and the attempt after
  // it runs over HTTP, so the session needs RETRIES + 2 attempts, one more than its retry count.
  expect(RETRIES + 2).toBeLessThanOrEqual(SessionRetry.RETRY_MAX_RETRIES + 1)
})

for (const mode of [
  // The failure that exhausts the budget arrives after the stream was handed to the caller: it still errors.
  { name: "after the first frame", frames, failuresSeen: RETRIES + 1 },
  // Before the first frame the same attempt is answered over HTTP, so the caller sees one failure less.
  { name: "before the first frame", frames: [], failuresSeen: RETRIES },
]) {
  test(`a turn whose websocket drops ${mode.name} completes over HTTP within the session retry budget`, async () => {
    let upgrades = 0
    await using server = await createWebSocketServer((socket) => {
      upgrades++
      socket.once("message", () => drop(socket, mode.frames))
    })
    const transport = OpenAIWebSocketPool.createWebSocketFetch({ url: server.url })
    try {
      const turn = await runTurn(transport, server.url)

      expect(turn.text).toContain('"type":"response.completed"')
      expect(turn.text).not.toContain("resp_ws")
      expect(turn.failures).toHaveLength(mode.failuresSeen)
      expect(upgrades).toBe(RETRIES + 1)
      expect(server.httpRequests).toHaveLength(1)
      // The fallback is sticky: the next turn does not open another websocket.
      expect(await (await transport(server.url, streamRequest())).text()).toContain("response.completed")
      expect(upgrades).toBe(RETRIES + 1)
      expect(server.httpRequests).toHaveLength(2)
    } finally {
      transport.close()
    }
  })
}

test("a websocket drop is retried with the session's standard retry budget", async () => {
  await using server = await createWebSocketServer((socket) => {
    socket.once("message", () => drop(socket, frames))
  })
  const transport = OpenAIWebSocketPool.createWebSocketFetch({ url: server.url })
  try {
    const error = await (await transport(server.url, streamRequest())).text().then(
      () => undefined,
      (failure: unknown) => failure,
    )

    expect(SessionRetry.classify(MessageV2.fromError(error, { providerID }), "openai")).toMatchObject({
      branch: "network",
      maxRetries: SessionRetry.RETRY_MAX_RETRIES,
    })
  } finally {
    transport.close()
  }
})

// One session turn: the request is sent again after each retryable stream error until the retry cap, which is
// the stop rule of SessionRetry.policy (it stops once the failures seen exceed the decision's maxRetries).
async function runTurn(transport: ReturnType<typeof OpenAIWebSocketPool.createWebSocketFetch>, url: string) {
  const failures: unknown[] = []
  for (;;) {
    try {
      return { text: await (await transport(url, streamRequest())).text(), failures }
    } catch (error) {
      failures.push(error)
      const decision = SessionRetry.classify(MessageV2.fromError(error, { providerID }), "openai")
      if (failures.length > decision.maxRetries) throw error
    }
  }
}

// Sends the frames and then cuts the connection without a close frame, which the client reads as code 1006.
function drop(socket: WebSocket, frames: readonly unknown[]) {
  if (frames.length === 0) return socket.terminate()
  frames.forEach((frame, index) =>
    socket.send(JSON.stringify(frame), index === frames.length - 1 ? () => socket.terminate() : undefined),
  )
}

function streamRequest(): RequestInit {
  return {
    method: "POST",
    headers: { "session-id": "session-1", authorization: "Bearer test" },
    body: JSON.stringify({ stream: true, input: "hi" }),
  }
}

async function createWebSocketServer(onConnection: (socket: WebSocket) => void) {
  const httpRequests: IncomingMessage[] = []
  const http = createServer((request, response) => {
    httpRequests.push(request)
    response.writeHead(200, { "content-type": "text/event-stream" })
    response.end('data: {"type":"response.completed","response":{"id":"resp_http"}}\n\ndata: [DONE]\n\n')
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  const server = new WebSocketServer({ server: http })
  server.on("connection", onConnection)
  return {
    url: `http://127.0.0.1:${serverPort(http)}/v1/responses`,
    httpRequests,
    async [Symbol.asyncDispose]() {
      for (const socket of server.clients) socket.terminate()
      server.close()
      await new Promise<void>((resolve, reject) => http.close((error) => (error ? reject(error) : resolve())))
    },
  }
}

function serverPort(server: HttpServer) {
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Expected an HTTP server port")
  return address.port
}
