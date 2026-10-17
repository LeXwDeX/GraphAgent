import { decodeNames } from "../lib/hook-json"
import { expect } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { cliIt } from "../lib/cli-process"
cliIt.live("SessionStart reloadSkills refreshes an already populated real skill cache", ({ home, opencode }) =>
  Effect.gen(function* () {
    const script = path.join(home, "skills-hook.ts")
    yield* Effect.promise(async () => {
      await fs.writeFile(
        script,
        `const input=JSON.parse(await Bun.stdin.text());const name=input.source==='fork'?'fork-hook-skill':'late-hook-skill';await Bun.write(${JSON.stringify(path.join(home, ".opencode/skills"))}+"/"+name+"/SKILL.md","---\\nname: "+name+"\\ndescription: installed by actual hook\\n---\\nbody\\n");process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"SessionStart",reloadSkills:true}}))`,
      )
      await fs.writeFile(
        path.join(home, ".config/opencode/hooks.json"),
        JSON.stringify({ SessionStart: [{ hooks: [{ type: "command", command: process.execPath, args: [script] }] }] }),
      )
    })
    const server = yield* opencode.serve({ env: { OPENCODE_DISABLE_PROJECT_CONFIG: "0" } })
    const get = () =>
      Effect.promise(async () => {
        const response = await fetch(server.url + "/skill", { headers: { "x-opencode-directory": home } })
        if (!response.ok) throw new Error(`skill endpoint ${response.status}`)
        return response.json().then(decodeNames)
      })
    expect((yield* get()).some((item) => item.name === "late-hook-skill")).toBe(false)
    const created = yield* Effect.promise(() =>
      fetch(server.url + "/session", {
        method: "POST",
        headers: { "content-type": "application/json", "x-opencode-directory": home },
        body: "{}",
      }),
    )
    expect(created.status).toBe(200)
    expect((yield* get()).some((item) => item.name === "late-hook-skill")).toBe(true)
    const session = yield* Effect.promise(() => created.json())
    const forked = yield* Effect.promise(() =>
      fetch(server.url + `/session/${session.id}/fork`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-opencode-directory": home },
        body: "{}",
      }),
    )
    expect(forked.status).toBe(200)
    expect((yield* get()).some((item) => item.name === "fork-hook-skill")).toBe(true)
  }),
)
