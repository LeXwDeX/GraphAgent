import { expect } from "bun:test"
import { Effect } from "effect"
import path from "node:path"
import { ModelV2 } from "@graphagent/core/model"
import { ProviderV2 } from "@graphagent/core/provider"
import { AppLayer } from "@/effect/app-runtime"
import { HookTranscript } from "@/hook/transcript"
import { Session } from "@/session/session"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { testEffect } from "../lib/effect"
import { TestInstance } from "../fixture/fixture"

// D1 PR3: the engine materializes from persisted rows instead of a caller-passed
// message array, so this test seeds a real session and asks for the file only.
const it = testEffect(AppLayer)

const seed = (sessionID: SessionID, created: number, text: string) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const messageID = MessageID.ascending()
    yield* sessions.updateMessage({
      id: messageID,
      sessionID,
      role: "user",
      time: { created },
      agent: "build",
      model: { providerID: ProviderV2.ID.make("fixture"), modelID: ModelV2.ID.make("fixture") },
    })
    yield* sessions.updatePart({
      id: PartID.ascending(),
      sessionID,
      messageID,
      type: "text",
      text,
    })
  })

it.instance("a command reads real session JSONL and child snapshots stay separate", () =>
  Effect.gen(function* () {
    const { directory } = yield* TestInstance
    const sessions = yield* Session.Service
    const parent = yield* sessions.create({})
    const child = yield* sessions.create({})
    yield* seed(parent.id, 1234, "parent-private-message")
    yield* seed(child.id, 1234, "child-real-message")
    const write = (sessionID: SessionID) =>
      HookTranscript.materialize({
        sessionID,
        directory,
        root: path.join(directory, "transcripts"),
      })
    const parentPath = yield* write(parent.id)
    const childPath = yield* write(child.id)
    HookTranscript.clearCursor(parent.id)
    HookTranscript.clearCursor(child.id)
    expect(parentPath).not.toBe(childPath)
    const proc = Bun.spawn(
      [
        process.execPath,
        "-e",
        "const s=await Bun.file(process.argv[1]).text();const rows=s.trim().split('\\n').map((line) => JSON.parse(line));process.stdout.write(rows[0].message.content[0].text)",
        childPath,
      ],
      { stdout: "pipe", stderr: "pipe" },
    )
    expect(yield* Effect.promise(() => new Response(proc.stdout).text())).toBe("child-real-message")
    expect(yield* Effect.promise(() => new Response(proc.stderr).text())).toBe("")
    expect(yield* Effect.promise(() => proc.exited)).toBe(0)
    const rows = (yield* Effect.promise(() => Bun.file(parentPath).text()))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    expect(rows[0]).toMatchObject({
      sessionId: parent.id,
      type: "user",
      cwd: directory,
      timestamp: "1970-01-01T00:00:01.234Z",
    })
  }),
)
