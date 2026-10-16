import { expect } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { pollWithTimeout } from "../lib/effect"
import { cliIt } from "../lib/cli-process"

cliIt.live(
  "real session fork and eager instruction hooks have distinct sessions and readable transcripts",
  ({ home, env, llm, opencode }) =>
    Effect.gen(function* () {
      const audit = path.join(home, "session-audit.jsonl")
      const script = path.join(home, "session-hook.ts")
      yield* Effect.promise(async () => {
        await fs.writeFile(path.join(home, "AGENTS.md"), "LOCAL_INSTRUCTION_CONTENT")
        await fs.writeFile(
          script,
          `const i=JSON.parse(await Bun.stdin.text());await Bun.write(${JSON.stringify(audit)},(await Bun.file(${JSON.stringify(audit)}).text().catch(()=>""))+JSON.stringify({...i,transcript:await Bun.file(i.transcript_path).text()})+"\\n");if(i.hook_event_name==='SessionStart')process.stdout.write(JSON.stringify({systemMessage:'FORK_USER_NOTIFICATION'}));`,
        )
        const hook = { type: "command", command: process.execPath, args: [script] }
        await fs.writeFile(
          path.join(home, ".config/opencode/hooks.json"),
          JSON.stringify({
            SessionStart: [{ matcher: "fork", hooks: [hook] }],
            InstructionsLoaded: [{ matcher: "session_start", hooks: [hook] }],
          }),
        )
      })
      const cfg = JSON.parse(env.OPENCODE_CONFIG_CONTENT)
      cfg.provider.test.models.alias = {
        ...cfg.provider.test.models["test-model"],
        id: "test-model",
        cost: { input: 1, output: 5, cache_write: 2 },
      }
      const server = yield* opencode.serve({
        env: { OPENCODE_DISABLE_PROJECT_CONFIG: "0", OPENCODE_CONFIG_CONTENT: JSON.stringify(cfg) },
      })
      const post = (route: string, body: object) =>
        Effect.promise(() =>
          fetch(server.url + route, {
            method: "POST",
            headers: { "content-type": "application/json", "x-opencode-directory": home },
            body: JSON.stringify(body),
          }),
        )
      const created = yield* post("/session", {})
      const parent = yield* Effect.promise(() => created.json())
      yield* llm.text("FORK_PARENT_REAL_ANSWER", { usage: { input: 100, output: 20 } })
      const prompted = yield* post(`/session/${parent.id}/message`, {
        model: { providerID: "test", modelID: "alias" },
        parts: [{ type: "text", text: "FORK_PARENT_REAL_USER" }],
      })
      expect(prompted.status).toBe(200)
      yield* Effect.promise(() => prompted.text())
      const controller = new AbortController()
      yield* Effect.addFinalizer(() => Effect.sync(() => controller.abort()))
      const notifications: { type: string; properties?: { sessionID?: string; message?: string } }[] = []
      const stream = yield* Effect.promise(() =>
        fetch(server.url + "/event", {
          headers: { "x-opencode-directory": home },
          signal: controller.signal,
        }),
      )
      const reading = (async () => {
        const reader = stream.body!.getReader()
        const decoder = new TextDecoder()
        let buffered = ""
        try {
          while (true) {
            const chunk = await reader.read()
            if (chunk.done) break
            buffered += decoder.decode(chunk.value, { stream: true })
            const lines = buffered.split("\n")
            buffered = lines.pop()!
            for (const line of lines) if (line.startsWith("data:")) notifications.push(JSON.parse(line.slice(5)))
          }
        } catch (error) {
          if (!controller.signal.aborted) throw error
        } finally {
          reader.releaseLock()
        }
      })()
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          controller.abort()
          await reading
        }),
      )
      const forked = yield* post(`/session/${parent.id}/fork`, {})
      expect(forked.status).toBe(200)
      const child = yield* Effect.promise(() => forked.json())
      const notification = yield* pollWithTimeout(
        Effect.sync(() =>
          notifications.find(
            (event) =>
              event.type === "session.hook.message" &&
              event.properties?.sessionID === child.id &&
              event.properties?.message === "FORK_USER_NOTIFICATION",
          ),
        ),
        "fork hook notification did not reach the user event stream",
        "3 seconds",
      )
      expect(notification.properties?.sessionID).not.toBe(parent.id)
      const rows = yield* Effect.promise(async () =>
        (await fs.readFile(audit, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)),
      )
      const instruction = rows.find((row) => row.hook_event_name === "InstructionsLoaded")
      expect(instruction).toMatchObject({ session_id: parent.id, load_reason: "session_start" })
      expect(instruction.transcript).toContain("FORK_PARENT_REAL_USER")
      const fork = rows.find((row) => row.hook_event_name === "SessionStart")
      expect(fork).toMatchObject({
        session_id: child.id,
        source: "fork",
        model: "test-model",
        agent_type: "build",
        context_tokens: 120,
        prompt_cache_likely_expired: false,
      })
      expect(fork.session_title).toBeUndefined()
      expect(fork.seconds_since_last_response).toBeGreaterThanOrEqual(0)
      expect(fork.prompt_cache_warm).toBeUndefined()
      expect(fork.estimated_cache_write_usd).toBeCloseTo((120 * 2) / 1_000_000)
      expect(child.id).not.toBe(parent.id)
      expect(fork.transcript).toContain("FORK_PARENT_REAL_ANSWER")
      expect(fork.transcript).not.toContain(parent.id)
    }),
)

