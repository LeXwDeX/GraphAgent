import { expect } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { pollWithTimeout } from "../lib/effect"
import { cliIt } from "../lib/cli-process"

for (const protocol of ["submit_result", "final_response"] as const)
  cliIt.live(`a real DAG child emits one scoped Stop after ${protocol} settlement`, ({ home, env, llm, opencode }) =>
    Effect.gen(function* () {
      const audit = path.join(home, "dag-hooks.jsonl")
      const script = path.join(home, "dag-hook.ts")
      const serverURL = path.join(home, "server-url.txt")
      yield* Effect.promise(async () => {
        await fs.writeFile(
          script,
          `
const i=JSON.parse(await Bun.stdin.text());
let nodeStatus;
if(i.hook_event_name==="SubagentStop") {
  const base=await Bun.file(${JSON.stringify(serverURL)}).text();
  const headers={"x-opencode-directory":${JSON.stringify(home)}};
  const workflows=await (await fetch(base+"/dag/session/"+i.session_id,{headers})).json();
  const nodes=await (await fetch(base+"/dag/"+workflows[0].id+"/nodes",{headers})).json();
  nodeStatus=nodes.find(n=>n.child_session_id===i.agent_id)?.status;
}
await (await import("node:fs/promises")).appendFile(${JSON.stringify(audit)},JSON.stringify({origin:process.argv[2],...i,nodeStatus,readable:await Bun.file(i.transcript_path).exists(),agentReadable:i.agent_transcript_path?await Bun.file(i.agent_transcript_path).exists():undefined})+"\\n");
if(i.hook_event_name==="SubagentStart") console.log(JSON.stringify({hookSpecificOutput:{hookEventName:i.hook_event_name,additionalContext:"DAG_START_GUIDANCE"}}));
if(i.hook_event_name==="SubagentStop" && process.argv[2]==="global" && !i.stop_hook_active) console.log(JSON.stringify({decision:"block",reason:"DAG_STOP_BLOCK",hookSpecificOutput:{hookEventName:i.hook_event_name,additionalContext:"DAG_STOP_CORRECTION"}}));
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
      if (protocol === "submit_result") {
        yield* llm.text("PREMATURE_DAG_REPORT")
        yield* llm.tool("submit_result", { payload: { summary: "FINAL_DAG_REPORT" } })
      }
      yield* llm.text("FINAL_DAG_REPORT")
      const server = yield* opencode.serve({
        env: {
          OPENCODE_CONFIG_CONTENT: JSON.stringify({
            ...JSON.parse(env.OPENCODE_CONFIG_CONTENT),
            permission: { "*": "allow" },
          }),
        },
      })
      yield* Effect.promise(() => fs.writeFile(serverURL, server.url))
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
          result_protocol: protocol,
          delivery_node: "worker",
          max_concurrency: 1,
          nodes: [
            {
              id: "worker",
              name: "Local worker",
              worker_type: "general",
              depends_on: [],
              required: true,
              ...(protocol === "submit_result"
                ? {
                    output_schema: {
                      type: "object",
                      required: ["summary"],
                      properties: { summary: { type: "string" } },
                    },
                  }
                : {}),
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
      const rows = yield* pollWithTimeout(
        Effect.promise(async () => {
          const rows = (await fs.readFile(audit, "utf8"))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line))
          const stopped = ["global", "agent"].every((origin) =>
            rows.some((row) => row.origin === origin && row.hook_event_name === "SubagentStop"),
          )
          return stopped ? rows : undefined
        }),
        "settled DAG attempt never emitted both scoped Stop notifications",
      )
      const global = rows.filter((row) => row.origin === "global")
      expect(global.map((row) => row.hook_event_name)).toEqual(["SubagentStart", "SubagentStop"])
      expect(global.map((row) => row.session_id)).toEqual([parent.id, parent.id])
      expect(new Set(global.map((row) => row.agent_id))).toEqual(new Set([nodes[0].child_session_id]))
      expect(global.filter((row) => row.hook_event_name === "SubagentStop").map((row) => row.stop_hook_active)).toEqual(
        [false],
      )
      expect(
        global
          .filter((row) => row.hook_event_name === "SubagentStop")
          .every((row) => Array.isArray(row.background_tasks)),
      ).toBe(true)
      expect(
        global
          .filter((row) => row.hook_event_name === "SubagentStop")
          .every((row) => Array.isArray(row.session_crons) && row.session_crons.length === 0),
      ).toBe(true)
      expect(rows.filter((row) => row.origin === "agent").map((row) => row.hook_event_name)).toEqual(["SubagentStop"])
      expect(rows.every((row) => row.readable)).toBe(true)
      expect(global.filter((row) => row.hook_event_name === "SubagentStop").every((row) => row.agentReadable)).toBe(
        true,
      )
      const calls = yield* llm.inputs
      const childCalls = calls.filter((call) => JSON.stringify(call.messages).includes("Produce the report."))
      expect(childCalls.length).toBe(protocol === "submit_result" ? 3 : 1)
      expect(JSON.stringify(childCalls[0]).includes("DAG_START_GUIDANCE")).toBe(true)
      if (protocol === "submit_result")
        expect(JSON.stringify(childCalls[1])).toContain("without calling the submit_result tool")
      expect(JSON.stringify(calls)).not.toContain("DAG_STOP_CORRECTION")
      expect(global.find((row) => row.hook_event_name === "SubagentStop")).toMatchObject({
        last_assistant_message: "FINAL_DAG_REPORT",
        nodeStatus: "completed",
      })
      expect(
        calls.every(
          (call) =>
            !Object.hasOwn(call, "hooks") && !Object.hasOwn(call, "hookOrigin") && !Object.hasOwn(call, "hookSource"),
        ),
      ).toBe(true)
      const childMessages = yield* pollWithTimeout(
        request(`/session/${nodes[0].child_session_id}/message`).pipe(
          Effect.map((messages) => (JSON.stringify(messages).includes("DAG_STOP_CORRECTION") ? messages : undefined)),
        ),
        "DAG Stop feedback was not retained in the child transcript",
      )
      expect(JSON.stringify(childMessages)).toContain("FINAL_DAG_REPORT")
    }),
  )
