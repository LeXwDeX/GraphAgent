import { expect } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { cliIt } from "../lib/cli-process"

cliIt.live(
  "a real DAG child runs scoped lifecycle hooks and consumes Stop feedback before delivery",
  ({ home, env, llm, opencode }) =>
    Effect.gen(function* () {
      const audit = path.join(home, "dag-hooks.jsonl")
      const script = path.join(home, "dag-hook.ts")
      yield* Effect.promise(async () => {
        await fs.writeFile(
          script,
          `
const i=JSON.parse(await Bun.stdin.text());
await (await import("node:fs/promises")).appendFile(${JSON.stringify(audit)},JSON.stringify({origin:process.argv[2],...i,readable:await Bun.file(i.transcript_path).exists(),agentReadable:i.agent_transcript_path?await Bun.file(i.agent_transcript_path).exists():undefined})+"\\n");
if(i.hook_event_name==="SubagentStart") console.log(JSON.stringify({hookSpecificOutput:{hookEventName:i.hook_event_name,additionalContext:"DAG_START_GUIDANCE"}}));
if(i.hook_event_name==="SubagentStop" && process.argv[2]==="global" && !i.stop_hook_active) console.log(JSON.stringify({hookSpecificOutput:{hookEventName:i.hook_event_name,additionalContext:"DAG_STOP_CORRECTION"}}));
`,
        )
        const handler = { type: "command", command: process.execPath, args: [script, "global"] }
        await fs.writeFile(
          path.join(home, ".config/opencode/hooks.json"),
          JSON.stringify(
            Object.fromEntries(
              ["SubagentStart", "SubagentStop", "TaskCreated", "TaskCompleted"].map((event) => [
                event,
                [{ hooks: [handler] }],
              ]),
            ),
          ),
        )
        const directory = path.join(home, ".config/opencode/agent")
        await fs.mkdir(directory, { recursive: true })
        await fs.writeFile(
          path.join(directory, "general.md"),
          `---\n${JSON.stringify({ mode: "subagent", description: "DAG lifecycle fixture", hooks: { Stop: [{ hooks: [{ type: "command", command: process.execPath, args: [script, "agent"] }] }] } })}\n---\nComplete the task.`,
        )
      })
      yield* llm.text("PREMATURE_DAG_REPORT")
      yield* llm.text("FINAL_DAG_REPORT")
      const server = yield* opencode.serve({
        env: {
          OPENCODE_CONFIG_CONTENT: JSON.stringify({
            ...JSON.parse(env.OPENCODE_CONFIG_CONTENT),
            permission: { "*": "allow" },
          }),
        },
      })
      const request = (route: string, body?: object) =>
        Effect.promise(async () => {
          const response = await fetch(server.url + route, {
            method: body ? "POST" : "GET",
            headers: { "content-type": "application/json", "x-opencode-directory": home },
            ...(body ? { body: JSON.stringify(body) } : {}),
          })
          if (!response.ok) throw new Error(`${route}: ${response.status} ${await response.text()}`)
          return response.json()
        })
      const parent = yield* request("/session", {
        title: "DAG Hooks",
        model: { providerID: "test", id: "test-model" },
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      const workflow = yield* request("/dag", {
        session_id: parent.id,
        title: "Hook lifecycle",
        config: {
          name: "hook-lifecycle",
          result_protocol: "final_response",
          delivery_node: "worker",
          max_concurrency: 1,
          nodes: [
            {
              id: "worker",
              name: "Local worker",
              worker_type: "general",
              depends_on: [],
              required: true,
              prompt_template: { inline: "Produce the report." },
            },
          ],
        },
      })
      let detail: any
      const deadline = Date.now() + 10_000
      do {
        detail = yield* request(`/dag/${workflow.id}`)
        if (["completed", "failed", "cancelled"].includes(detail.status)) break
        yield* Effect.sleep("50 millis")
      } while (Date.now() < deadline)
      const nodes = yield* request(`/dag/${workflow.id}/nodes`)
      expect({ status: detail.status, errors: nodes.map((node: any) => node.error_reason ?? null) }).toEqual({
        status: "completed",
        errors: [null],
      })
      const rows = (yield* Effect.promise(() => fs.readFile(audit, "utf8")))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
      const global = rows.filter((row) => row.origin === "global")
      expect(global.map((row) => row.hook_event_name)).toEqual(["SubagentStart", "SubagentStop", "SubagentStop"])
      expect(global.map((row) => row.session_id)).toEqual([parent.id, parent.id, parent.id])
      expect(new Set(global.map((row) => row.agent_id))).toEqual(new Set([nodes[0].child_session_id]))
      expect(global.filter((row) => row.hook_event_name === "SubagentStop").map((row) => row.stop_hook_active)).toEqual(
        [false, true],
      )
      expect(
        global
          .filter((row) => row.hook_event_name === "SubagentStop")
          .every((row) =>
            row.background_tasks.some(
              (task: { id: string; type: string; status: string }) =>
                task.id === workflow.id && task.type === "workflow" && task.status === "running",
            ),
          ),
      ).toBe(true)
      expect(
        global
          .filter((row) => row.hook_event_name === "SubagentStop")
          .every((row) => Array.isArray(row.session_crons) && row.session_crons.length === 0),
      ).toBe(true)
      expect(rows.filter((row) => row.origin === "agent").map((row) => row.hook_event_name)).toEqual([
        "SubagentStop",
        "SubagentStop",
      ])
      expect(rows.every((row) => row.readable)).toBe(true)
      expect(global.filter((row) => row.hook_event_name === "SubagentStop").every((row) => row.agentReadable)).toBe(
        true,
      )
      const calls = yield* llm.inputs
      expect(calls.length).toBe(2)
      expect(JSON.stringify(calls[0]).includes("DAG_START_GUIDANCE")).toBe(true)
      expect(JSON.stringify(calls[1]).includes("DAG_STOP_CORRECTION")).toBe(true)
      expect(
        calls.every(
          (call) =>
            !Object.hasOwn(call, "hooks") && !Object.hasOwn(call, "hookOrigin") && !Object.hasOwn(call, "hookSource"),
        ),
      ).toBe(true)
      const childMessages = yield* request(`/session/${nodes[0].child_session_id}/message`)
      expect(JSON.stringify(childMessages)).toContain("FINAL_DAG_REPORT")
    }),
)
