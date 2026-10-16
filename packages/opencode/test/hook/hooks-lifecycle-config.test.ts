import { expect } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { cliIt } from "../lib/cli-process"
cliIt.live(
  "a real session ConfigChange hook veto prevents HTTP config write and cache disposal",
  ({ home, opencode }) =>
    Effect.gen(function* () {
      const script = path.join(home, "config-hook.ts")
      const audit = path.join(home, "config-audit.json")
      yield* Effect.promise(async () => {
        await fs.writeFile(
          path.join(home, ".config/opencode/opencode.json"),
          JSON.stringify({ hookPermissions: { mode: "acceptEdits" } }),
        )
        await fs.writeFile(
          script,
          `const input=JSON.parse(await Bun.stdin.text());await Bun.write(${JSON.stringify(audit)},JSON.stringify({event:input.hook_event_name,mode:input.permission_mode,source:input.source,session:input.session_id,readable:await Bun.file(input.transcript_path).exists()}));process.stdout.write(JSON.stringify({decision:"block",reason:"fixture rejects config update"}));`,
        )
        await fs.writeFile(
          path.join(home, ".config/opencode/hooks.json"),
          JSON.stringify({
            ConfigChange: [{ hooks: [{ type: "command", command: process.execPath, args: [script] }] }],
          }),
        )
      })
      const server = yield* opencode.serve()
      const request = (route: string, method: string, body: object) =>
        Effect.promise(() =>
          fetch(server.url + route, {
            method,
            headers: { "content-type": "application/json", "x-opencode-directory": home },
            body: JSON.stringify(body),
          }),
        )
      const created = yield* request("/session", "POST", {})
      expect(created.status).toBe(200)
      const session = yield* Effect.promise(() => created.json())
      for (const [route, source, filename] of [
        ["/config", "project_settings", path.join(home, "config.json")],
        ["/global/config", "user_settings", path.join(home, ".config/opencode/opencode.json")],
      ] as const) {
        const before = yield* Effect.promise(() => fs.readFile(filename, "utf8").catch(() => undefined))
        const result = yield* request(route, "PATCH", { username: "must-not-be-written" })
        expect(result.status).toBe(400)
        expect(yield* Effect.promise(() => fs.readFile(filename, "utf8").catch(() => undefined))).toBe(before)
        const recorded = yield* Effect.promise(async () => JSON.parse(await fs.readFile(audit, "utf8")))
        expect(recorded).toMatchObject({
          event: "ConfigChange",
          mode: "acceptEdits",
          source,
          session: session.id,
          readable: true,
        })
      }
    }),
)
