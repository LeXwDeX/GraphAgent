import { expect } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { cliIt } from "../lib/cli-process"
import { pollWithTimeout } from "../lib/effect"

for (const version of ["v1", "v2"] as const)
  cliIt.live(`SessionStart exports reach ${version} model Bash and command hooks`, ({ home, llm, opencode }) =>
    Effect.gen(function* () {
      const hook = path.join(home, "environment-hook.ts"),
        output = path.join(home, "bash-output"),
        audit = path.join(home, "pre-env")
      yield* Effect.promise(async () => {
        await fs.writeFile(
          hook,
          `const i=JSON.parse(await Bun.stdin.text());if(i.hook_event_name==='SessionStart')await Bun.write(process.env.CLAUDE_ENV_FILE,"export HOOK_SESSION_VALUE='from-session'\\nunset HOME\\n");if(i.hook_event_name==='PreToolUse'){await Bun.write(${JSON.stringify(audit)},JSON.stringify({value:process.env.HOOK_SESSION_VALUE,home:process.env.HOME}));process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'allow'}}));}`,
        )
        const handler = [{ hooks: [{ type: "command", command: process.execPath, args: [hook] }] }]
        await fs.writeFile(
          path.join(home, ".config/opencode/hooks.json"),
          JSON.stringify({ SessionStart: handler, PreToolUse: handler }),
        )
        await fs.writeFile(
          path.join(home, ".config/opencode/opencode.json"),
          JSON.stringify({
            shell: "/bin/sh",
            permission: { bash: "allow" },
            agents: { build: { permissions: [{ action: "bash", resource: "*", effect: "allow" }] } },
            provider: {
              test: {
                npm: "@ai-sdk/openai-compatible",
                options: { baseURL: llm.url, apiKey: "fixture" },
                models: { "test-model": { name: "test" } },
              },
            },
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
      })
      yield* llm.tool("bash", {
        description: "Synthetic export validation",
        command: `printf '%s:%s' "$HOOK_SESSION_VALUE" "\${HOME-unset}" > '${output}'`,
      })
      yield* llm.text("DONE")
      const server = yield* opencode.serve()
      const post = (route: string, body: object) =>
        Effect.promise(() =>
          fetch(server.url + route, {
            method: "POST",
            headers: { "content-type": "application/json", "x-opencode-directory": home },
            body: JSON.stringify(body),
          }),
        )
      const response = yield* post(
        version === "v1" ? "/session" : "/api/session",
        version === "v1" ? {} : { location: { directory: home }, model: { providerID: "test", id: "test-model" } },
      )
      expect(response.status).toBe(200)
      const created = yield* Effect.promise(() => response.json())
      const id = version === "v1" ? created.id : created.data.id
      const prompt = yield* post(
        `${version === "v1" ? "/session" : "/api/session"}/${id}/${version === "v1" ? "message" : "prompt"}`,
        version === "v1"
          ? {
              model: { providerID: "test", modelID: "test-model" },
              parts: [{ type: "text", text: "Run the synthetic bash command" }],
            }
          : { prompt: { text: "Run the synthetic bash command" }, resume: true },
      )
      expect(prompt.status).toBe(200)
      const value = yield* pollWithTimeout(
        Effect.promise(() => fs.readFile(output, "utf8").catch(() => undefined)),
        "model bash did not write export proof",
        "10 seconds",
      )
      expect(value).toBe("from-session:unset")
      expect(JSON.parse(yield* Effect.promise(() => fs.readFile(audit, "utf8")))).toEqual({ value: "from-session" })
    }),
  )

cliIt.live("explicit shell preserves plugin PATH with no hooks configured", ({ home, opencode }) =>
  Effect.gen(function* () {
    const plugin = path.join(home, "shell-plugin.ts"),
      output = path.join(home, "plugin-path")
    yield* Effect.promise(async () => {
      await fs.writeFile(
        plugin,
        `export default async () => ({"shell.env": async (_input, output) => {output.env.PATH="/task-plugin/bin:"+process.env.PATH}})`,
      )
      await fs.writeFile(
        path.join(home, ".config/opencode/opencode.json"),
        JSON.stringify({ plugin: ["file://" + plugin], shell: "/bin/sh", permission: { bash: "allow" } }),
      )
    })
    const server = yield* opencode.serve({ env: { OPENCODE_PURE: "0" } })
    const post = (route: string, body: object) =>
      Effect.promise(() =>
        fetch(server.url + route, {
          method: "POST",
          headers: { "content-type": "application/json", "x-opencode-directory": home },
          body: JSON.stringify(body),
        }),
      )
    const created = yield* post("/session", {})
    const session = yield* Effect.promise(() => created.json())
    const response = yield* post(`/session/${session.id}/shell`, {
      agent: "build",
      model: { providerID: "test", modelID: "test-model" },
      command: `printf '%s' "$PATH" > '${output}'`,
    })
    expect(response.status).toBe(200)
    expect(yield* Effect.promise(() => fs.readFile(output, "utf8"))).toStartWith("/task-plugin/bin:")
  }),
)
