import { describe, expect, test } from "bun:test"
import { evaluate } from "@/hook/extensions/condition-filter"
import type { HookCommand, HookEvent } from "@/hook/settings"

// `evaluate` only reads `entry.if`; `type` is the one required field on
// HookCommand, so this is the minimal valid fixture.
const entry = (ifCond: string): HookCommand => ({ type: "command", if: ifCond })

describe("condition-filter evaluate", () => {
  test("PermissionRequest: if 不匹配 → 跳过", () => {
    // delta spec scenario: Bash(rm *) against a `ls` command → no match
    const result = evaluate(
      entry("Bash(rm *)"),
      { tool_name: "bash", tool_input: { command: "ls" } },
      "PermissionRequest",
    )
    expect(result).toBe(false)
  })

  test("PermissionDenied: if 匹配 → 执行", () => {
    // delta spec scenario: Edit(*.ts) against filePath a.ts → match
    const result = evaluate(
      entry("Edit(*.ts)"),
      { tool_name: "edit", tool_input: { filePath: "a.ts" } },
      "PermissionDenied",
    )
    expect(result).toBe(true)
  })

  test("非工具事件带 if 条件时不运行", () => {
    expect(evaluate(entry("Bash(rm *)"), { prompt: "hi" }, "Stop")).toBe(false)
    expect(evaluate(entry("Edit(*.ts)"), {}, "UserPromptSubmit")).toBe(false)
  })

  test("PreToolUse 既有行为保持（匹配/不匹配）", () => {
    expect(
      evaluate(
        entry("Bash(npm install *)"),
        { tool_name: "bash", tool_input: { command: "npm install foo" } },
        "PreToolUse",
      ),
    ).toBe(true)
    expect(
      evaluate(entry("Bash(npm install *)"), { tool_name: "bash", tool_input: { command: "rm -rf /" } }, "PreToolUse"),
    ).toBe(false)
  })

  test("PostToolUse/PostToolUseFailure 仍受 if 过滤", () => {
    expect(evaluate(entry("Read(*.ts)"), { tool_name: "read", tool_input: { filePath: "x.ts" } }, "PostToolUse")).toBe(
      true,
    )
    expect(
      evaluate(entry("Read(*.ts)"), { tool_name: "read", tool_input: { filePath: "x.py" } }, "PostToolUseFailure"),
    ).toBe(false)
  })

  // Claude Code permission-rule semantics on real tool inputs: native tools pass
  // absolute file paths and shell commands contain `/`.
  describe("permission-rule semantics on real inputs", () => {
    const RM = ["r", "m"].join("")
    const bash = (cond: string, command: string) =>
      evaluate(entry(cond), { tool_name: "bash", tool_input: { command } }, "PreToolUse")
    const file = (cond: string, tool: string, filePath: string) =>
      evaluate(entry(cond), { tool_name: tool, tool_input: { filePath }, cwd: "/repo" }, "PreToolUse")

    test("Bash `*` matches any characters including `/`", () => {
      expect(bash(`Bash(${RM} *)`, `${RM} -rf /tmp/project`)).toBe(true)
      expect(bash("Bash(npm install *)", "npm install @scope/pkg")).toBe(true)
      expect(bash(`Bash(${RM} *)`, `${RM}dir x`)).toBe(false)
    })

    test("Bash checks every subcommand and strips leading env assignments", () => {
      expect(bash(`Bash(${RM} *)`, `echo hi && FOO=1 ${RM} -rf build`)).toBe(true)
      expect(bash("Bash(git *)", "npm test; git push")).toBe(true)
      expect(bash("Bash(git *)", "npm test")).toBe(false)
    })

    test("Bash trailing ` *` matches the bare command; legacy `:*` is a prefix", () => {
      expect(bash("Bash(ls *)", "ls")).toBe(true)
      expect(bash("Bash(ls *)", "lsof")).toBe(false)
      expect(bash("Bash(npm run test:*)", "npm run test --watch")).toBe(true)
      expect(bash("Bash(npm run test:*)", "npm run testing")).toBe(false)
    })

    test("file pattern without `/` matches the basename at any depth", () => {
      expect(file("Write(*.env)", "write", "/repo/.env")).toBe(true)
      expect(file("Edit(*.ts)", "edit", "/repo/src/a.ts")).toBe(true)
      expect(file("Edit(*.ts)", "edit", "/repo/src/a.tsx")).toBe(false)
    })

    test("file pattern with `/` is anchored at the project root", () => {
      expect(file("Edit(src/**)", "edit", "/repo/src/x/a.ts")).toBe(true)
      expect(file("Edit(src/**)", "edit", "/repo/lib/src/a.ts")).toBe(false)
      expect(file("Edit(**/src/**)", "edit", "/repo/lib/src/a.ts")).toBe(true)
      expect(file("Edit(/src/*.ts)", "edit", "/repo/src/a.ts")).toBe(true)
      expect(file("Edit(/src/*.ts)", "edit", "/repo/src/x/a.ts")).toBe(false)
      expect(file("Edit(src/)", "edit", "/repo/src/a/b.ts")).toBe(true)
    })

    test("`//` file pattern is absolute", () => {
      expect(file("Read(//etc/**)", "read", "/etc/hosts")).toBe(true)
      expect(file("Read(//etc/**)", "read", "/repo/etc/hosts")).toBe(false)
    })

    // Patterns that matched before the permission-rule semantics must keep
    // matching: hooks are guards, so ambiguous readings are unioned.
    test("single leading `/` also keeps its historical absolute-path meaning", () => {
      expect(file("Edit(/Users/me/proj/src/**)", "edit", "/Users/me/proj/src/a.ts")).toBe(true)
      expect(file("Write(/etc/**)", "write", "/etc/hosts")).toBe(true)
      expect(file("Write(/etc/**)", "write", "/repo/src/hosts")).toBe(false)
    })

    test("Bash pattern env assignments are stripped like the command's", () => {
      expect(bash("Bash(FOO=1 npm *)", "FOO=1 npm test")).toBe(true)
      expect(bash("Bash(FOO=1 npm *)", "npm test")).toBe(true)
      expect(bash("Bash(FOO=1 npm *)", "yarn test")).toBe(false)
    })

    test("Bash pipeline patterns match the whole unsplit command", () => {
      expect(bash("Bash(cat * | grep *)", "cat a.txt | grep foo")).toBe(true)
      expect(bash("Bash(cat * | grep *)", "cat a.txt")).toBe(false)
    })
  })

  // Reference "How `if` patterns match Bash commands" table, plus the cases where the
  // runner cannot be determined and the hook must run.
  describe("Bash if reference table", () => {
    const RM = ["r", "m"].join("")
    const bash = (cond: string, command: string) =>
      evaluate(entry(cond), { tool_name: "bash", tool_input: { command } }, "PreToolUse")

    test("the five documented rows", () => {
      expect(bash("Bash(git *)", "FOO=bar git push")).toBe(true)
      expect(bash("Bash(git *)", "npm test && git push")).toBe(true)
      expect(bash(`Bash(${RM} *)`, `echo $(${RM} -rf /)`)).toBe(true)
      expect(bash(`Bash(${RM} *)`, "echo $(date)")).toBe(false)
      expect(bash("Bash(git push *)", "echo $(date)")).toBe(true)
    })

    test("backticks, process substitution and nested substitutions are checked", () => {
      expect(bash(`Bash(${RM} *)`, `echo \`${RM} -rf /\``)).toBe(true)
      expect(bash(`Bash(${RM} *)`, `echo "$(${RM} -rf /)"`)).toBe(true)
      expect(bash(`Bash(${RM} *)`, `cat <(${RM} x)`)).toBe(true)
      expect(bash(`Bash(${RM} *)`, "echo `date`")).toBe(false)
    })

    test("single-quoted text is literal, so it never counts as a command", () => {
      expect(bash(`Bash(${RM} *)`, `echo '$(${RM} -rf /)'`)).toBe(false)
      expect(bash(`Bash(${RM} *)`, "echo 'a; b' && date")).toBe(false)
    })

    test("variables, a variable as command name and unbalanced input run the hook conservatively", () => {
      expect(bash("Bash(git push *)", "echo $HOME")).toBe(true)
      expect(bash(`Bash(${RM} *)`, "$CMD -rf /")).toBe(true)
      expect(bash(`Bash(${RM} *)`, 'eval "$X"')).toBe(true)
      expect(bash(`Bash(${RM} *)`, "echo $(date")).toBe(true)
      expect(bash(`Bash(${RM} *)`, 'echo "unterminated')).toBe(true)
      // A name-only pattern is not forced by a plain variable argument.
      expect(bash(`Bash(${RM} *)`, "echo $HOME")).toBe(false)
    })

    test("redirections do not split commands", () => {
      expect(bash(`Bash(${RM} *)`, "make 2>&1 | tee log")).toBe(false)
      expect(bash("Bash(make *)", "make 2>&1 | tee log")).toBe(true)
    })
  })

  describe("tool rules beyond Bash and files", () => {
    const run = (cond: string, envelope: Record<string, unknown>, canonicalToolName?: string) =>
      evaluate(entry(cond), envelope, "PreToolUse", { canonicalToolName })

    test("a bare tool rule matches only that tool", () => {
      expect(run("Edit", { tool_name: "edit", tool_input: { filePath: "a.ts" } })).toBe(true)
      expect(run("Edit", { tool_name: "write", tool_input: { filePath: "a.ts" } })).toBe(false)
      expect(run("Edit", { tool_name: "bash", tool_input: { command: "ls" } })).toBe(false)
    })

    test("WebFetch(domain:...) compares the request host", () => {
      const fetch = (url: string) => ({ tool_name: "webfetch", tool_input: { url } })
      expect(run("WebFetch(domain:example)", fetch("https://example/a?b=1"))).toBe(true)
      expect(run("WebFetch(domain:example)", fetch("https://notexample/a"))).toBe(false)
      expect(run("WebFetch(domain:*.example)", fetch("https://docs.example/"))).toBe(true)
    })

    test("official names from the runtime binding and the native id both match", () => {
      const mcp = { tool_name: "srv_lookup", tool_input: { q: "x" } }
      expect(run("mcp__srv__lookup", mcp, "mcp__srv__lookup")).toBe(true)
      expect(run("mcp__srv", mcp, "mcp__srv__lookup")).toBe(true)
      expect(run("mcp__other", mcp, "mcp__srv__lookup")).toBe(false)
      expect(run("srv_lookup", mcp, "mcp__srv__lookup")).toBe(true)
      expect(run("Agent", { tool_name: "task", tool_input: {} }, "Agent")).toBe(true)
    })
  })

  test("空/* /undefined 条件恒为真", () => {
    const events: HookEvent[] = ["PreToolUse", "PermissionRequest", "Stop", "UserPromptSubmit"]
    for (const ev of events) {
      expect(evaluate({ type: "command" }, { tool_name: "bash" }, ev)).toBe(true)
      expect(evaluate({ type: "command", if: "" }, { tool_name: "bash" }, ev)).toBe(true)
      expect(evaluate({ type: "command", if: "*" }, { tool_name: "bash" }, ev)).toBe(true)
    }
  })
})
