import { expect } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { cliIt } from "../lib/cli-process"
import { decodeRecord, decodeRecords, decodeSession } from "../lib/hook-json"

// Task and DAG runtimes feed their own child session; that is delegation, not a user submission. A real client that
// submits to the same child session is a user submission and still runs, and can block on, UserPromptSubmit.
const fixture = (name: string, subagentStopOnce: boolean) =>
  cliIt.live(name, ({ home, llm, opencode }) =>
    Effect.gen(function* () {
      const audit = path.join(home, "ups-audit.jsonl")
      const marker = path.join(home, "stop-once")
      const script = path.join(home, "ups-hook.ts")
      yield* Effect.promise(async () => {
        await fs.writeFile(
          script,
          `const i=JSON.parse(await Bun.stdin.text());const fs=await import('node:fs/promises');if(i.hook_event_name==='UserPromptSubmit'){await fs.appendFile(${JSON.stringify(audit)},JSON.stringify({session:i.session_id,prompt:i.prompt})+'\\n');if(String(i.prompt).includes('BLOCK_ME'))process.stdout.write(JSON.stringify({decision:'block',reason:'user blocked'}))}else if(i.hook_event_name==='SubagentStop'&&!(await Bun.file(${JSON.stringify(marker)}).exists())){await fs.writeFile(${JSON.stringify(marker)},'1');process.stdout.write(JSON.stringify({decision:'block',reason:'CHILD_CONTINUE'}))}`,
        )
        const hook = { type: "command", command: process.execPath, args: [script] }
        await fs.writeFile(
          path.join(home, ".config/opencode/hooks.json"),
          JSON.stringify({
            UserPromptSubmit: [{ hooks: [hook] }],
            ...(subagentStopOnce ? { SubagentStop: [{ hooks: [hook] }] } : {}),
          }),
        )
        const directory = path.join(home, ".config/opencode/agent")
        await fs.mkdir(directory, { recursive: true })
        await fs.writeFile(
          path.join(directory, "delegate_child.md"),
          `---\n${JSON.stringify({ mode: "subagent", description: "delegation fixture" })}\n---\nRespond once.`,
        )
      })
      yield* llm.tool("task", { description: "Delegate", prompt: "respond once", subagent_type: "delegate_child" })
      yield* llm.text("CHILD_FIRST")
      if (subagentStopOnce) yield* llm.text("CHILD_AFTER_CONTINUE")
      yield* llm.text("PARENT_DONE")
      const server = yield* opencode.serve()
      const post = (route: string, body: object) =>
        Effect.promise(() =>
          fetch(server.url + route, {
            method: "POST",
            headers: { "content-type": "application/json", "x-opencode-directory": home },
            body: JSON.stringify(body),
          }),
        )
      const created = yield* post("/session", { permission: [{ permission: "*", pattern: "*", action: "allow" }] })
      const parent = decodeSession(yield* Effect.promise(() => created.json())).id
      const response = yield* post(`/session/${parent}/message`, {
        model: { providerID: "test", modelID: "test-model" },
        parts: [{ type: "text", text: "delegate to the child" }],
      })
      expect(response.status).toBe(200)
      yield* Effect.promise(() => response.text())
      const rows = () =>
        Effect.promise(async () =>
          (await fs.readFile(audit, "utf8"))
            .trim()
            .split("\n")
            .map((line) => decodeRecord(JSON.parse(line))),
        )
      // Only the user's prompt to the parent: the task runtime's initial and continuation prompts are delegation.
      expect(yield* rows()).toEqual([{ session: parent, prompt: "delegate to the child" }])
      const children = decodeRecords(
        yield* Effect.promise(async () =>
          (
            await fetch(server.url + `/session/${parent}/children`, { headers: { "x-opencode-directory": home } })
          ).json(),
        ),
      )
      expect(children).toHaveLength(1)
      const child = String(children[0].id)
      // The delegated continuation really ran: its text reached the child's model request.
      if (subagentStopOnce) expect(JSON.stringify(yield* llm.inputs)).toContain("CHILD_CONTINUE")
      const calls = yield* llm.calls
      yield* llm.text("CHILD_USER_FOLLOWUP")
      const blocked = yield* post(`/session/${child}/message`, {
        model: { providerID: "test", modelID: "test-model" },
        parts: [{ type: "text", text: "BLOCK_ME please" }],
      })
      expect(blocked.status).toBe(200)
      expect(JSON.stringify(yield* Effect.promise(() => blocked.json()))).toContain("[Hook stopped] user blocked")
      expect(yield* llm.calls).toBe(calls)
      expect((yield* rows()).map((row) => row.session)).toEqual([parent, child])
    }),
  )

