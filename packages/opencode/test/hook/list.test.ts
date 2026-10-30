import { describe, expect, test } from "bun:test"
import * as fs from "fs/promises"
import os from "os"
import path from "path"
import { summarizeChain } from "@/hook/settings"

// Unit tests for summarizeChain — the scope-tagged read surface behind
// SettingsHook.list(). Mirrors load-chain.test.ts: isolated temp dirs for the
// global / project / worktree scopes, globalConfig override for determinism.

async function mktmp(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `hook-list-${prefix}-`))
}

async function writeHooksJson(dir: string, json: unknown): Promise<void> {
  const opencodeDir = path.join(dir, ".opencode")
  await fs.mkdir(opencodeDir, { recursive: true })
  await fs.writeFile(path.join(opencodeDir, "hooks.json"), JSON.stringify(json))
}

async function writeGlobalHooksJson(globalDir: string, json: unknown): Promise<void> {
  await fs.mkdir(globalDir, { recursive: true })
  await fs.writeFile(path.join(globalDir, "hooks.json"), JSON.stringify(json))
}

describe("summarizeChain — scope tags and ordering", () => {
  test("global entries come before project entries with correct scope tags", async () => {
    const globalDir = await mktmp("global")
    const projectDir = await mktmp("project")
    try {
      await writeGlobalHooksJson(globalDir, {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "global-check.sh" }] }],
      })
      await writeHooksJson(projectDir, {
        Stop: [{ hooks: [{ type: "command", command: "project-stop.sh" }] }],
      })

      const summaries = summarizeChain(projectDir, "", globalDir)
      expect(summaries.length).toBe(2)
      // Global layer appended first, project after — same order loadChain merges.
      expect(summaries[0].scope).toBe("global")
      expect(summaries[0].event).toBe("PreToolUse")
      expect(summaries[1].scope).toBe("project")
      expect(summaries[1].event).toBe("Stop")
    } finally {
      await Promise.all([
        fs.rm(globalDir, { recursive: true, force: true }),
        fs.rm(projectDir, { recursive: true, force: true }),
      ])
    }
  })

  test("no hooks.json layers → empty summary", async () => {
    const globalDir = await mktmp("empty-g")
    const projectDir = await mktmp("empty-p")
    try {
      const summaries = summarizeChain(projectDir, "", globalDir)
      expect(summaries).toEqual([])
    } finally {
      await Promise.all([
        fs.rm(globalDir, { recursive: true, force: true }),
        fs.rm(projectDir, { recursive: true, force: true }),
      ])
    }
  })

  test("worktree layer appends after project when worktree differs", async () => {
    const globalDir = await mktmp("wt-g")
    const projectDir = await mktmp("wt-p")
    const worktreeDir = await mktmp("wt-w")
    try {
      await writeHooksJson(projectDir, { Stop: [{ hooks: [{ type: "command", command: "p" }] }] })
      await writeHooksJson(worktreeDir, { Stop: [{ hooks: [{ type: "command", command: "w" }] }] })

      const summaries = summarizeChain(projectDir, worktreeDir, globalDir)
      expect(summaries.map((s) => s.scope)).toEqual(["project", "worktree"])
    } finally {
      await Promise.all([
        fs.rm(globalDir, { recursive: true, force: true }),
        fs.rm(projectDir, { recursive: true, force: true }),
        fs.rm(worktreeDir, { recursive: true, force: true }),
      ])
    }
  })
})

