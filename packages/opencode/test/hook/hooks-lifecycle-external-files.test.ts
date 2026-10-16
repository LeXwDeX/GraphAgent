import { expect } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { cliIt } from "../lib/cli-process"
import { pollWithTimeout } from "../lib/effect"
cliIt.live(
  "SessionStart watchPaths route an external filesystem write to its real owning session",
  ({ home, opencode }) =>
    Effect.gen(function* () {
      const script = path.join(home, "watch-hook.ts")
      const audit = path.join(home, "watch-audit.jsonl")
      yield* Effect.promise(async () => {
        await fs.writeFile(
          path.join(home, ".config/opencode/opencode.json"),
          JSON.stringify({ hookPermissions: { mode: "acceptEdits" } }),
        )
        await fs.writeFile(
          script,
          `const i=JSON.parse(await Bun.stdin.text());if(i.hook_event_name==="SessionStart")process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"SessionStart",watchPaths:[${JSON.stringify(home)}+"/watch-"+i.session_id+".txt"]}}));else await Bun.write(${JSON.stringify(audit)},(await Bun.file(${JSON.stringify(audit)}).text().catch(()=>""))+JSON.stringify({session:i.session_id,event:i.hook_event_name,mode:i.permission_mode,path:i.file_path,readable:await Bun.file(i.transcript_path).exists()})+"\\n");`,
        )
        const entry = { type: "command", command: process.execPath, args: [script] }
        await fs.writeFile(
          path.join(home, ".config/opencode/hooks.json"),
          JSON.stringify({ SessionStart: [{ hooks: [entry] }], FileChanged: [{ hooks: [entry] }] }),
        )
      })
      const server = yield* opencode.serve()
      const create = Effect.promise(async () => {
        const response = await fetch(server.url + "/session", {
          method: "POST",
          headers: { "content-type": "application/json", "x-opencode-directory": home },
          body: "{}",
        })
        return response.json()
      })
      const first = yield* create
      const second = yield* create
      const file = path.join(home, `watch-${first.id}.txt`)
      yield* Effect.promise(() => fs.writeFile(file, "external content"))
      const rows = yield* pollWithTimeout(
        Effect.promise(async () => {
          const text = await fs.readFile(audit, "utf8").catch(() => "")
          return text.trim()
            ? text
                .trim()
                .split("\n")
                .map((line) => JSON.parse(line))
            : undefined
        }),
        "external file hook was never observed",
        "10 seconds",
      )
      expect(rows.every((row) => row.session === first.id && row.session !== second.id)).toBe(true)
      expect(rows[0]).toMatchObject({ event: "FileChanged", mode: "acceptEdits", path: file, readable: true })
    }),
)
