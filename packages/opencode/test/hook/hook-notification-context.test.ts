import { expect } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { cliIt } from "../lib/cli-process"
import { pollWithTimeout } from "../lib/effect"

cliIt.live(
  "hook context has readable transcripts and attention routes validate sessions; pending idle shutdown is bounded",
  ({ home, llm, opencode }) =>
    Effect.gen(function* () {
      const audit = path.join(home, "plan-context.jsonl")
      const hook = path.join(home, "plan-context-hook.ts")
      yield* Effect.promise(async () => {
        await fs.writeFile(
          path.join(home, ".config/graphagent/graphagent.json"),
          JSON.stringify({
            providers: {
              test: {
                api: {
                  type: "aisdk",
                  package: "@ai-sdk/openai-compatible",
                  url: llm.url,
                  settings: { apiKey: "fixture" },
                },
                models: { "test-model": {} },
              },
            },
          }),
        )
        await fs.writeFile(
          hook,
          `const i=JSON.parse(await Bun.stdin.text());await Bun.write(${JSON.stringify(audit)},(await Bun.file(${JSON.stringify(audit)}).text().catch(()=>""))+JSON.stringify({event:i.hook_event_name,mode:i.permission_mode,agent:i.agent_type,path:i.transcript_path,readable:await Bun.file(i.transcript_path).exists()})+"\\n")`,
        )
        const command = { type: "command", command: process.execPath, args: [hook] }
        await fs.writeFile(
          path.join(home, ".config/graphagent/hooks.json"),
          JSON.stringify({ UserPromptSubmit: [{ hooks: [command] }], Stop: [{ hooks: [command] }] }),
        )
      })
      const server = yield* opencode.host()
      const post = (route: string, body: object) =>
        Effect.promise(() =>
          fetch(server.url + route, {
            method: "POST",
            headers: { "content-type": "application/json", "x-opencode-directory": home },
            body: JSON.stringify(body),
          }),
        )
      const created = yield* post("/session", {
        agent: "plan",
        model: { providerID: "test", id: "test-model" },
      })
      expect(created.status).toBe(200)
      const session = yield* Effect.promise(() => created.json())
      expect(
        (yield* post(`/session/${session.id}/attention`, {
          clientID: "terminal-fixture",
          clientType: "terminal",
          backgroundView: true,
        })).status,
      ).toBe(200)
      yield* llm.text("PLAN_CONTEXT_DONE")
      expect(
        (yield* post(`/session/${session.id}/message`, {
          agent: "plan",
          model: { providerID: "test", modelID: "test-model" },
          parts: [{ type: "text", text: "Synthetic plan request" }],
        })).status,
      ).toBe(200)
      const rows = yield* pollWithTimeout(
        Effect.promise(async () => {
          const raw = await fs.readFile(audit, "utf8").catch(() => "")
          const rows = raw.trim()
            ? raw
                .trim()
                .split("\n")
                .map((line) => JSON.parse(line))
            : []
          return rows.some((row) => row.event === "Stop") ? rows : undefined
        }),
        "real plan hooks did not complete",
        "10 seconds",
      )
      expect(
        rows
          .filter((row) => row.event === "UserPromptSubmit" || row.event === "Stop")
          .map((row) => ({ event: row.event, readable: row.readable })),
      ).toEqual([
        { event: "UserPromptSubmit", readable: true },
        { event: "Stop", readable: true },
      ])
      expect(
        (yield* post(`/session/${session.id}/attention`, {
          clientID: "terminal-fixture",
          clientType: "terminal",
          closed: true,
        })).status,
      ).toBe(200)
      yield* pollWithTimeout(
        Effect.promise(async () => {
          const response = await fetch(server.url + "/session/status", { headers: { "x-opencode-directory": home } })
          const statuses = await response.json()
          return statuses[session.id] === undefined ? true : undefined
        }),
        "completed drain did not become idle",
        "5 seconds",
      )
      server.kill()
      yield* Effect.promise(() => server.exited).pipe(Effect.timeout("3 seconds"))
    }),
)
