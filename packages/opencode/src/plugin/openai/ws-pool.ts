import WebSocket from "ws"
import { ProviderError } from "@/provider/error"
import { isRecord } from "@/util/record"
import { OpenAIWebSocket } from "./ws"

export const TITLE_HEADER = "x-opencode-title"
const titleHeaderConsumers = new WeakSet<object>()

export function registerTitleHeaderConsumer<
  T extends (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
>(fetch: T): T {
  titleHeaderConsumers.add(fetch)
  return fetch
}

export function isTitleHeaderConsumer(fetch: unknown) {
  return typeof fetch === "function" && titleHeaderConsumers.has(fetch)
}

export interface CreateWebSocketFetchOptions {
  httpFetch?: typeof globalThis.fetch
  url?: string
  connectTimeout?: number
  idleTimeout?: number
  maxConnectionAge?: number
  streamRetries?: number
}

interface PoolEntry {
  socket?: WebSocket
  controller: AbortController
  httpActive: number
  connectedAt?: number
  lastUsedAt: number
  busy: boolean
  fallback: boolean
  streamFailures: number
}

const DEFAULT_CONNECT_TIMEOUT = 15_000
const DEFAULT_IDLE_TIMEOUT = 5 * 60 * 1000
const DEFAULT_MAX_CONNECTION_AGE = 55 * 60 * 1000
const CONNECTION_LIMIT_REACHED_CODE = "websocket_connection_limit_reached"

export function createWebSocketFetch(options?: CreateWebSocketFetchOptions) {
  const httpFetch = options?.httpFetch ?? globalThis.fetch
  const pool = new Map<string, PoolEntry>()
  let closed = false
  const connectTimeout = options?.connectTimeout ?? DEFAULT_CONNECT_TIMEOUT
  const idleTimeout = options?.idleTimeout ?? DEFAULT_IDLE_TIMEOUT
  const maxConnectionAge = options?.maxConnectionAge ?? DEFAULT_MAX_CONNECTION_AGE
  const streamRetries = options?.streamRetries ?? 5
  const pruneTimer = setInterval(() => prune(), Math.min(idleTimeout, 60_000))
  if (typeof pruneTimer === "object" && "unref" in pruneTimer && typeof pruneTimer.unref === "function") {
    pruneTimer.unref()
  }

  async function websocketFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    if (closed) throw new DOMException("WebSocket pool closed", "AbortError")
    const url = input instanceof URL ? input.toString() : typeof input === "string" ? input : input.url
    const internalHeaders = OpenAIWebSocket.normalizeHeaders(init?.headers)
    const httpInit = withoutInternalRequestHeaders(input, init ?? {})

    if (init?.method !== "POST" || !new URL(url).pathname.endsWith("/responses")) {
      return httpFetch(input, httpInit)
    }

    const body = (() => {
      try {
        if (typeof init?.body !== "string") return undefined
        const parsed = JSON.parse(init.body)
        return typeof parsed === "object" && parsed !== null ? parsed : undefined
      } catch {
        return undefined
      }
    })()
    if (!body?.stream) return httpFetch(input, httpInit)
    if (internalHeaders[TITLE_HEADER] === "true") {
      return httpFetch(input, httpInit)
    }

    const sessionID = internalHeaders["x-session-affinity"] ?? internalHeaders["session-id"]
    if (!sessionID) {
      return httpFetch(input, httpInit)
    }
    const key = `${sessionID}:conversation`

    const entry = pool.get(key) ?? {
      controller: new AbortController(),
      httpActive: 0,
      lastUsedAt: Date.now(),
      busy: false,
      fallback: false,
      streamFailures: 0,
    }
    pool.set(key, entry)

    if (entry.fallback) {
      return httpFallback(entry, input, httpInit)
    }
    if (entry.busy) {
      return httpFallback(entry, input, httpInit)
    }

    entry.busy = true
    entry.lastUsedAt = Date.now()
    const signal = requestSignal(entry, input, init)
    try {
      entry.socket = await socket(
        entry,
        options?.url ?? url,
        OpenAIWebSocket.normalizeHeaders(httpInit?.headers),
        connectTimeout,
        maxConnectionAge,
        signal,
      )
      signal.throwIfAborted()
      let resolveFirstEvent: (event: boolean | OpenAIWebSocket.WrappedError) => void = () => {}
      let rejectFirstEvent: (error: Error) => void = () => {}
      const firstEvent = new Promise<boolean | OpenAIWebSocket.WrappedError>((resolve, reject) => {
        resolveFirstEvent = resolve
        rejectFirstEvent = reject
      })
      const response = OpenAIWebSocket.streamResponsesWebSocket({
        socket: entry.socket,
        body,
        idleTimeout,
        signal,
        onFirstEvent: (error) => resolveFirstEvent(error ?? true),
        onTerminal: (event) => {
          entry.busy = false
          entry.lastUsedAt = Date.now()
          entry.streamFailures = 0
          if (event.type !== "response.completed" && event.type !== "response.done") {
            invalidate(entry)
          }
        },
        onConnectionInvalid: (_error, closeCode) => {
          entry.busy = false
          entry.lastUsedAt = Date.now()
          if (closeCode === OpenAIWebSocket.MESSAGE_TOO_BIG_CLOSE_CODE) entry.fallback = true
          else if (!entry.fallback) recordStreamFailure(entry)
          invalidate(entry)
          resolveFirstEvent(false)
        },
        onAbort: (error) => {
          entry.busy = false
          entry.lastUsedAt = Date.now()
          entry.streamFailures = 0
          invalidate(entry)
          rejectFirstEvent(error)
        },
        onRetryableTerminal: async (event) => {
          const error = connectionLimitError(event)
          if (!error) return undefined
          throw error
        },
      })
      const first = await firstEvent
      signal.throwIfAborted()
      if (closed || pool.get(key) !== entry) {
        throw new DOMException(closed ? "WebSocket pool closed" : "WebSocket session removed", "AbortError")
      }
      if (first !== false) {
        if (first === true || first.status < 200 || first.status > 599) return response
        return new Response(first.body, {
          status: first.status,
          headers: { "content-type": "application/json", ...first.headers },
        })
      }
      if (!entry.fallback) return response
      return httpFallback(entry, input, httpInit)
    } catch (error) {
      entry.busy = false
      entry.lastUsedAt = Date.now()
      if (signal.aborted || OpenAIWebSocket.isAbortError(error)) {
        entry.streamFailures = 0
        invalidate(entry)
        throw OpenAIWebSocket.isAbortError(error)
          ? error
          : new DOMException(error instanceof Error ? error.message : "Aborted", "AbortError")
      }

      recordStreamFailure(entry)
      invalidate(entry)
      if (entry.fallback) return httpFallback(entry, input, httpInit)
      return failedResponse(
        new ProviderError.ResponseStreamError(error instanceof Error ? error.message : String(error), {
          cause: error,
        }),
      )
    }
  }

  async function httpFallback(entry: PoolEntry, input: RequestInfo | URL, init?: RequestInit) {
    const signal = requestSignal(entry, input, init)
    signal.throwIfAborted()
    entry.httpActive++
    let released = false
    let removeAbortListener = () => {}
    function release() {
      if (released) return
      released = true
      removeAbortListener()
      entry.httpActive--
      entry.lastUsedAt = Date.now()
    }
    try {
      const response = await httpFetch(input, { ...init, signal })
      if (!response.body) {
        release()
        return response
      }
      const reader = response.body.getReader()
      let readerReleased = false
      function releaseReader() {
        if (readerReleased) return
        readerReleased = true
        reader.releaseLock()
      }
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            function onAbort() {
              const error = signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError")
              release()
              controller.error(error)
              void reader
                .cancel(error)
                .catch(() => {})
                .finally(releaseReader)
            }
            signal.addEventListener("abort", onAbort, { once: true })
            removeAbortListener = () => signal.removeEventListener("abort", onAbort)
            if (signal.aborted) onAbort()
          },
          async pull(controller) {
            try {
              const chunk = await reader.read()
              if (released) return
              if (chunk.done) {
                release()
                releaseReader()
                controller.close()
              } else controller.enqueue(chunk.value)
            } catch (error) {
              if (released) return
              release()
              releaseReader()
              controller.error(error)
            }
          },
          async cancel(reason) {
            release()
            try {
              await reader.cancel(reason)
            } finally {
              releaseReader()
            }
          },
        }),
        { status: response.status, statusText: response.statusText, headers: response.headers },
      )
    } catch (error) {
      release()
      throw error
    }
  }

  function recordStreamFailure(entry: PoolEntry) {
    entry.streamFailures++
    // Codex counts retries after the initial failed WebSocket attempt.
    if (entry.streamFailures > streamRetries) entry.fallback = true
  }

  function prune() {
    const now = Date.now()
    for (const [key, entry] of pool) {
      if (entry.busy || entry.httpActive > 0) continue
      if (entry.fallback) continue
      if (now - entry.lastUsedAt < idleTimeout) continue
      invalidate(entry)
      pool.delete(key)
    }
  }

  function close() {
    if (closed) return
    closed = true
    clearInterval(pruneTimer)
    for (const entry of pool.values()) {
      entry.controller.abort(new DOMException("WebSocket pool closed", "AbortError"))
      invalidate(entry)
    }
    pool.clear()
  }

  function remove(sessionID: string) {
    const key = `${sessionID}:conversation`
    const entry = pool.get(key)
    if (!entry) return
    entry.controller.abort(new DOMException("WebSocket session removed", "AbortError"))
    invalidate(entry)
    pool.delete(key)
  }

  return registerTitleHeaderConsumer(Object.assign(websocketFetch, { close, remove }))
}

