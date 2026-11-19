// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type {
  DagNode,
  DagWorkflowSummary,
  GlobalEvent,
  Goal,
  Message,
  Part,
  PrWatchEntry,
  Session,
  SessionDagMode,
  SessionReminder,
} from "@graphagent/sdk"
import { directory } from "../fixture/tui-sdk"

export const SESSION_ID = "ses_perf_main"
export const BACKGROUND_COUNT = 8

/**
 * `S`, `M` and `L` stay below `WINDOW_MIN_ROWS`, so their transcripts are fully
 * mounted. `XL` is the one session above it, and the only one the windowed
 * transcript runs in: 2200 parts, 22 to each of the 100 assistant messages a
 * session loads, so every part reaches the transcript. In `L` the first 300 of
 * its 400 messages never do.
 */
export type FixtureSize = "S" | "M" | "L" | "XL"

export type PerfFixture = {
  size: FixtureSize
  session: Session
  sessions: Session[]
  messages: Array<{ info: Message; parts: Part[] }>
  parts: Part[]
  backgroundParts: Part[]
  /** Rows the transcript holds once the session has loaded, before a scenario adds any. */
  rows: number
  /**
   * What the status band is given to draw (#1620). None is set unless a scenario sets it before it mounts the harness
   * (`withRunningWorkflow` does the workflow), so no other scenario sees a workflow, a PR or a reminder. The
   * workflows and their node tables answer `GET /dag/session/:id/summary` and `GET /dag/:id/nodes`, the other two
   * `GET /session/:id/pr-watch` and `GET /session/:id/reminder`, all for the root session.
   */
  dagSummaries?: DagWorkflowSummary[]
  dagTables?: Record<string, DagNode[]>
  prWatches?: PrWatchEntry[]
  reminders?: SessionReminder[]
}

const PART_COUNTS: Record<FixtureSize, number> = { S: 25, M: 100, L: 400, XL: 2200 }
/** Parts that share one assistant message. Only `XL` packs several, the way a long agent turn does. */
const PARTS_PER_MESSAGE: Record<FixtureSize, number> = { S: 1, M: 1, L: 1, XL: 22 }

export type FixtureOptions = {
  /**
   * Parts in each assistant message, in place of the size's own. The message count stays, so this scales the
   * transcript: 20 parts per message of `XL` is about 1900 rows (just below `WINDOW_MIN_ROWS`, fully
   * mounted), 40 about 3700. It exists for scale experiments (`run.ts --profile=stream`); the gated
   * sessions use the sizes as they are.
   */
  partsPerMessage?: number
}

/** How a fixture's parts are spread over its messages. */
type Layout = { size: FixtureSize; perMessage: number; messages: number }

function layoutOf(size: FixtureSize, options: FixtureOptions = {}): Layout {
  const messages = PART_COUNTS[size] / PARTS_PER_MESSAGE[size]
  return { size, perMessage: options.partsPerMessage ?? PARTS_PER_MESSAGE[size], messages }
}
/** The long fixtures carry the heavy payloads (a 5 KB paragraph, 10 KB tool output) that the short ones omit. */
const isLarge = (size: FixtureSize) => size === "L" || size === "XL"

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
const PLAIN_TAIL: Record<FixtureSize, number> = { S: 10, M: 20, L: 20, XL: 20 }

/**
 * Rich block per text part by position in the decade: code, table, diff, then
 * plain. Only the interior of the page carries them. The ends are where the
 * typing, streaming, background, and spinner scenarios work, and where tests that
 * pin the viewport to the bottom expect the row heights to be settled: heights are
 * estimated until a row is measured, and a viewport pinned by an absolute offset
 * does not follow the correction of rows it already passed. Every scroll scenario
 * leaves the ends and crosses the interior.
 */
