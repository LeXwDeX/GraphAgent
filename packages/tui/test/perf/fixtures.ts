// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { GlobalEvent, Message, Part, Session } from "@graphagent/sdk"
import { directory } from "../fixture/tui-sdk"

export const SESSION_ID = "ses_perf_main"
export const BACKGROUND_COUNT = 8

export type FixtureSize = "S" | "M" | "L"
/**
 * `XL` is for measuring by hand (`run.ts --profile=... --size=XL`) and is never
 * gated: 2000 parts in the 100 messages a session loads, so every one of them
 * reaches the transcript. In `L` the first 300 of 400 messages never do.
 */
export type MeasuredSize = FixtureSize | "XL"

export type PerfFixture = {
  size: MeasuredSize
  session: Session
  sessions: Session[]
  messages: Array<{ info: Message; parts: Part[] }>
  parts: Part[]
  backgroundParts: Part[]
}

const PART_COUNTS: Record<MeasuredSize, number> = { S: 25, M: 100, L: 400, XL: 2000 }
/** Parts that share one assistant message. Only `XL` packs several, the way a long agent turn does. */
const PARTS_PER_MESSAGE: Record<MeasuredSize, number> = { S: 1, M: 1, L: 1, XL: 20 }
const messageCount = (size: MeasuredSize) => PART_COUNTS[size] / PARTS_PER_MESSAGE[size]
/** The long fixtures carry the heavy payloads (a 5 KB paragraph, 10 KB tool output) that the short ones omit. */
const isLarge = (size: MeasuredSize) => size === "L" || size === "XL"

/**
 * Block-level markdown the transcript renders as separate native nodes: a
 * fenced code block (async syntax highlight), a table, and a fenced diff
 * snippet. A fixture of plain paragraphs never crosses the code-highlight or
 * table layout paths, so a cold scroll through it measures none of them.
 */
function codeBlock(index: number) {
  return [
    "```ts",
    `export function item${index}(input: number) {`,
    `  const scaled = input * ${index + 2}`,
    "  return scaled > 100 ? scaled - 100 : scaled",
    "}",
    "```",
  ].join("\n")
}

function table(index: number) {
  return [
    "| name | value | note |",
    "| --- | --- | --- |",
    `| item${index} | ${index} | stable |`,
    `| next | ${index + 1} | pending |`,
  ].join("\n")
}

function diffSnippet(index: number) {
  return [
    "```diff",
    `--- a/src/item${index}.ts`,
    `+++ b/src/item${index}.ts`,
    "@@ -1,3 +1,3 @@",
    " export const base = 1",
    `-export const value = ${index}`,
    `+export const value = ${index + 1}`,
    "```",
  ].join("\n")
}

/**
 * The session loads its last 100 messages, so an index maps to a position in the
 * loaded page by its remainder modulo 100.
 */
const PAGE = 100
/** Parts this close to the head of the page stay plain. */
const PLAIN_HEAD = 10
/** Parts this close to its tail stay plain. */
const PLAIN_TAIL: Record<MeasuredSize, number> = { S: 10, M: 20, L: 20, XL: 20 }

/**
 * Rich block per text part by position in the decade: code, table, diff, then
 * plain. Only the interior of the page carries them. The ends are where the
 * typing, streaming, background, and spinner scenarios work, and where tests that
 * pin the viewport to the bottom expect the row heights to be settled: heights are
 * estimated until a row is measured, and a viewport pinned by an absolute offset
 * does not follow the correction of rows it already passed. Every scroll scenario
 * leaves the ends and crosses the interior.
 */
function richBlock(index: number, size: MeasuredSize) {
  const position = Math.floor(index / PARTS_PER_MESSAGE[size]) % PAGE
  if (position < PLAIN_HEAD || position >= Math.min(PAGE, messageCount(size)) - PLAIN_TAIL[size]) return ""
  switch (index % 10) {
    case 0:
      return codeBlock(index)
    case 1:
      return table(index)
    case 2:
      return diffSnippet(index)
    default:
      return ""
  }
}