function requestSignal(entry: PoolEntry, input: RequestInfo | URL, init?: RequestInit) {
  const caller = init?.signal !== undefined ? init.signal : input instanceof Request ? input.signal : undefined
  return caller ? AbortSignal.any([caller, entry.controller.signal]) : entry.controller.signal
}

function connectionLimitError(event: Record<string, unknown>) {
  if (event.type !== "error" || !isRecord(event.error) || event.error.code !== CONNECTION_LIMIT_REACHED_CODE) return
  return new Error(typeof event.error.message === "string" ? event.error.message : CONNECTION_LIMIT_REACHED_CODE)
}

function failedResponse(error: ProviderError.ResponseStreamError) {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.error(error)
      },
    }),
    {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    },
  )
}

async function socket(
  entry: PoolEntry,
  url: string,
  headers: Record<string, string>,
  connectTimeout: number,
  maxConnectionAge: number,
  signal?: AbortSignal | null,
) {
  if (
    entry.socket?.readyState === WebSocket.OPEN &&
    entry.connectedAt &&
    Date.now() - entry.connectedAt < maxConnectionAge
  ) {
    return entry.socket
  }

  invalidate(entry)
  const next = await OpenAIWebSocket.connectResponsesWebSocket({
    url: OpenAIWebSocket.toWebSocketUrl(url),
    headers,
    timeout: connectTimeout,
    signal: signal ?? undefined,
  })
  // Cleanup may run after the handshake resolves but before this continuation.
  entry.socket = next
  entry.connectedAt = Date.now()
  return next
}

function invalidate(entry: PoolEntry) {
  if (entry.socket) {
    entry.socket.on("error", () => {})
    entry.socket.terminate()
    entry.socket = undefined
  }
  entry.connectedAt = undefined
}

export function withoutInternalHeaders<T extends { headers?: HeadersInit }>(init: T | undefined): T | undefined {
  if (!init?.headers) return init
  if (init.headers instanceof Headers) {
    const headers = new Headers(init.headers)
    headers.delete(TITLE_HEADER)
    return { ...init, headers }
  }

  if (Array.isArray(init.headers)) {
    return { ...init, headers: init.headers.filter((item) => item[0].toLowerCase() !== TITLE_HEADER) }
  }

  return {
    ...init,
    headers: Object.fromEntries(Object.entries(init.headers).filter(([key]) => key.toLowerCase() !== TITLE_HEADER)),
  }
}

export function withoutInternalRequestHeaders<T extends { headers?: HeadersInit }>(
  input: RequestInfo | URL,
  init: T,
): T {
  const headers = init.headers === undefined && input instanceof Request ? input.headers : init.headers
  return withoutInternalHeaders({ ...init, headers }) ?? init
}

export * as OpenAIWebSocketPool from "./ws-pool"