fixture(
  "a task child's initial prompt skips UserPromptSubmit while a real client prompt to it still runs and blocks",
  false,
)
fixture("a task child's Stop continuation skips UserPromptSubmit", true)

import { Schema } from "effect"
import { it } from "bun:test"

it("a persisted hook followup keeps the optional delegation flag and old records default to user input", async () => {
  const { HookPendingInput } = await import("@/session/prompt")
  const base = {
    version: 1,
    messageID: "msg_01a147764acboHHZIDPSoyXijM",
    phase: "pending",
    input: { kind: "prompt", agent: "build", parts: [{ type: "text", text: "followup" }] },
  }
  const decode = Schema.decodeUnknownSync(HookPendingInput)
  expect(decode(base).internalDelegation).toBeUndefined()
  expect(decode({ ...base, internalDelegation: true }).internalDelegation).toBe(true)
  // The flag is not accepted inside the public followup body.
  expect(Object.keys(decode({ ...base, input: { ...base.input, internalDelegation: true } }).input)).not.toContain(
    "internalDelegation",
  )
})

// UserPromptSubmit carries session_title only for a title a user or hook chose, never for a generated one.
cliIt.live("UserPromptSubmit session_title appears only for a real custom title", ({ home, llm, opencode }) =>
  Effect.gen(function* () {
    const audit = path.join(home, "title-audit.jsonl")
    const script = path.join(home, "title-hook.ts")
    yield* Effect.promise(async () => {
      await fs.writeFile(
        script,
        `const i=JSON.parse(await Bun.stdin.text());await (await import('node:fs/promises')).appendFile(${JSON.stringify(audit)},JSON.stringify({session:i.session_id,title:i.session_title,has:Object.hasOwn(i,'session_title')})+'\\n')`,
      )
      await fs.writeFile(
        path.join(home, ".config/opencode/hooks.json"),
        JSON.stringify({
          UserPromptSubmit: [{ hooks: [{ type: "command", command: process.execPath, args: [script] }] }],
        }),
      )
    })
    yield* llm.text("TITLED_DONE")
    yield* llm.text("UNTITLED_DONE")
    const server = yield* opencode.serve()
    const post = (route: string, body: object) =>
      Effect.promise(() =>
        fetch(server.url + route, {
          method: "POST",
          headers: { "content-type": "application/json", "x-opencode-directory": home },
          body: JSON.stringify(body),
        }),
      )
    const ids: string[] = []
    for (const body of [{ title: "My chosen title" }, {}]) {
      const created = yield* post("/session", body)
      const id = decodeSession(yield* Effect.promise(() => created.json())).id
      ids.push(id)
      const response = yield* post(`/session/${id}/message`, {
        model: { providerID: "test", modelID: "test-model" },
        parts: [{ type: "text", text: "hello" }],
      })
      expect(response.status).toBe(200)
      yield* Effect.promise(() => response.text())
    }
    const rows = (yield* Effect.promise(() => fs.readFile(audit, "utf8")))
      .trim()
      .split("\n")
      .map((line) => decodeRecord(JSON.parse(line)))
    expect(rows).toEqual([
      { session: ids[0], title: "My chosen title", has: true },
      { session: ids[1], has: false },
    ])
  }),
)