function text(index: number, size: MeasuredSize) {
  const suffix = isLarge(size) && index % 11 === 0 ? `\n\n${"long context ".repeat(420)}` : ""
  const block = richBlock(index, size)
  const rich = block ? `\n\n${block}` : ""
  return `Deterministic answer ${index}: inspect the rendered session and keep the output stable.${rich}${suffix}`
}

function toolOutput(index: number, size: MeasuredSize) {
  const body = `tool output ${index}\n${"result line ".repeat(isLarge(size) ? 120 : 18)}`
  return body.slice(0, isLarge(size) && index % 9 === 0 ? 10_000 : 2_000)
}

function message(
  id: string,
  sessionID: string,
  role: "user" | "assistant",
  created: number,
  parentID?: string,
): Message {
  if (role === "user") {
    return {
      id,
      sessionID,
      role,
      agent: "build",
      model: { providerID: "test", modelID: "perf" },
      time: { created },
    }
  }
  return {
    id,
    sessionID,
    role,
    parentID: parentID ?? `${sessionID}_user`,
    agent: "build",
    mode: "build",
    modelID: "perf",
    providerID: "test",
    path: { cwd: directory, root: directory },
    time: { created, completed: created + 1 },
    cost: 0,
    tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    finish: "stop",
  }
}

function partFor(index: number, sessionID: string, messageID: string, size: MeasuredSize): Part {
  const base = { id: `prt_${sessionID}_${index}`, sessionID, messageID }
  const kind = index % 10
  if (kind < 4) {
    return { ...base, type: "text", text: text(index, size), time: { start: index, end: index + 1 } }
  }
  if (kind < 8) {
    return {
      ...base,
      type: "tool",
      callID: `call_${sessionID}_${index}`,
      tool: index % 2 ? "bash" : "read",
      state: {
        status: "completed",
        input: { command: `printf perf-${index}` },
        output: toolOutput(index, size),
        title: "Deterministic tool",
        metadata: {},
        time: { start: index, end: index + 1 },
      },
    }
  }
  if (kind === 8) {
    return {
      ...base,
      type: "reasoning",
      text: `Reasoning step ${index}: preserve the stable fixture ordering.`,
      time: { start: index, end: index + 1 },
    }
  }
  return {
    ...base,
    type: "patch",
    hash: `hash_${index}`,
    files: [`src/perf-${index}.ts`],
  }
}

function makeSession(id: string, title: string, parentID?: string): Session {
  return {
    id,
    slug: id,
    projectID: "proj_test",
    directory,
    parentID,
    title,
    version: "1.17.11",
    time: { created: 1, updated: 2 },
  }
}

export function createFixture(size: MeasuredSize, withBackground = false): PerfFixture {
  const session = makeSession(SESSION_ID, `Performance ${size}`)
  const user = message(`${SESSION_ID}_user`, SESSION_ID, "user", 1)
  const messages: Array<{ info: Message; parts: Part[] }> = [{ info: user, parts: [] }]
  const parts: Part[] = []
  let previous = user.id
  const perMessage = PARTS_PER_MESSAGE[size]
  for (let slot = 0; slot < messageCount(size); slot++) {
    // With one part per message the message id carries the part index, as it always has.
    const info = message(`msg_${SESSION_ID}_${slot}`, SESSION_ID, "assistant", slot + 2, previous)
    const own = Array.from({ length: perMessage }, (_, offset) =>
      partFor(slot * perMessage + offset, SESSION_ID, info.id, size),
    )
    messages.push({ info, parts: own })
    parts.push(...own)
    previous = info.id
  }

  const sessions = [session]
  const backgroundParts: Part[] = []
  if (withBackground) {
    for (let index = 0; index < BACKGROUND_COUNT; index++) {
      const childID = `ses_perf_child_${index}`
      const child = makeSession(childID, `Background ${index}`, SESSION_ID)
      sessions.push(child)
      backgroundParts.push({
        id: `prt_${childID}_stream`,
        sessionID: childID,
        messageID: `msg_${childID}`,
        type: "tool",
        callID: `call_${childID}`,
        tool: "bash",
        state: {
          status: "running",
          input: { command: "stream" },
          time: { start: 1 },
        },
      })
    }
  }

  return {
    size,
    session,
    sessions,
    messages,
    parts,
    backgroundParts,
  }
}

