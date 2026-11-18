// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// A scripted OpenAI-compatible endpoint behind a `fetch` function. Nothing here opens a socket: the AI SDK model
// and the probe transport both receive this `fetch`, so a probe test sees exactly the requests the real code would
// send to https://api.example.com/v1, and no test can reach a real host or read a real credential.
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"

export const BASE_URL = "https://api.example.com/v1"
export const API_KEY = "fixture-key"
export const MODEL_ID = "probe-model"

/** What the endpoint does with one request. */
export type Reply =
  | { readonly kind: "json"; readonly body: unknown }
  | { readonly kind: "sse"; readonly chunks: readonly unknown[] }
  | { readonly kind: "status"; readonly status: number; readonly body: unknown }
  | { readonly kind: "throw"; readonly error: Error }
  | { readonly kind: "hang" }

/** A 200 JSON body, the shape `GET /models` answers with. */
export const json = (body: unknown): Reply => ({ kind: "json", body })
/** A 200 event stream. Strings are written as given (to script malformed chunks); `[DONE]` is appended. */
export const sse = (chunks: readonly unknown[]): Reply => ({ kind: "sse", chunks })
/** A complete non-2xx (or odd 2xx) response. */
export const status = (code: number, body: unknown = { error: { message: `fixture ${code}` } }): Reply => ({
  kind: "status",
  status: code,
  body,
})
/** `fetch` itself rejects, as it does when the connection is refused or reset. */
export const crash = (message = "fetch failed"): Reply => ({ kind: "throw", error: new TypeError(message) })
/** The request never gets an answer; like a real `fetch` it rejects only when its signal aborts. */
export const hang: Reply = { kind: "hang" }

/** One event-stream chunk of a chat completion. */
export const chunk = (delta: Record<string, unknown>, rest: Record<string, unknown> = {}) => ({
  id: "chatcmpl-probe",
  object: "chat.completion.chunk",
  created: 0,
  model: MODEL_ID,
  choices: [{ index: 0, delta, finish_reason: null }],
  ...rest,
})

/** The last chunk of a response: the finish reason (raw, so a vendor value can be scripted) and optional usage. */
export const end = (reason: string | null, rest: Record<string, unknown> = {}) => ({
  id: "chatcmpl-probe",
  object: "chat.completion.chunk",
  created: 0,
  model: MODEL_ID,
  choices: [{ index: 0, delta: {}, finish_reason: reason }],
  ...rest,
})

export interface Recorded {
  readonly method: string
  readonly url: string
  /** Header names are lower-cased. */
  readonly headers: Readonly<Record<string, string>>
  /** The parsed JSON request body, when there is one. */
  readonly body?: unknown
}

export interface Script {
  /** The answer to `GET <base>/models`. Defaults to a 404. */
  readonly models?: Reply
  /** The answers to `POST <base>/chat/completions`, one per request in order. A request beyond the list gets a 500. */
  readonly chat?: readonly Reply[]
}

function parseBody(body: unknown): unknown {
  if (typeof body !== "string") return undefined
  try {
    return JSON.parse(body)
  } catch {
    return undefined
  }
}

function respond(reply: Reply, signal: AbortSignal | null | undefined): Promise<Response> {
  if (reply.kind === "json") {
    const headers = { "content-type": "application/json" }
    return Promise.resolve(new Response(JSON.stringify(reply.body), { status: 200, headers }))
  }
  if (reply.kind === "sse") {
    const lines = reply.chunks.map((item) => `data: ${typeof item === "string" ? item : JSON.stringify(item)}\n\n`)
    const headers = { "content-type": "text/event-stream" }
    return Promise.resolve(new Response([...lines, "data: [DONE]\n\n"].join(""), { status: 200, headers }))
  }
  if (reply.kind === "status") {
    const body = typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body)
    return Promise.resolve(
      new Response(body, { status: reply.status, headers: { "content-type": "application/json" } }),
    )
  }
  if (reply.kind === "throw") return Promise.reject(reply.error)
  return new Promise<Response>((_, reject) => {
    if (signal?.aborted) reject(signal.reason)
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true })
  })
}

export function fakeEndpoint(script: Script = {}) {
  const requests: Recorded[] = []
  let chat = 0

  const fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = input instanceof Request ? input.url : String(input)
      const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase()
      requests.push({
        method,
        url,
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        body: parseBody(init?.body),
      })
      const signal = init?.signal
      if (method === "GET" && url === `${BASE_URL}/models`) {
        return respond(script.models ?? status(404, { error: { message: "no such route" } }), signal)
      }
      if (method === "POST" && url === `${BASE_URL}/chat/completions`) {
        const reply = script.chat?.[chat] ?? status(500, { error: { message: "unscripted request" } })
        chat += 1
        return respond(reply, signal)
      }
      return respond(status(404, { error: { message: "no such route" } }), signal)
    },
    { preconnect: () => undefined },
  )

  const provider = createOpenAICompatible({ name: "probe-test", baseURL: BASE_URL, apiKey: API_KEY, fetch })

  return {
    fetch,
    requests,
    /** The AI SDK model the probe talks through. */
    language: (id: string = MODEL_ID) => provider(id),
  }
}