describe("summarizeChain — descriptor derivation by type", () => {
  test("command descriptor is the command text", async () => {
    const projectDir = await mktmp("desc-cmd")
    try {
      await writeHooksJson(projectDir, {
        PreToolUse: [{ hooks: [{ type: "command", command: "echo hello world" }] }],
      })
      const [summary] = summarizeChain(projectDir, "", projectDir)
      expect(summary.descriptor).toBe("echo hello world")
    } finally {
      await fs.rm(projectDir, { recursive: true, force: true })
    }
  })

  test("command descriptor adds the script file name from args", async () => {
    const projectDir = await mktmp("desc-args")
    try {
      await writeHooksJson(projectDir, {
        PostToolUse: [
          { hooks: [{ type: "command", command: "bun", args: ["run", "/repo/scripts/pr-watch.ts"] }] },
          { hooks: [{ type: "command", command: "bun", args: ["-e", "console.log(1)"] }] },
          { hooks: [{ type: "command", command: "bash", args: ["-c", "cat setup.sh"] }] },
          { hooks: [{ type: "command", command: "node", args: ["--import", "./register.ts", "watch.js"] }] },
        ],
      })
      const summaries = summarizeChain(projectDir, "", projectDir)
      expect(summaries[0].descriptor).toBe("bun pr-watch.ts")
      expect(summaries[1].descriptor).toBe("bun")
      expect(summaries[2].descriptor).toBe("bash")
      expect(summaries[3].descriptor).toBe("node watch.js")
    } finally {
      await fs.rm(projectDir, { recursive: true, force: true })
    }
  })

  test("command descriptor bounds the script name to the 60-char cap", async () => {
    const projectDir = await mktmp("desc-args-long")
    try {
      await writeHooksJson(projectDir, {
        PostToolUse: [{ hooks: [{ type: "command", command: "bun", args: [`${"x".repeat(80)}.ts`] }] }],
      })
      const [summary] = summarizeChain(projectDir, "", projectDir)
      expect(summary.descriptor.length).toBe(60)
      expect(summary.descriptor.startsWith("bun ")).toBe(true)
    } finally {
      await fs.rm(projectDir, { recursive: true, force: true })
    }
  })

  test("command descriptor truncates to 60 chars", async () => {
    const longCommand = "x".repeat(100)
    const projectDir = await mktmp("desc-long")
    try {
      await writeHooksJson(projectDir, {
        PreToolUse: [{ hooks: [{ type: "command", command: longCommand }] }],
      })
      const [summary] = summarizeChain(projectDir, "", projectDir)
      expect(summary.descriptor.length).toBe(60)
    } finally {
      await fs.rm(projectDir, { recursive: true, force: true })
    }
  })

  test("http descriptor is the url", async () => {
    const projectDir = await mktmp("desc-http")
    try {
      await writeHooksJson(projectDir, {
        PostToolUse: [{ hooks: [{ type: "http", url: "https://example.com/webhook" }] }],
      })
      const [summary] = summarizeChain(projectDir, "", projectDir)
      expect(summary.descriptor).toBe("https://example.com/webhook")
    } finally {
      await fs.rm(projectDir, { recursive: true, force: true })
    }
  })

  test("http descriptor truncates long urls to 60 chars", async () => {
    const longUrl = `https://example.com/${"x".repeat(80)}`
    const projectDir = await mktmp("desc-http-long")
    try {
      await writeHooksJson(projectDir, {
        PostToolUse: [{ hooks: [{ type: "http", url: longUrl }] }],
      })
      const [summary] = summarizeChain(projectDir, "", projectDir)
      expect(summary.descriptor.length).toBe(60)
    } finally {
      await fs.rm(projectDir, { recursive: true, force: true })
    }
  })

  test("mcp descriptor is the tool name (command field)", async () => {
    const projectDir = await mktmp("desc-mcp")
    try {
      await writeHooksJson(projectDir, {
        PreToolUse: [{ hooks: [{ type: "mcp", command: "my-server__my-tool" }] }],
      })
      const [summary] = summarizeChain(projectDir, "", projectDir)
      expect(summary.descriptor).toBe("my-server__my-tool")
    } finally {
      await fs.rm(projectDir, { recursive: true, force: true })
    }
  })

  test("prompt descriptor is the first line of the prompt", async () => {
    const projectDir = await mktmp("desc-prompt")
    try {
      await writeHooksJson(projectDir, {
        Stop: [{ hooks: [{ type: "prompt", prompt: "Summarize the work done.\nMore detail here." }] }],
      })
      const [summary] = summarizeChain(projectDir, "", projectDir)
      expect(summary.descriptor).toBe("Summarize the work done.")
    } finally {
      await fs.rm(projectDir, { recursive: true, force: true })
    }
  })

  test("prompt descriptor truncates long first lines to 60 chars", async () => {
    const longPrompt = `${"a".repeat(80)}\nsecond line`
    const projectDir = await mktmp("desc-prompt-long")
    try {
      await writeHooksJson(projectDir, {
        Stop: [{ hooks: [{ type: "prompt", prompt: longPrompt }] }],
      })
      const [summary] = summarizeChain(projectDir, "", projectDir)
      expect(summary.descriptor.length).toBe(60)
    } finally {
      await fs.rm(projectDir, { recursive: true, force: true })
    }
  })

  test("agent descriptor is the first line of the goal", async () => {
    const projectDir = await mktmp("desc-agent")
    try {
      await writeHooksJson(projectDir, {
        Stop: [{ hooks: [{ type: "agent", prompt: "Run a final review.\nCheck tests too." }] }],
      })
      const [summary] = summarizeChain(projectDir, "", projectDir)
      expect(summary.descriptor).toBe("Run a final review.")
    } finally {
      await fs.rm(projectDir, { recursive: true, force: true })
    }
  })
})

