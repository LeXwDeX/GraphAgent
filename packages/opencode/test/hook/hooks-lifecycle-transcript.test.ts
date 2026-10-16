import { expect, test } from "bun:test"
import { Effect } from "effect"
import { NodeFileSystem } from "@effect/platform-node"
import path from "node:path"
import { HookTranscript } from "@/hook/transcript"
import { tmpdir } from "../fixture/fixture"
import { SessionID, MessageID } from "@/session/schema"

test("a command reads real session JSONL and child snapshots stay separate", async () => {
  await using tmp = await tmpdir()
  const parent = SessionID.descending()
  const child = SessionID.descending()
  const write = (sessionID: typeof parent, text: string) =>
    Effect.runPromise(
      HookTranscript.materialize({
        sessionID,
        directory: tmp.path,
        root: path.join(tmp.path, "transcripts"),
        messages: [
          {
            info: { id: MessageID.ascending(), sessionID, role: "user", time: { created: 1234 } },
            parts: [{ type: "text", text }],
          },
        ],
      }).pipe(Effect.provide(NodeFileSystem.layer)),
    )
  const parentPath = await write(parent, "parent-private-message")
  const childPath = await write(child, "child-real-message")
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
  expect(await new Response(proc.stdout).text()).toBe("child-real-message")
  expect(await new Response(proc.stderr).text()).toBe("")
  expect(await proc.exited).toBe(0)
  const rows = (await Bun.file(parentPath).text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
  expect(rows[0]).toMatchObject({
    sessionId: parent,
    type: "user",
    cwd: tmp.path,
    timestamp: "1970-01-01T00:00:01.234Z",
  })
})
