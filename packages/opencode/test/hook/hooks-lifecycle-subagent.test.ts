import { expect } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { cliIt } from "../lib/cli-process"

cliIt.live(
  "a real task child fires one start and stop, including its agent-frontmatter Stop hook",
  ({ home, env, llm, opencode }) =>
    Effect.gen(function* () {
      const script = path.join(home, "child-hooks.ts")
      const audit = path.join(home, "child-hooks.jsonl")
      yield* Effect.promise(async () => {
        await fs.writeFile(
          script,
          `const i=JSON.parse(await Bun.stdin.text());await (await import("node:fs/promises")).appendFile(${JSON.stringify(audit)},JSON.stringify({origin:process.argv[2],event:i.hook_event_name,session:i.session_id,child:i.agent_id,prompt:i.prompt_id,effort:i.effort?.level,readable:await Bun.file(i.transcript_path).exists(),agentReadable:i.agent_transcript_path?await Bun.file(i.agent_transcript_path).exists():undefined})+"\\n")`,
        )
        const hook = { type: "command", command: process.execPath, args: [script, "global"] }
        await fs.writeFile(
          path.join(home, ".config/opencode/hooks.json"),
          JSON.stringify({
            SubagentStart: [{ hooks: [hook] }],
            SubagentStop: [{ hooks: [hook] }],
            TaskCreated: [{ hooks: [hook] }],
            TaskCompleted: [{ hooks: [hook] }],
          }),
        )
      })
      yield* Effect.promise(async () => {
        const directory = path.join(home, ".config/opencode/agent")
        await fs.mkdir(directory, { recursive: true })
        await fs.writeFile(
          path.join(directory, "lifecycle_child.md"),
          `---\n${JSON.stringify({ mode: "subagent", description: "local lifecycle child", hooks: { Stop: [{ hooks: [{ type: "command", command: process.execPath, args: [script, "agent"] }] }] } })}\n---\nRespond once.`,
        )
      })
      const config = { ...JSON.parse(env.OPENCODE_CONFIG_CONTENT), permission: { "*": "allow" } }
      yield* llm.tool("task", { description: "Local child", prompt: "respond once", subagent_type: "lifecycle_child" })
      yield* llm.text("REAL_CHILD_RESPONSE")
      yield* llm.text("REAL_PARENT_FINISHED")
      const result = yield* opencode.run("delegate one local child", {
        format: "json",
        extraArgs: ["--variant", "high"],
        env: { OPENCODE_CONFIG_CONTENT: JSON.stringify(config) },
      })
      opencode.expectExit(result, 0)
      expect(result.stdout).toContain("REAL_PARENT_FINISHED")
      const rows = yield* Effect.promise(async () =>
        (await fs.readFile(audit, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)),
      )
      const globalRows = rows.filter((row) => row.origin === "global")
      expect(globalRows.map((row) => row.event)).toEqual(["SubagentStart", "SubagentStop"])
      expect(rows.filter((row) => row.origin === "agent").map((row) => row.event)).toEqual(["SubagentStop"])
      expect(new Set(rows.map((row) => row.child)).size).toBe(1)
      expect(rows.every((row) => row.readable)).toBe(true)
      expect(rows.filter((row) => row.event === "SubagentStop").every((row) => row.agentReadable)).toBe(true)
      // Both subagent events name the parent prompt that started the task.
      expect(new Set(globalRows.map((row) => row.prompt)).size).toBe(1)
      expect(globalRows[0]?.prompt).toMatch(/^msg_/)
      // CC emits effort only for EFFORT_EVENTS; SubagentStart is not one.
      expect(globalRows.find((row) => row.event === "SubagentStart")?.effort).toBeUndefined()
      expect(globalRows.find((row) => row.event === "SubagentStop")?.effort).toBe("high")
    }),
)
