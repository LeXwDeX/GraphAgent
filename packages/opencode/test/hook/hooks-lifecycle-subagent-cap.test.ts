import { expect } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { cliIt } from "../lib/cli-process"

cliIt.live("real child tool work resets the consecutive SubagentStop feedback cap", ({ home, env, llm, opencode }) =>
  Effect.gen(function* () {
    const script = path.join(home, "continuation-hook.ts")
    const counter = path.join(home, "continuation-count")
    const file = path.join(home, "read-for-progress.txt")
    yield* Effect.promise(async () => {
      await fs.writeFile(file, "REAL_CHILD_TOOL_PROGRESS")
      await fs.writeFile(
        script,
        `const count=Number(await Bun.file(${JSON.stringify(counter)}).text().catch(()=>0))+1;await Bun.write(${JSON.stringify(counter)},String(count));if(count<=9)process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'SubagentStop',additionalContext:'continue the remaining local task'}}));`,
      )
      const agents = path.join(home, ".config/opencode/agent")
      await fs.mkdir(agents, { recursive: true })
      await fs.writeFile(
        path.join(agents, "cap_child.md"),
        `---\n${JSON.stringify({ mode: "subagent", description: "continuation cap child", hooks: { Stop: [{ hooks: [{ type: "command", command: process.execPath, args: [script] }] }] } })}\n---\nComplete local work.`,
      )
    })
    yield* llm.tool("task", { description: "Child cap", prompt: "complete local task", subagent_type: "cap_child" })
    yield* llm.text("CHILD_INITIAL")
    for (let step = 1; step <= 9; step++) {
      if (step === 7) yield* llm.tool("read", { filePath: file })
      yield* llm.text(`CHILD_CONTINUATION_${step}`)
    }
    yield* llm.text("PARENT_AFTER_ALL_CONTINUATIONS")
    const config = { ...JSON.parse(env.OPENCODE_CONFIG_CONTENT), permission: { "*": "allow" } }
    const result = yield* opencode.run("delegate the child work", {
      format: "json",
      env: { OPENCODE_CONFIG_CONTENT: JSON.stringify(config) },
    })
    opencode.expectExit(result, 0)
    expect(yield* Effect.promise(() => fs.readFile(counter, "utf8"))).toBe("10")
    expect(result.stdout).toContain("PARENT_AFTER_ALL_CONTINUATIONS")
    expect(yield* llm.pending).toBe(0)
  }),
)