function richBlock(index: number, layout: Layout) {
  const position = Math.floor(index / layout.perMessage) % PAGE
  if (position < PLAIN_HEAD || position >= Math.min(PAGE, layout.messages) - PLAIN_TAIL[layout.size]) return ""
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

function text(index: number, layout: Layout) {
  const suffix = isLarge(layout.size) && index % 11 === 0 ? `\n\n${"long context ".repeat(420)}` : ""
  const block = richBlock(index, layout)
  const rich = block ? `\n\n${block}` : ""
  return `Deterministic answer ${index}: inspect the rendered session and keep the output stable.${rich}${suffix}`
}

function toolOutput(index: number, size: FixtureSize) {
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

function partFor(index: number, sessionID: string, messageID: string, layout: Layout): Part {
  const { size } = layout
  const base = { id: `prt_${sessionID}_${index}`, sessionID, messageID }
  const kind = index % 10
  if (kind < 4) {
    return { ...base, type: "text", text: text(index, layout), time: { start: index, end: index + 1 } }
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
    role: parentID ? "task_child" : "root",
    projectID: "proj_test",
    directory,
    parentID,
    title,
    version: "1.17.11",
    time: { created: 1, updated: 2 },
  }
}

export function createFixture(size: FixtureSize, withBackground = false, options: FixtureOptions = {}): PerfFixture {
  const session = makeSession(SESSION_ID, `Performance ${size}`)
  const user = message(`${SESSION_ID}_user`, SESSION_ID, "user", 1)
  const messages: Array<{ info: Message; parts: Part[] }> = [{ info: user, parts: [] }]
  const parts: Part[] = []
  let previous = user.id
  const layout = layoutOf(size, options)
  const { perMessage } = layout
  for (let slot = 0; slot < layout.messages; slot++) {
    // With one part per message the message id carries the part index, as it always has.
    const info = message(`msg_${SESSION_ID}_${slot}`, SESSION_ID, "assistant", slot + 2, previous)
    const own = Array.from({ length: perMessage }, (_, offset) =>
      partFor(slot * perMessage + offset, SESSION_ID, info.id, layout),
    )
    messages.push({ info, parts: own })
    parts.push(...own)
    previous = info.id
  }

  // The session loads its last 100 messages. A part of text, reasoning or tool output
  // is a row, patches are not, and every finished assistant message adds a summary row.
  const loaded = messages.filter((message) => message.info.role === "assistant").slice(-PAGE)
  const rows = loaded.reduce(
    (total, message) =>
      total + 1 + message.parts.filter((part) => part.type === "text" || part.type === "reasoning" || part.type === "tool").length,
    0,
  )

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
    rows,
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
 * Gives every `every`-th bash call of the fixture an output of 30 lines. A tool whose output runs past six
 * lines shows its last line under the call and, under that, a hint that says how many are left out, and opens to
 * the whole of it when clicked or when `view.expand.toggle` is pressed; the bash parts of the default fixture
 * carry no output in their metadata and say so in the one line under the call, so nothing in it can be opened.
 * It edits the fixture in place; call it before mounting.
 */
export function expandableOutputs(fixture: PerfFixture, every: number): PerfFixture {
  const output = Array.from({ length: 30 }, (_, line) => `output line ${line}`).join("\n")
  const calls = fixture.parts.filter((part) => part.type === "tool" && part.tool === "bash")
  calls.forEach((part, ordinal) => {
    if (ordinal % every === 0 && part.type === "tool" && part.state.status === "completed") {
      part.state.metadata = { output }
    }
  })
  return fixture
}

/**
 * Puts a user message with one short text part in front of every `every`-th assistant message, so the
 * transcript has user rows to jump between (`session.message.next` and `session.message.previous`; the
 * default fixtures have none: the first message is not in the loaded page). Like `richTail` it edits the
 * fixture in place, before mounting. The session keeps its last `PAGE` messages and the users are among
 * them, so give the assistants enough parts (`partsPerMessage`) to keep the page above `WINDOW_MIN_ROWS`.
 */
export function withUserMessages(fixture: PerfFixture, every: number): PerfFixture {
  const messages: PerfFixture["messages"] = []
  let slot = 0
  for (const entry of fixture.messages) {
    if (entry.info.role === "assistant") {
      if (slot % every === 0) {
        const ordinal = slot / every
        const id = `msg_${fixture.session.id}_ask_${ordinal}`
        // Between the assistant before it and the one it precedes.
        const info = message(id, fixture.session.id, "user", slot + 1.5)
        const part: Part = {
          id: `prt_${fixture.session.id}_ask_${ordinal}`,
          sessionID: fixture.session.id,
          messageID: id,
          type: "text",
          text: `Question ${ordinal}: what does the session show here?`,
          time: { start: slot, end: slot + 1 },
        }
        messages.push({ info, parts: [part] })
      }
      slot++
    }
    messages.push(entry)
  }
  fixture.messages = messages
  fixture.rows = messages.slice(-PAGE).reduce((total, entry) => {
    if (entry.info.role === "user") return total + entry.parts.filter((part) => part.type === "text").length
    return (
      total +
      1 +
      entry.parts.filter((part) => part.type === "text" || part.type === "reasoning" || part.type === "tool").length
    )
  }, 0)
  return fixture
}

/**
 * The workflow `withRunningWorkflow` gives the root session, and what the status band says of it: four nodes in three
 * waves, two done, one running and one queued, the shape `test/shell/status-band.test.tsx` draws its band from.
 */
export const RUNNING_WORKFLOW = {
  id: "dag_alpha",
  title: "alpha",
  /** The wave the running node is in, of how many. */
  wave: { current: 2, total: 3 },
  running: 1,
} as const

/**
 * Gives the root session a running workflow, so the status band has a row to draw (#1620). Like `richTail` it edits
 * the fixture in place, before mounting: the summary and the node table are read when the session is entered.
 */
export function withRunningWorkflow(fixture: PerfFixture): PerfFixture {
  const { id } = RUNNING_WORKFLOW
  const node = (name: string, status: string, depends: string[] = []): DagNode => ({
    id: name,
    workflow_id: id,
    name,
    worker_type: "task",
    status,
    required: false,
    depends_on: depends,
    replan_attempts: 0,
  })
  fixture.dagSummaries = [
    {
      id,
      title: RUNNING_WORKFLOW.title,
      status: "running",
      graphRev: 1,
      nodeCount: 4,
      completedNodes: 2,
      runningNodes: RUNNING_WORKFLOW.running,
      failedNodes: 0,
      skippedNodes: 0,
      abortedNodes: 0,
      queuedNodes: 1,
      escalatedNodes: 0,
    },
  ]
  fixture.dagTables = {
    [id]: [
      node("a", "completed"),
      node("b", "completed"),
      node("c", "running", ["a", "b"]),
      node("d", "queued", ["c"]),
    ],
  }
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

/** A session the server updated, such as one whose DAG mode was switched (#1280). */
export function sessionUpdatedEvent(session: Session, id: string): GlobalEvent {
  return {
    directory,
    project: "proj_test",
    payload: { id, type: "session.updated", properties: { sessionID: session.id, info: session } },
  }
}

/** A session's goal as the server announces it (`goal.updated`): the status band draws a row from it (#1620). */
export function goalUpdatedEvent(sessionID: string, goal: Goal, id: string): GlobalEvent {
  return { directory, project: "proj_test", payload: { id, type: "goal.updated", properties: { sessionID, goal } } }
}

/** The new state of a PR watch (`pr.watch.updated`), which the PR tracker and the status band draw from (#1620). */
export function prWatchEvent(entry: PrWatchEntry, id: string): GlobalEvent {
  return { directory, project: "proj_test", payload: { id, type: "pr.watch.updated", properties: entry } }
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

/**
 * The session's DAG mode status for the footer indicator (#1280): on and
 * available, with no workflow running. The indicator reads it when the mode
 * turns on; leaving the request unanswered only logs a warning and the indicator
 * stays on its plain state, but the run should not carry that noise.
 */
const DAG_MODE_STATUS: SessionDagMode = {
  mode: "on",
  defaultMode: "off",
  availability: "available",
  unavailableReason: null,
  budget: { tokens: null, used: 0, usedCacheRead: 0, warnRatio: 0.8 },
  limits: {
    concurrency: 4,
    configuredConcurrency: null,
    maxTotalNodes: 100,
    configuredMaxTotalNodes: null,
    running: 0,
  },
  quality: null,
}

export function makeFetchFixture(fixture: PerfFixture, url: URL): Response | undefined {
  if (url.pathname === "/session") return Response.json(fixture.sessions)
  const session = fixture.sessions.find((item) => url.pathname === `/session/${item.id}`)
  if (session) return Response.json(session)
  if (url.pathname.endsWith("/dag-mode")) return Response.json(DAG_MODE_STATUS)
  const messages = fixture.sessions.find((item) => url.pathname === `/session/${item.id}/message`)
  if (messages) return Response.json(messages.id === SESSION_ID ? fixture.messages : [])
  if (url.pathname === "/project/directories") return Response.json([])
  if (url.pathname.endsWith("/todo") || url.pathname.endsWith("/diff") || url.pathname.endsWith("/goal"))
    return Response.json([])
  if (url.pathname === "/command")
    return Response.json([{ name: "mode", template: "mode", source: "command", hints: [] }])
  if (url.pathname.startsWith("/experimental/workspace")) return Response.json([])
  // What the status band reads (#1620): the root session's workflows and their node tables, its PR watches and its
  // reminders. A fixture that sets none of them answers with empty lists, which is what the reads got before.
  if (url.pathname === `/dag/session/${fixture.session.id}/summary`) return Response.json(fixture.dagSummaries ?? [])
  const table = url.pathname.match(/^\/dag\/([^/]+)\/nodes$/)
  if (table) return Response.json(fixture.dagTables?.[table[1]] ?? [])
  if (url.pathname === `/session/${fixture.session.id}/pr-watch`)
    return Response.json({ entries: fixture.prWatches ?? [] })
  if (url.pathname === `/session/${fixture.session.id}/reminder`)
    return Response.json({ entries: fixture.reminders ?? [] })
  if (url.pathname.startsWith("/dag/")) return Response.json([])
  if (url.pathname.endsWith("/status")) return Response.json({})
  if (url.pathname.startsWith("/project/")) return Response.json([])
  return undefined
}
