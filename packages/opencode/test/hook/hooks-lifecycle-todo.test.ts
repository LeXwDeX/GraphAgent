import { expect } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { cliIt } from "../lib/cli-process"

cliIt.live(
  "real Todo hook veto preserves list, returns tool feedback, and allows corrected and later completed tasks",
  ({ home, llm, opencode }) =>
    Effect.gen(function* () {
      const audit = path.join(home, "todo-audit.jsonl")
      const allow = path.join(home, "allow-completion")
      const script = path.join(home, "todo-hook.ts")
      yield* Effect.promise(async () => {
        await fs.writeFile(
          script,
          `const i=JSON.parse(await Bun.stdin.text());await Bun.write(${JSON.stringify(audit)},(await Bun.file(${JSON.stringify(audit)}).text().catch(()=>""))+JSON.stringify({...i,readable:await Bun.file(i.transcript_path).exists()})+"\\n");if(i.hook_event_name==='TaskCompleted'&&!await Bun.file(${JSON.stringify(allow)}).exists()){process.stderr.write('TASK_REQUIRES_REVIEW');process.exit(2)}else process.stdout.write(JSON.stringify({continue:false}));`,
        )
        const hook = { type: "command", command: process.execPath, args: [script] }
        await fs.writeFile(
          path.join(home, ".config/opencode/hooks.json"),
          JSON.stringify({ TaskCreated: [{ hooks: [hook] }], TaskCompleted: [{ hooks: [hook] }] }),
        )
      })
      const server = yield* opencode.serve()
      const request = (route: string, method: string, body?: object) =>
        Effect.promise(() =>
          fetch(server.url + route, {
            method,
            headers: { "content-type": "application/json", "x-opencode-directory": home },
            ...(body ? { body: JSON.stringify(body) } : {}),
          }),
        )
      const created = yield* request("/session", "POST", {})
      const session = yield* Effect.promise(() => created.json())
      const todo = (status: string) => ({ todos: [{ content: "TASK_STABLE_CONTENT", status, priority: "high" }] })
      yield* llm.tool("todowrite", todo("completed"))
      yield* llm.tool("todowrite", todo("pending"))
      yield* llm.text("CORRECTED_TASK_RECORDED")
      const prompt = () =>
        request(`/session/${session.id}/message`, "POST", {
          model: { providerID: "test", modelID: "test-model" },
          parts: [{ type: "text", text: "update local tasks" }],
        })
      const first = yield* prompt()
      expect(first.status).toBe(200)
      expect(yield* Effect.promise(() => first.text())).toContain("CORRECTED_TASK_RECORDED")
      const list = yield* request(`/session/${session.id}/todo`, "GET")
      expect(yield* Effect.promise(() => list.json())).toEqual(todo("pending").todos)
      expect((yield* llm.inputs).some((input) => JSON.stringify(input).includes("TASK_REQUIRES_REVIEW"))).toBe(true)
      yield* Effect.promise(() => fs.writeFile(allow, "allowed"))
      yield* llm.tool("todowrite", todo("completed"))
      yield* llm.text("TASK_COMPLETED")
      const second = yield* prompt()
      expect(second.status).toBe(200)
      expect(yield* Effect.promise(() => second.text())).toContain("TASK_COMPLETED")
      const rows = yield* Effect.promise(async () =>
        (await fs.readFile(audit, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)),
      )
      expect(rows.map((row) => row.hook_event_name)).toEqual([
        "TaskCreated",
        "TaskCompleted",
        "TaskCreated",
        "TaskCompleted",
      ])
      expect(new Set(rows.map((row) => row.task_id)).size).toBe(1)
      expect(
        rows.every(
          (row) =>
            row.task_subject === "TASK_STABLE_CONTENT" &&
            row.session_id === session.id &&
            row.readable &&
            row.task_description === undefined,
        ),
      ).toBe(true)
    }),
)
