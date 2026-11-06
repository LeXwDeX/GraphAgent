import type { GlobalEvent, Message, Part, Session } from "@opencode-ai/sdk/v2"
import { directory } from "../fixture/tui-sdk"

export const SESSION_ID = "ses_perf_main"
export const BACKGROUND_COUNT = 8

export type FixtureSize = "S" | "M" | "L"

export type PerfFixture = {
  size: FixtureSize
  session: Session
  sessions: Session[]
  messages: Array<{ info: Message; parts: Part[] }>
  parts: Part[]
  backgroundParts: Part[]
  streamPart: Part
}

const PART_COUNTS: Record<FixtureSize, number> = { S: 25, M: 100, L: 400 }

function text(index: number, size: FixtureSize) {
  const suffix = size === "L" && index % 11 === 0 ? `\n\n${"long context ".repeat(420)}` : ""
  return `Deterministic answer ${index}: inspect the rendered session and keep the output stable.${suffix}`
}

function toolOutput(index: number, size: FixtureSize) {
  const body = `tool output ${index}\n${"result line ".repeat(size === "L" ? 120 : 18)}`
  return body.slice(0, size === "L" && index % 9 === 0 ? 10_000 : 2_000)
}

function message(id: string, sessionID: string, role: "user" | "assistant", created: number, parentID?: string): Message {
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

function partFor(index: number, sessionID: string, messageID: string, size: FixtureSize): Part {
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

export function createFixture(size: FixtureSize, withBackground = false): PerfFixture {
  const session = makeSession(SESSION_ID, `Performance ${size}`)
  const user = message(`${SESSION_ID}_user`, SESSION_ID, "user", 1)
  const messages: Array<{ info: Message; parts: Part[] }> = [{ info: user, parts: [] }]
  const parts: Part[] = []
  let previous = user.id
  for (let index = 0; index < PART_COUNTS[size]; index++) {
    const info = message(`msg_${SESSION_ID}_${index}`, SESSION_ID, "assistant", index + 2, previous)
    const part = partFor(index, SESSION_ID, info.id, size)
    messages.push({ info, parts: [part] })
    parts.push(part)
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
    streamPart: parts.find((part) => part.type === "text") ?? parts[0],
  }
}

export function updatePartEvent(part: Part, time: number, id: string): GlobalEvent {
  return {
    directory,
    project: "proj_test",
    payload: { id, type: "message.part.updated", properties: { sessionID: part.sessionID, time, part } },
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
  if (url.pathname === `/session/${SESSION_ID}`) return Response.json(fixture.session)
  if (url.pathname === `/session/${SESSION_ID}/message`) return Response.json(fixture.messages)
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
