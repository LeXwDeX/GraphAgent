import { expect, test } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { LocalPermissionStartup } from "@/permission/local-startup"
import { cliIt } from "../lib/cli-process"

test("local startup identity is single-use, target-bound and cannot survive a Request clone", async () => {
  const original = new Request("http://localhost/session", { method: "POST" })
  expect(LocalPermissionStartup.take(original)).toBe(false)
  LocalPermissionStartup.mark(original)
  expect(LocalPermissionStartup.take(original.clone())).toBe(false)
  expect(LocalPermissionStartup.take(original)).toBe(true)
  expect(LocalPermissionStartup.take(original)).toBe(false)
  LocalPermissionStartup.mark(original, "session-a")
  expect(LocalPermissionStartup.take(original, "session-b")).toBe(false)
  expect(LocalPermissionStartup.take(original, "session-a")).toBe(true)
  const grants: string[] = []
  const grant = LocalPermissionStartup.once((id) =>
    Effect.sync(() => {
      grants.push(id)
    }),
  )
  await Effect.runPromise(grant("selected"))
  await Effect.runPromise(grant("nested"))
  expect(grants).toEqual(["selected"])
})

for (const authorized of [false, true])
  cliIt.live(
    `actual local CLI ${authorized ? "explicit flag" : "no flag"} gates hook bypass`,
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const audit = path.join(home, "startup-permissions")
        const script = path.join(home, "startup-permission.ts")
        yield* Effect.promise(async () => {
          await fs.writeFile(
            script,
            `const i=JSON.parse(await Bun.stdin.text());await Bun.write(${JSON.stringify(audit)},(await Bun.file(${JSON.stringify(audit)}).text().catch(()=>""))+i.session_id+"\\n");process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"PermissionRequest",decision:{behavior:"allow",updatedPermissions:[{type:"setMode",mode:"bypassPermissions",destination:"session"}]}}}));`,
          )
          await fs.writeFile(
            path.join(home, ".config/opencode/hooks.json"),
            JSON.stringify({
              PermissionRequest: [{ hooks: [{ type: "command", command: process.execPath, args: [script] }] }],
            }),
          )
        })
        yield* llm.tool("bash", { command: "printf first", description: "first synthetic call" })
        yield* llm.tool("bash", { command: "printf second", description: "second synthetic call" })
        yield* llm.text("STARTUP_CAPABILITY_DONE")
        const result = yield* opencode.run("Exercise startup capability", {
          format: "json",
          permission: { "*": "ask" },
          env: { OPENCODE_DB: path.join(home, "startup-persistent.sqlite") },
          extraArgs: authorized ? ["--dangerously-skip-permissions"] : [],
        })
        expect(result.exitCode).toBe(0)
        expect(result.stdout).toContain("STARTUP_CAPABILITY_DONE")
        const calls = (yield* Effect.promise(() => fs.readFile(audit, "utf8"))).trim().split("\n")
        expect(calls).toHaveLength(authorized ? 1 : 2)
        expect(new Set(calls).size).toBe(1)
        if (authorized) {
          yield* llm.tool("bash", { command: "printf resumed-first", description: "resumed synthetic call" })
          yield* llm.tool("bash", { command: "printf resumed-second", description: "resumed second synthetic call" })
          yield* llm.text("RESUMED_CAPABILITY_DONE")
          const resumed = yield* opencode.run("Resume startup capability", {
            format: "json",
            permission: { "*": "ask" },
            env: { OPENCODE_DB: path.join(home, "startup-persistent.sqlite") },
            extraArgs: ["--session", calls[0], "--dangerously-skip-permissions"],
          })
          if (resumed.exitCode !== 0)
            throw new Error(
              JSON.stringify({ exitCode: resumed.exitCode, stdout: resumed.stdout, stderr: resumed.stderr }),
            )
          expect(resumed.exitCode).toBe(0)
          expect(resumed.stdout).toContain("RESUMED_CAPABILITY_DONE")
          expect((yield* Effect.promise(() => fs.readFile(audit, "utf8"))).trim().split("\n")).toEqual([
            calls[0],
            calls[0],
          ])
        }
      }),
  )

cliIt.live("explicit local CLI capability applies to the first resumed deferred tool", ({ home, llm, opencode }) =>
  Effect.gen(function* () {
    const allowed = path.join(home, "allow-deferred")
    const audit = path.join(home, "deferred-startup.jsonl")
    const script = path.join(home, "deferred-startup.ts")
    yield* Effect.promise(async () => {
      await fs.writeFile(
        script,
        `const i=JSON.parse(await Bun.stdin.text());await Bun.write(${JSON.stringify(audit)},(await Bun.file(${JSON.stringify(audit)}).text().catch(()=>""))+JSON.stringify({event:i.hook_event_name,session:i.session_id,id:i.tool_use_id})+"\\n");if(i.hook_event_name==="PreToolUse"&&!await Bun.file(${JSON.stringify(allowed)}).exists())process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"defer"}}));if(i.hook_event_name==="PermissionRequest")process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"PermissionRequest",decision:{behavior:"allow",updatedPermissions:[{type:"setMode",mode:"bypassPermissions",destination:"session"}]}}}));`,
      )
      const handler = { type: "command", command: process.execPath, args: [script] }
      await fs.writeFile(
        path.join(home, ".config/opencode/hooks.json"),
        JSON.stringify({ PreToolUse: [{ hooks: [handler] }], PermissionRequest: [{ hooks: [handler] }] }),
      )
    })
    const opts = {
      format: "json" as const,
      permission: { "*": "ask" as const },
      env: { OPENCODE_DB: path.join(home, "deferred-startup.sqlite") },
    }
    yield* llm.tool("bash", { command: "printf deferred-first", description: "first deferred synthetic tool" })
    const deferred = yield* opencode.run("Create a deferred tool", opts)
    expect(deferred.exitCode).toBe(0)
    expect(deferred.stdout).toContain('"stop_reason":"tool_deferred"')
    const original = JSON.parse((yield* Effect.promise(() => fs.readFile(audit, "utf8"))).trim().split("\n")[0])
    yield* Effect.promise(() => fs.writeFile(allowed, "yes"))
    yield* llm.tool("bash", { command: "printf deferred-second", description: "second synthetic tool" })
    yield* llm.text("DEFERRED_RESUME_DONE")
    const resumed = yield* opencode.run("", {
      ...opts,
      extraArgs: ["--session", original.session, "--dangerously-skip-permissions"],
    })
    if (resumed.exitCode !== 0) throw new Error(JSON.stringify({ stdout: resumed.stdout, stderr: resumed.stderr }))
    expect(resumed.exitCode).toBe(0)
    expect(resumed.stdout).toContain("DEFERRED_RESUME_DONE")
    const rows = (yield* Effect.promise(() => fs.readFile(audit, "utf8")))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    expect(rows.filter((row) => row.event === "PermissionRequest")).toHaveLength(1)
    expect(
      rows
        .filter((row) => row.event === "PreToolUse")
        .slice(0, 2)
        .map((row) => row.id),
    ).toEqual([original.id, original.id])
  }),
)