describe("summarizeChain — matcher handling", () => {
  test("specific matcher is included in summary", async () => {
    const projectDir = await mktmp("match-specific")
    try {
      await writeHooksJson(projectDir, {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "check.sh" }] }],
      })
      const [summary] = summarizeChain(projectDir, "", projectDir)
      expect(summary.matcher).toBe("Bash")
    } finally {
      await fs.rm(projectDir, { recursive: true, force: true })
    }
  })

  test("wildcard matcher (*) is omitted", async () => {
    const projectDir = await mktmp("match-wild")
    try {
      await writeHooksJson(projectDir, {
        Stop: [{ matcher: "*", hooks: [{ type: "command", command: "stop.sh" }] }],
      })
      const [summary] = summarizeChain(projectDir, "", projectDir)
      expect(summary.matcher).toBeUndefined()
    } finally {
      await fs.rm(projectDir, { recursive: true, force: true })
    }
  })

  test("asyncRewake command hooks are flagged; others carry no flag", async () => {
    const projectDir = await mktmp("rewake")
    try {
      await writeHooksJson(projectDir, {
        PostToolUse: [
          {
            matcher: "Bash",
            hooks: [
              { type: "command", command: "watch.sh", asyncRewake: true, timeout: 600 },
              { type: "command", command: "plain.sh", async: true },
            ],
          },
        ],
      })
      const [watcher, plain] = summarizeChain(projectDir, "", projectDir)
      expect(watcher.asyncRewake).toBe(true)
      expect(plain.asyncRewake).toBeUndefined()
    } finally {
      await fs.rm(projectDir, { recursive: true, force: true })
    }
  })

  test("asyncRewake on events that never rewake carries no background flag", async () => {
    const projectDir = await mktmp("no-rewake")
    try {
      await writeHooksJson(projectDir, {
        SessionEnd: [{ hooks: [{ type: "command", command: "end.sh", asyncRewake: true }] }],
        StopFailure: [{ hooks: [{ type: "command", command: "fail.sh", asyncRewake: true }] }],
        PostToolUse: [{ hooks: [{ type: "command", command: "watch.sh", asyncRewake: true }] }],
      })
      const summaries = summarizeChain(projectDir, "", projectDir)
      const byCommand = (command: string) => summaries.find((summary) => summary.descriptor === command)
      expect(byCommand("end.sh")?.asyncRewake).toBeUndefined()
      expect(byCommand("fail.sh")?.asyncRewake).toBeUndefined()
      expect(byCommand("watch.sh")?.asyncRewake).toBe(true)
    } finally {
      await fs.rm(projectDir, { recursive: true, force: true })
    }
  })

  test("absent matcher is omitted", async () => {
    const projectDir = await mktmp("match-absent")
    try {
      await writeHooksJson(projectDir, {
        Stop: [{ hooks: [{ type: "command", command: "stop.sh" }] }],
      })
      const [summary] = summarizeChain(projectDir, "", projectDir)
      expect(summary.matcher).toBeUndefined()
    } finally {
      await fs.rm(projectDir, { recursive: true, force: true })
    }
  })
})

for (const event of ["PermissionDenied", "TeammateIdle"]) {
  test(`${event} is visibly marked inactive in the Active Hooks descriptor`, async () => {
    const projectDir = await mktmp("inactive")
    try {
      await writeHooksJson(projectDir, { [event]: [{ hooks: [{ type: "command", command: "true" }] }] })
      const [summary] = summarizeChain(projectDir, "", projectDir)
      expect(summary.descriptor).toContain("inactive: this build has no event trigger")
    } finally {
      await fs.rm(projectDir, { recursive: true, force: true })
    }
  })
}
