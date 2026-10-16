import { expect } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { cliIt } from "../lib/cli-process"
import { pollWithTimeout } from "../lib/effect"

for (const scenario of ["write", "bash", "write-deny", "bash-deny"] as const) {
  const toolName = scenario.startsWith("bash") ? "bash" : "write"
  const denied = scenario.endsWith("-deny")
  cliIt.live(`V2 actual ${scenario} rewrites full input and preserves native permission`, ({ home, llm, opencode }) =>
    Effect.gen(function* () {
      const replacement =
        toolName === "write"
          ? { path: "approved.txt", content: "approved" }
          : { command: "printf approved >> approved.txt" }
      const audit = path.join(home, "permission-events")
      const script = path.join(home, "permission-hook.ts")
      yield* Effect.promise(async () => {
        await fs.writeFile(
          path.join(home, ".config/opencode/opencode.json"),
          JSON.stringify({
            ...(denied
              ? {
                  agents: {
                    build: {
                      permissions: [
                        { action: toolName === "write" ? "edit" : "bash", resource: "*approved*", effect: "deny" },
                      ],
                    },
                  },
                }
              : {}),
            providers: {
              test: {
                api: {
                  type: "aisdk",
                  package: "@ai-sdk/openai-compatible",
                  url: llm.url,
                  settings: { apiKey: "test-key" },
                },
                models: { "test-model": {} },
              },
            },
          }),
        )
        await fs.writeFile(
          script,
          `const i=JSON.parse(await Bun.stdin.text());await Bun.write(${JSON.stringify(audit)},(await Bun.file(${JSON.stringify(audit)}).text().catch(()=>""))+JSON.stringify({event:i.hook_event_name,input:i.tool_input})+"\\n");process.stdout.write(JSON.stringify(i.hook_event_name==="PreToolUse"?{hookSpecificOutput:{hookEventName:i.hook_event_name,permissionDecision:"ask"}}:i.hook_event_name==="PermissionRequest"?{hookSpecificOutput:{hookEventName:i.hook_event_name,decision:{behavior:"allow",updatedInput:${JSON.stringify(replacement)},updatedPermissions:[{type:"addRules",destination:"userSettings",behavior:"allow",rules:[{toolName:"fixture_persisted"}]}]}}}:{}));`,
        )
        const hooks = [{ hooks: [{ type: "command", command: process.execPath, args: [script] }] }]
        await fs.writeFile(
          path.join(home, ".config/opencode/hooks.json"),
          JSON.stringify({
            PreToolUse: hooks,
            PermissionRequest: hooks,
            PostToolUse: hooks,
            PostToolUseFailure: hooks,
          }),
        )
      })
      yield* llm.tool(
        toolName,
        toolName === "write"
          ? { path: "original.txt", content: "original" }
          : { command: "printf original >> original.txt" },
      )
      yield* llm.text("V2_DONE")
      const server = yield* opencode.serve()
      const request = (route: string, method = "GET", body?: object) =>
        Effect.promise(() =>
          fetch(server.url + route, {
            method,
            headers: { "content-type": "application/json", "x-opencode-directory": home },
            ...(body ? { body: JSON.stringify(body) } : {}),
          }),
        )
      const created = yield* request("/api/session", "POST", {
        location: { directory: home },
        model: { providerID: "test", id: "test-model" },
      })
      expect(created.status).toBe(200)
      const id = (yield* Effect.promise(() => created.json())).data.id
      const admitted = yield* request(`/api/session/${id}/prompt`, "POST", {
        prompt: { text: "V2_WRITE_FIXTURE" },
        resume: true,
      })
      expect(admitted.status).toBe(200)
      yield* Effect.promise(() => admitted.text())
      if (denied) {
        yield* pollWithTimeout(
          Effect.gen(function* () {
            if ((yield* llm.calls) >= 2) return true
            const response = yield* request(`/api/session/${id}/permission`)
            const pending = yield* Effect.promise(() => response.json())
            for (const permission of pending.data ?? [])
              yield* request(`/api/session/${id}/permission/${permission.id}/reply`, "POST", { reply: "once" })
            return undefined
          }),
          "rewritten native deny must settle without executing",
        )
        expect(yield* Effect.promise(() => Bun.file(path.join(home, "original.txt")).exists())).toBe(false)
        expect(yield* Effect.promise(() => Bun.file(path.join(home, "approved.txt")).exists())).toBe(false)
        const rows = yield* Effect.promise(async () =>
          (await fs.readFile(audit, "utf8"))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line)),
        )
        expect(rows.filter((row) => row.event === "PreToolUse")).toHaveLength(1)
        expect(rows.filter((row) => row.event === "PermissionRequest").length).toBeGreaterThanOrEqual(1)
        expect(rows.filter((row) => row.event === "PostToolUse" || row.event === "PostToolUseFailure")).toHaveLength(0)
        return
      }
      const permission = yield* pollWithTimeout(
        request(`/api/session/${id}/permission`).pipe(
          Effect.flatMap((response) => Effect.promise(() => response.json())),
          Effect.map((response) => response.data?.[0]),
        ),
        "missing real V2 permission",
      ).pipe(
        Effect.catch(() =>
          Effect.gen(function* () {
            const response = yield* request(`/api/session/${id}`)
            const status = yield* Effect.promise(() => response.json())
            const contextResponse = yield* request(`/api/session/${id}/context`)
            const context = yield* Effect.promise(() => contextResponse.json())
            const logs = yield* Effect.promise(async () => {
              const dir = path.join(home, ".local/share/opencode/log")
              return Promise.all(
                (await fs.readdir(dir).catch(() => [])).map(async (name) =>
                  (await fs.readFile(path.join(dir, name), "utf8"))
                    .split("\n")
                    .filter((line) => line.includes("Failed to drain") || line.includes("ERROR"))
                    .join("\n"),
                ),
              )
            })
            return yield* Effect.fail(
              new Error(
                JSON.stringify({
                  reason: "missing real V2 permission",
                  calls: yield* llm.calls,
                  status,
                  context,
                  logs,
                }),
              ),
            )
          }),
        ),
      )
      expect(permission.action).toBeDefined()
      const approved = yield* request(`/api/session/${id}/permission/${permission.id}/reply`, "POST", {
        reply: "once",
      })
      expect(approved.status).toBe(204)
      yield* llm.wait(2)
      const persisted = JSON.parse(
        yield* Effect.promise(() => fs.readFile(path.join(home, ".config/opencode/opencode.json"), "utf8")),
      )
      expect(persisted.providers.test.api.url).toBe(llm.url)
      expect(persisted.permission).toBeUndefined()
      expect(persisted.permissions).toContainEqual({ action: "fixture_persisted", resource: "*", effect: "allow" })
      expect(yield* Effect.promise(() => fs.readFile(path.join(home, "approved.txt"), "utf8"))).toBe("approved")
      expect(yield* Effect.promise(() => Bun.file(path.join(home, "original.txt")).exists())).toBe(false)
      const rows = yield* Effect.promise(async () =>
        (await fs.readFile(audit, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)),
      )
      expect(rows.filter((row) => row.event === "PreToolUse")).toHaveLength(1)
      expect(rows.filter((row) => row.event === "PostToolUse")).toHaveLength(1)
      expect(rows.filter((row) => row.event === "PermissionRequest")).toHaveLength(2)
    }),
  )
}
