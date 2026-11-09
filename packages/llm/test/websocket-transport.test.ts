// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect } from "bun:test"
import { Effect, Exit, Stream } from "effect"
import { Headers } from "effect/http"
import { fromWebSocket } from "../src/route/transport/websocket"
import { it } from "./lib/effect"

class TestSocket extends EventTarget {
  readyState: number = globalThis.WebSocket.OPEN
  closes: Array<{ code: number | undefined; reason: string | undefined }> = []
  listeners = new Map<string, Set<EventListenerOrEventListenerObject>>()

  override addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ) {
    if (listener) {
      const listeners = this.listeners.get(type) ?? new Set()
      listeners.add(listener)
      this.listeners.set(type, listeners)
    }
    super.addEventListener(type, listener, options)
  }

  override removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions,
  ) {
    if (listener) this.listeners.get(type)?.delete(listener)
    super.removeEventListener(type, listener, options)
  }

  send(_message: string) {}

  close(code?: number, reason?: string) {
    this.closes.push({ code, reason })
    this.readyState = globalThis.WebSocket.CLOSED
    this.dispatchEvent(new CloseEvent("close", { code: code ?? 1000, reason }))
  }

  message(data: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data }))
  }

  get listenerCount() {
    return [...this.listeners.values()].reduce((count, listeners) => count + listeners.size, 0)
  }
}

const connect = (socket: TestSocket) =>
  Effect.acquireRelease(
    fromWebSocket(
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- the fixture implements the WebSocket members used by this transport.
      socket as unknown as WebSocket,
      { url: "wss://synthetic.test/responses", headers: Headers.empty },
    ),
    (connection) => connection.close,
  )

describe("WebSocket receive buffer", () => {
  it.effect("preserves every ordered frame when a burst fits the buffer", () =>
    Effect.gen(function* () {
      const socket = new TestSocket()
      yield* Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* connect(socket)
          const frames = Array.from({ length: 128 }, (_, index) => `frame-${index}`)
          frames.forEach((frame) => socket.message(frame))
          socket.close(1000)
          expect(yield* Stream.runCollect(connection.messages)).toEqual(frames)
        }),
      )
      expect(socket.listenerCount).toBe(0)
      expect(socket.closes).toHaveLength(1)
    }),
  )

  for (const binary of [false, true]) {
    it.effect(`fails explicitly when a ${binary ? "binary" : "text"} burst overflows`, () =>
      Effect.gen(function* () {
        const socket = new TestSocket()
        yield* Effect.scoped(
          Effect.gen(function* () {
            const connection = yield* connect(socket)
            for (let index = 0; index < 129; index++) {
              socket.message(binary ? new Uint8Array([index]) : `frame-${index}`)
            }
            const error = yield* Stream.runCollect(connection.messages).pipe(Effect.flip)
            expect(error.message).toContain("receive buffer overflow")
            expect(error.reason).toMatchObject({ kind: "overflow", url: "wss://synthetic.test/responses" })
            expect(socket.closes).toEqual([{ code: 1000, reason: "Receive buffer overflow" }])
          }),
        )
        expect(socket.listenerCount).toBe(0)
      }),
    )
  }

  it.live("releases the socket and all listeners when stream consumption is interrupted", () =>
    Effect.gen(function* () {
      const socket = new TestSocket()
      const exit = yield* Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* connect(socket)
          return yield* Stream.runCollect(connection.messages).pipe(Effect.timeout("10 millis"))
        }),
      ).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(socket.listenerCount).toBe(0)
      expect(socket.closes).toEqual([{ code: 1000, reason: undefined }])
    }),
  )
})
