import { expect } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { cliIt } from "../lib/cli-process"
import { decodeJsonRecord, decodeRecords, decodeV2Context, decodeV2Session } from "../lib/hook-json"

cliIt.live(
  "V2 provider turns enforce task creation and completion hooks before durable todo changes",
  ({ home, llm, opencode }) =>
    Effect.gen(function* () {
      const audit = path.join(home, "todo-hook-audit.jsonl")
      const policy = path.join(home, "todo-hook-policy.txt")
      const script = path.join(home, "todo-hook.ts")
      yield* Effect.promise(async () => {
        await fs.writeFile(
          path.join(home, ".config/opencode/opencode.json"),
          JSON.stringify({
            providers: {
              test: {
                name: "Test",
                api: {
                  type: "aisdk",
                  package: "@ai-sdk/openai-compatible",
                  url: llm.url,
                  settings: { apiKey: "test-key" },
                },
                request: { body: { apiKey: "test-key" } },
                models: {
                  "test-model": {
                    name: "Test Model",
                    capabilities: { tools: true, input: ["text"], output: ["text"] },
                    limit: { context: 100_000, output: 10_000 },
                    cost: { input: 0, output: 0 },
                  },
                },
              },
            },
          }),
        )
        await fs.writeFile(
          script,
          `
const input = JSON.parse(await Bun.stdin.text());
const audit = ${JSON.stringify(audit)};
const mode = await Bun.file(${JSON.stringify(policy)}).text();
const row = { event: input.hook_event_name, id: input.task_id, session: input.session_id, readable: await Bun.file(input.transcript_path).exists(), mode };
await Bun.write(audit, (await Bun.file(audit).text().catch(() => "")) + JSON.stringify(row) + "\\n");
if (mode === "block-create" && input.hook_event_name === "TaskCreated") process.stdout.write(JSON.stringify({ decision: "block", reason: "TASK_CREATE_VETO" }));
if (mode === "block-complete" && input.hook_event_name === "TaskCompleted") { process.stderr.write("TASK_COMPLETE_VETO"); process.exit(2); }
`,
        )
        const handler = { type: "command", command: process.execPath, args: [script] }
        await fs.writeFile(
          path.join(home, ".config/opencode/hooks.json"),
          JSON.stringify({
            TaskCreated: [{ hooks: [handler] }],
            TaskCompleted: [{ hooks: [handler] }],
          }),
        )
      })
      const server = yield* opencode.serve()
      const headers = { "content-type": "application/json", "x-opencode-directory": home }
      const request = (route: string, method = "GET", body?: object) =>
        Effect.promise(() =>
          fetch(server.url + route, {
            method,
            headers,
            ...(body ? { body: JSON.stringify(body) } : {}),
          }),
        )
      const created = yield* request("/api/session", "POST", {
        location: { directory: home },
        model: { providerID: "test", id: "test-model" },
      })
      expect(created.status).toBe(200)
      const id = decodeV2Session(yield* Effect.promise(() => created.json())).data.id
      const pending = [{ content: "Track a V2 task", status: "pending", priority: "high" }]
      const completed = [{ ...pending[0], status: "completed" }]
      const stages = [
        { mode: "block-create", input: pending, expected: [], reason: "TASK_CREATE_VETO" },
        { mode: "allow-create", input: pending, expected: pending },
        { mode: "block-complete", input: completed, expected: pending, reason: "TASK_COMPLETE_VETO" },
        { mode: "allow-complete", input: completed, expected: completed },
      ]
      for (const stage of stages) {
        yield* Effect.promise(() => fs.writeFile(policy, stage.mode))
        yield* llm.tool("todowrite", { todos: stage.input })
        yield* llm.text(`Finished ${stage.mode}`)
        const response = yield* request(`/api/session/${id}/prompt`, "POST", {
          prompt: { text: stage.mode },
          resume: true,
        })
        expect(response.status).toBe(200)
        const context = yield* Effect.promise(async () => {
          const deadline = Date.now() + 5_000
          while (Date.now() < deadline) {
            const response = await fetch(server.url + `/api/session/${id}/context`, { headers })
            expect(response.status).toBe(200)
            const data = decodeV2Context(await response.json()).data
            if (JSON.stringify(data).includes(`Finished ${stage.mode}`)) return data
            await Bun.sleep(25)
          }
          throw new Error(`V2 todo stage did not finish: ${stage.mode}; ${server.stderrTail()}`)
        })
        if (stage.reason) expect(JSON.stringify(context)).toContain(stage.reason)
        const todos = yield* request(`/session/${id}/todo`)
        expect(todos.status).toBe(200)
        expect(decodeRecords(yield* Effect.promise(() => todos.json()))).toEqual(stage.expected)
        const inputs = (yield* llm.inputs).filter(
          (input) => !JSON.stringify(input).includes("Generate a title for this conversation"),
        )
        if (stage.reason) expect(JSON.stringify(inputs.at(-1))).toContain(stage.reason)
      }
      const rows = yield* Effect.promise(async () =>
        (await fs.readFile(audit, "utf8")).trim().split("\n").map(decodeJsonRecord),
      )
      expect(rows.map((row) => [row.event, row.mode])).toEqual([
        ["TaskCreated", "block-create"],
        ["TaskCreated", "allow-create"],
        ["TaskCompleted", "block-complete"],
        ["TaskCompleted", "allow-complete"],
      ])
      expect(rows.every((row) => row.session === id && row.readable === true)).toBe(true)
      expect(typeof rows[0]?.id).toBe("string")
      expect(new Set(rows.map((row) => row.id)).size).toBe(1)
      expect(
        (yield* llm.inputs).filter(
          (input) => !JSON.stringify(input).includes("Generate a title for this conversation"),
        ),
      ).toHaveLength(8)
    }),
)