/**
 * Appends a code block, a table, or a diff to each of the last `count` text
 * parts, in that order. The default fixture keeps both ends of the page plain so
 * that scenarios which pin the viewport by an absolute offset see settled row
 * heights there. This is the transcript those ends leave out: tall rows exactly
 * where a reader lands. It edits the fixture in place; call it before mounting.
 */
export function richTail(fixture: PerfFixture, count: number): PerfFixture {
  const blocks = [codeBlock, table, diffSnippet]
  const texts = fixture.parts.filter((part) => part.type === "text").slice(-count)
  texts.forEach((part, ordinal) => {
    if (part.type !== "text") return
    part.text = `${part.text}\n\n${blocks[ordinal % blocks.length](1_000 + ordinal)}`
  })
  return fixture
}

/**
 * A text part the server is still writing. It hangs off the last assistant
 * message, so it sits at the tail of the transcript like a live reply, and it
 * has no `time.end` until its terminal snapshot. The session loads only its
 * last 100 messages, so the head of the transcript is not a place a live reply
 * can land. The id sorts after the message's own part, which keeps the stream at
 * the end of the message.
 */
export function streamTextPart(fixture: PerfFixture, ordinal: number, text: string, end?: number): Part {
  const tail = fixture.messages.at(-1)!.info
  return {
    id: `prt_${fixture.session.id}_stream_${ordinal}`,
    sessionID: fixture.session.id,
    messageID: tail.id,
    type: "text",
    text,
    time: end === undefined ? { start: ordinal } : { start: ordinal, end },
  }
}

export function updatePartEvent(part: Part, time: number, id: string): GlobalEvent {
  return {
    directory,
    project: "proj_test",
    payload: { id, type: "message.part.updated", properties: { sessionID: part.sessionID, time, part } },
  }
}

/** One streamed token. The sync layer appends it to the stream buffer; it never writes `store.part`. */
export function deltaEvent(part: Part, delta: string, id: string): GlobalEvent {
  return {
    directory,
    project: "proj_test",
    payload: {
      id,
      type: "message.part.delta",
      properties: { sessionID: part.sessionID, messageID: part.messageID, partID: part.id, field: "text", delta },
    },
  }
}

export function backgroundEvent(part: Part, tick: number): GlobalEvent {
  const output = `background tick ${tick} ${"tail ".repeat(900)}`
  return updatePartEvent(
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- deterministic fixture part
    {
      ...part,
      state: {
        status: "running",
        input: { command: "stream" },
        time: { start: 1 },
        metadata: { totalOutputBytes: output.length, previewBytes: Math.min(output.length, 4096) },
      },
    } as Part,
    tick,
    `evt_background_${part.sessionID}_${tick}`,
  )
}

export function makeFetchFixture(fixture: PerfFixture, url: URL): Response | undefined {
  if (url.pathname === "/session") return Response.json(fixture.sessions)
  const session = fixture.sessions.find((item) => url.pathname === `/session/${item.id}`)
  if (session) return Response.json(session)
  const messages = fixture.sessions.find((item) => url.pathname === `/session/${item.id}/message`)
  if (messages) return Response.json(messages.id === SESSION_ID ? fixture.messages : [])
  if (url.pathname === "/project/directories") return Response.json([])
  if (url.pathname.endsWith("/todo") || url.pathname.endsWith("/diff") || url.pathname.endsWith("/goal"))
    return Response.json([])
  if (url.pathname === "/command")
    return Response.json([{ name: "mode", template: "mode", source: "command", hints: [] }])
  if (url.pathname.startsWith("/experimental/workspace")) return Response.json([])
  if (url.pathname.startsWith("/dag/")) return Response.json([])
  if (url.pathname.endsWith("/status")) return Response.json({})
  if (url.pathname.startsWith("/project/")) return Response.json([])
  return undefined
}
