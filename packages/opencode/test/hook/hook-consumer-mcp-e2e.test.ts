import { expect } from "bun:test"
import { Effect, Fiber } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { cliIt } from "../lib/cli-process"
import { pollWithTimeout } from "../lib/effect"

for (const { event, action } of [
  { event: "Elicitation", action: "accept" },
  { event: "ElicitationResult", action: "accept" },
  { event: "Elicitation", action: "decline" },
  { event: "Elicitation", action: "cancel" },
] as const)
  cliIt.live(
    `real stdio MCP ${event} ${action} response notifies and reaches the next model request`,
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const serverScript = path.join(home, "mcp-server.ts")
        const hookScript = path.join(home, "elicitation-hook.ts")
        const answerFile = path.join(home, "server-answer.json")
        const audit = path.join(home, "elicitation-audit.jsonl")
        yield* Effect.promise(async () => {
          await fs.writeFile(
            serverScript,
            `import {Server} from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/server"))};import {StdioServerTransport} from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/server/stdio"))};const server=new Server({name:"fixture",version:"0"},{capabilities:{tools:{}}});server.setRequestHandler("tools/list",async()=>({tools:[{name:"pick",description:"local synthetic choice",inputSchema:{type:"object",properties:{}}}]}));server.setRequestHandler("tools/call",async()=>{const answer=await server.elicitInput({message:"Pick a synthetic color",requestedSchema:{type:"object",properties:{color:{type:"string",enum:["red","blue","green"]}}}});await Bun.write(${JSON.stringify(answerFile)},JSON.stringify(answer));return {content:[{type:"text",text:"SERVER_"+answer.action+"_"+answer.content?.color}]}});process.stdin.on("end",()=>process.exit(0));await server.connect(new StdioServerTransport());`,
          )
          await fs.writeFile(
            hookScript,
            `const i=JSON.parse(await Bun.stdin.text());await Bun.write(${JSON.stringify(audit)},(await Bun.file(${JSON.stringify(audit)}).text().catch(()=>""))+JSON.stringify({event:i.hook_event_name,type:i.notification_type,session:i.session_id,server:i.mcp_server_name,path:i.transcript_path,transcript:await Bun.file(i.transcript_path).text()})+"\\n");if(i.hook_event_name===${JSON.stringify(event)})process.stdout.write(JSON.stringify({continue:false,systemMessage:"IGNORED_ELICITATION_MESSAGE",hookSpecificOutput:{hookEventName:i.hook_event_name,action:${JSON.stringify(action)},content:${action === "accept" ? JSON.stringify({ color: event === "Elicitation" ? "blue" : "green" }) : "undefined"}}}));`,
          )
          const handler = { type: "command", command: process.execPath, args: [hookScript] }
          await fs.writeFile(
            path.join(home, ".config/opencode/hooks.json"),
            JSON.stringify({
              Elicitation: [{ hooks: [handler] }],
              ElicitationResult: [{ hooks: [handler] }],
              Notification: [{ hooks: [handler] }],
            }),
          )
          await fs.writeFile(
            path.join(home, ".config/opencode/opencode.json"),
            JSON.stringify({
              mcp: { fixture: { type: "local", command: [process.execPath, serverScript], enabled: true } },
            }),
          )
        })
        yield* llm.tool("fixture_pick", {})
        yield* llm.text("MCP_SYNTHETIC_DONE")
        const server = yield* opencode.serve()
        const request = (route: string, method = "GET", body?: object) =>
          Effect.promise(() =>
            fetch(server.url + route, {
              method,
              headers: { "content-type": "application/json", "x-opencode-directory": home },
              ...(body ? { body: JSON.stringify(body) } : {}),
            }),
          )
        const created = yield* request("/session", "POST", {})
        expect(created.status).toBe(200)
        const session = yield* Effect.promise(() => created.json())
        const prompt = yield* request(`/session/${session.id}/message`, "POST", {
          agent: "build",
          model: { providerID: "test", modelID: "test-model" },
          parts: [{ type: "text", text: "MCP_SYNTHETIC_REQUEST" }],
        }).pipe(
          Effect.flatMap((response) => Effect.promise(() => response.text())),
          Effect.forkScoped,
        )
        if (event === "ElicitationResult") {
          const question = yield* pollWithTimeout(
            request("/question").pipe(
              Effect.flatMap((response) => Effect.promise(() => response.json())),
              Effect.map((items) => items.find((item: { sessionID: string }) => item.sessionID === session.id)),
            ),
            "actual MCP question must arrive",
          )
          const delayed = yield* pollWithTimeout(
            Effect.promise(async () => {
              const raw = await fs.readFile(audit, "utf8").catch(() => "")
              return raw.includes('"type":"elicitation_dialog"') ? true : undefined
            }),
            "pending MCP form must notify after six seconds",
            "10 seconds",
          )
          expect(delayed).toBe(true)
          const answered = yield* request(`/question/${question.id}/reply`, "POST", { answers: [["red"]] })
          expect(answered.status).toBe(200)
        }
        yield* Fiber.join(prompt)
        yield* llm.wait(2)
        const color = event === "Elicitation" ? "blue" : "green"
        expect(JSON.parse(yield* Effect.promise(() => fs.readFile(answerFile, "utf8")))).toEqual(
          action === "accept" ? { action, content: { color } } : { action },
        )
        expect(
          (yield* llm.inputs).some((input) =>
            JSON.stringify(input).includes(`SERVER_${action}_${action === "accept" ? color : "undefined"}`),
          ),
        ).toBe(true)
        const rows = (yield* Effect.promise(() => fs.readFile(audit, "utf8")))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
        expect(rows.map((row) => row.event)).toEqual(
          event === "Elicitation"
            ? ["Elicitation", "Notification"]
            : ["Elicitation", "Notification", "ElicitationResult", "Notification"],
        )
        expect(rows.filter((row) => row.type === "elicitation_response")).toHaveLength(1)
        for (const row of rows) {
          expect(row.session).toBe(session.id)
          if (row.event !== "Notification") expect(row.server).toBe("fixture")
          expect(row.transcript).toContain("MCP_SYNTHETIC_REQUEST")
        }
      }),
  )
