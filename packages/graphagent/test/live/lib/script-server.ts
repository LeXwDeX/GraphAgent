// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * A scripted OpenAI-compatible model server (Issue #1474). It plays the model of the replay tier of the model
 * matrix: the real session runtime and the real tools run against it, and what the "model" says is fixed text.
 *
 * A request is answered from the script the case marker names. The user message of a run ends with a line
 * `[case <key>]`; the first `user` message of a request carries it, and `register(key, replies)` stored the
 * replies for that key. Reply `n` answers the request that follows `n` assistant messages, so a script is a plain
 * list of turns and a retried or resumed request gets the same answer. A request with no marker is answered with
 * `ok`, a request past the end of its script with `done`, and the title request of the runtime with `E2E Title`.
 *
 * An argument string may say `<saved>`: it stands for the path of the saved tool output that the previous tool
 * result named (`.../tool-output/tool_<id>`), so a script can continue from a truncated result whose path is only
 * known at run time.
 */

/** One turn of a script: say something and stop, or call tools. */
export type Reply = { readonly text: string } | { readonly calls: readonly { name: string; input: unknown }[] }

export interface ScriptServer {
  /** `http://127.0.0.1:<port>/v1`, the base URL of an OpenAI-compatible provider. */
  readonly baseURL: string
  /** Sets the replies for `key`, replacing an earlier script of the same key. */
  readonly register: (key: string, replies: readonly Reply[]) => void
  readonly stop: () => void
}

const TITLE_MARKER = "Generate a title for this conversation"
const CASE_MARKER = /\[case ([^\]\s]+)\]/
const SAVED_PATH = /\/[\w./-]*\/tool-output\/tool_\w+/

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** The text of a message content: a string, or the text parts of a list. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content.map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : "")).join("\n")
}

function messagesOf(body: unknown): Record<string, unknown>[] {
  return isRecord(body) && Array.isArray(body.messages) ? body.messages.filter(isRecord) : []
}

/** The key of the first user message's `[case <key>]` marker. */
function caseKey(messages: readonly Record<string, unknown>[]): string | undefined {
  const first = messages.find((message) => message.role === "user")
  return first ? CASE_MARKER.exec(textOf(first.content))?.[1] : undefined
}

/** The first saved-output path in the latest tool result of the request. */
function savedPath(messages: readonly Record<string, unknown>[]): string | undefined {
  const latest = messages.findLast((message) => message.role === "tool")
  return latest ? SAVED_PATH.exec(textOf(latest.content))?.[0] : undefined
}

/** `value` with every `<saved>` in its strings replaced; without a path to say, it is returned as it is. */
function fillSaved(value: unknown, saved: string | undefined): unknown {
  if (saved === undefined) return value
  if (typeof value === "string") return value.replaceAll("<saved>", saved)
  if (Array.isArray(value)) return value.map((item) => fillSaved(item, saved))
  if (isRecord(value))
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, fillSaved(item, saved)]))
  return value
}

function chunk(delta: Record<string, unknown>, finish?: string): string {
  const choice = { index: 0, delta, ...(finish ? { finish_reason: finish } : {}) }
  return `data: ${JSON.stringify({ id: "chatcmpl-script", object: "chat.completion.chunk", choices: [choice] })}\n\n`
}

function stream(chunks: readonly string[]): Response {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const item of chunks) controller.enqueue(encoder.encode(item))
        controller.enqueue(encoder.encode("data: [DONE]\n\n"))
        controller.close()
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  )
}

function textResponse(text: string): Response {
  return stream([chunk({ role: "assistant" }), chunk({ content: text }), chunk({}, "stop")])
}

function callsResponse(
  calls: readonly { name: string; input: unknown }[],
  ids: { key: string; turn: number },
  saved: string | undefined,
): Response {
  const chunks = [chunk({ role: "assistant" })]
  calls.forEach((call, index) => {
    const id = `call_${ids.key}_${ids.turn}_${index}`
    const toolCall = { index, id, type: "function", function: { name: call.name, arguments: "" } }
    chunks.push(chunk({ tool_calls: [toolCall] }))
    const args = JSON.stringify(fillSaved(call.input, saved))
    chunks.push(chunk({ tool_calls: [{ index, function: { arguments: args } }] }))
  })
  chunks.push(chunk({}, "tool_calls"))
  return stream(chunks)
}

export function startScriptServer(): ScriptServer {
  const scripts = new Map<string, readonly Reply[]>()
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method !== "POST") return new Response("not found", { status: 404 })
      const body: unknown = await request.json().catch(() => undefined)
      if (JSON.stringify(body ?? {}).includes(TITLE_MARKER)) return textResponse("E2E Title")
      const messages = messagesOf(body)
      const key = caseKey(messages)
      const replies = key === undefined ? undefined : scripts.get(key)
      if (key === undefined || replies === undefined) return textResponse("ok")
      const turn = messages.filter((message) => message.role === "assistant").length
      const reply = replies[turn] ?? { text: "done" }
      if ("text" in reply) return textResponse(reply.text)
      return callsResponse(reply.calls, { key, turn }, savedPath(messages))
    },
  })
  return {
    baseURL: `http://127.0.0.1:${server.port}/v1`,
    register: (key, replies) => void scripts.set(key, replies),
    stop: () => void server.stop(true),
  }
}
