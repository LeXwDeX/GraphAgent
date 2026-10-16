import { expect } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { cliIt } from "../lib/cli-process"
import { pollWithTimeout } from "../lib/effect"

for (const kind of ["prompt", "command"] as const) {
  cliIt.live(
    `explicit V1 cancel fences a claimed ${kind} followup waiting in a real command hook`,
    ({ home, opencode, llm }) =>
      Effect.gen(function* () {
        const ready = path.join(home, "claimed-followup-ready")
        const release = path.join(home, "claimed-followup-release")
        const script = path.join(home, "claimed-followup-hook.ts")
        const marker = path.join(home, "cancelled-command-side-effect.txt")
        yield* Effect.promise(async () => {
          await fs.writeFile(
            script,
            `const i=JSON.parse(await Bun.stdin.text());if(i.hook_event_name==='SessionStart')process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'SessionStart',initialUserMessage:'INITIAL_BEFORE_CLAIM'}}));if((i.hook_event_name==='UserPromptSubmit'&&i.prompt==='CLAIMED_CANCELLED_FOLLOWUP')||(i.hook_event_name==='UserPromptExpansion'&&i.command_name==='cancelprobe')){await Bun.write(${JSON.stringify(ready)},'ready');while(!await Bun.file(${JSON.stringify(release)}).exists())await Bun.sleep(20);process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:i.hook_event_name,additionalContext:'CLAIMED_CANCELLED_CONTEXT'}}));}`,
          )
          const hook = { type: "command", command: process.execPath, args: [script], timeout: 20 }
          await fs.writeFile(
            path.join(home, ".config/opencode/hooks.json"),
            JSON.stringify({
              SessionStart: [{ hooks: [hook] }],
              UserPromptSubmit: [{ hooks: [hook] }],
              UserPromptExpansion: [{ hooks: [hook] }],
            }),
          )
          await fs.writeFile(
            path.join(home, ".config/opencode/opencode.json"),
            JSON.stringify({
              command: {
                cancelprobe: { template: 'CLAIMED_CANCELLED_COMMAND !`echo side-effect > "' + marker + '"`' },
              },
            }),
          )
        })
        yield* llm.text("INITIAL_BEFORE_CLAIM_DONE")
        yield* llm.text("NEXT_ALLOWED_TURN_RESPONSE")
        const server = yield* opencode.serve()
        const request = (route: string, body?: object) =>
          fetch(server.url + route, {
            method: body ? "POST" : "GET",
            headers: { "content-type": "application/json", "x-opencode-directory": home },
            ...(body ? { body: JSON.stringify(body) } : {}),
          })
        const chat = yield* Effect.promise(async () =>
          (await request("/session", { title: "Claimed followup cancellation regression" })).json(),
        )
        const pending = request(`/session/${chat.id}/resume`, {
          model: { providerID: "test", modelID: "test-model" },
          initialOnly: true,
          hookMode: "noninteractive",
          followup:
            kind === "prompt"
              ? { kind: "prompt", parts: [{ type: "text", text: "CLAIMED_CANCELLED_FOLLOWUP" }] }
              : { kind: "command", command: "cancelprobe", arguments: "" },
        })
        yield* pollWithTimeout(
          Effect.promise(async () => ((await Bun.file(ready).exists()) ? true : undefined)),
          "claimed followup did not enter real UPS hook",
          10000,
        )
        const claimed = yield* Effect.promise(async () => (await request(`/session/${chat.id}`)).json())
        expect(claimed.metadata?.hookPendingInput?.phase).toBe("started")
        const cancelled = yield* Effect.promise(async () => {
          try {
            return await Promise.race([
              request(`/session/${chat.id}/abort`, {}),
              new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 1500)),
            ])
          } finally {
            await fs.writeFile(release, "release")
          }
        })
        expect(cancelled?.status).toBe(200)
        expect((yield* Effect.promise(() => pending)).status).toBe(200)
        const history = yield* Effect.promise(async () => (await request(`/session/${chat.id}/message`)).json())
        expect(JSON.stringify(history)).not.toContain("CLAIMED_CANCELLED_FOLLOWUP")
        expect(JSON.stringify(history)).not.toContain("CLAIMED_CANCELLED_CONTEXT")
        expect(JSON.stringify(history)).not.toContain("CLAIMED_CANCELLED_COMMAND")
        expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(false)
        expect(yield* llm.calls).toBe(1)
        const current = yield* Effect.promise(async () => (await request(`/session/${chat.id}`)).json())
        expect(current.metadata?.hookPendingInput).toBeUndefined()
        const fresh = yield* Effect.promise(() =>
          request(`/session/${chat.id}/message`, {
            model: { providerID: "test", modelID: "test-model" },
            parts: [{ type: "text", text: "NEW_AFTER_CLAIM_CANCEL" }],
          }),
        )
        expect(fresh.status).toBe(200)
        const freshMessage = yield* Effect.promise(() => fresh.json())
        expect(JSON.stringify(freshMessage)).toContain("NEXT_ALLOWED_TURN_RESPONSE")
        expect(yield* llm.calls).toBe(2)
        expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(false)
      }),
  )
}