cliIt.live(
  "SessionStart exposes only persisted custom title provenance across create rename hook and fork",
  ({ home, opencode }) =>
    Effect.gen(function* () {
      const audit = path.join(home, "title-origin-audit.jsonl")
      const script = path.join(home, "title-origin-hook.ts")
      yield* Effect.promise(async () => {
        await fs.writeFile(
          script,
          `const i=JSON.parse(await Bun.stdin.text());await (await import('node:fs/promises')).appendFile(${JSON.stringify(audit)},JSON.stringify(i)+'\\n');if(i.source==='startup'&&!i.session_title)process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'SessionStart',sessionTitle:'Hook custom title'}}));`,
        )
        await fs.writeFile(
          path.join(home, ".config/opencode/hooks.json"),
          JSON.stringify({
            SessionStart: [{ hooks: [{ type: "command", command: process.execPath, args: [script] }] }],
          }),
        )
      })
      const server = yield* opencode.serve()
      const request = (route: string, method: string, body: object) =>
        Effect.promise(async () => {
          const response = await fetch(server.url + route, {
            method,
            headers: { "content-type": "application/json", "x-opencode-directory": home },
            body: JSON.stringify(body),
          })
          expect(response.status).toBe(200)
          return response.json()
        })
      const unnamed = yield* request("/session", "POST", {})
      const hookFork = yield* request(`/session/${unnamed.id}/fork`, "POST", {})
      const custom = yield* request("/session", "POST", { title: "User created title" })
      yield* request(`/session/${custom.id}`, "PATCH", { title: "User renamed title" })
      const renamedFork = yield* request(`/session/${custom.id}/fork`, "POST", {})
      const rows = yield* Effect.promise(async () =>
        (await fs.readFile(audit, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)),
      )
      expect(rows.find((row) => row.session_id === unnamed.id).session_title).toBeUndefined()
      expect(rows.find((row) => row.session_id === hookFork.id).session_title).toBe(hookFork.title)
      expect(rows.find((row) => row.session_id === custom.id).session_title).toBe("User created title")
      expect(rows.find((row) => row.session_id === renamedFork.id).session_title).toBe(renamedFork.title)
      expect(renamedFork.title).toContain("User renamed title")
      for (const row of rows) {
        expect(row.context_tokens).toBeUndefined()
        expect(row.seconds_since_last_response).toBeUndefined()
        expect(row.prompt_cache_likely_expired).toBeUndefined()
        expect(row.estimated_cache_write_usd).toBeUndefined()
      }
    }),
)
