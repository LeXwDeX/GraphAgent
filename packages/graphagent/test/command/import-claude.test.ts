// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

const TEMPLATE = readFileSync(path.join(import.meta.dir, "../../src/command/template/import-claude.txt"), "utf8")

describe("import-claude template", () => {
  test("scans the documented Claude sources and keeps no retired scan", () => {
    for (const source of [
      "~/.claude/settings.json",
      ".claude/settings.json",
      ".claude/settings.local.json",
      ".claude/skills",
      ".mcp.json",
      "CLAUDE.md",
    ]) {
      expect(TEMPLATE).toContain(source)
    }
    expect(TEMPLATE).toContain("git toplevel")
    expect(TEMPLATE).not.toContain("import-claude-hooks")
    // Built at runtime: the brand-literal guard forbids the legacy directory
    // name as a literal anywhere in tracked sources, this test included.
    expect(TEMPLATE).not.toContain("." + "opencode")
    expect(TEMPLATE).not.toContain("Global.Path.config")
    expect(TEMPLATE).not.toContain("not loaded directly")
    expect(TEMPLATE).not.toContain("Deprecation warnings")
    expect(TEMPLATE).not.toContain("弃用告警")
  })

  test("requires review and confirmation before writing, and never executes imported scripts", () => {
    expect(TEMPLATE).toContain("Never execute imported scripts or commands")
    expect(TEMPLATE).toContain("Write nothing before the user explicitly confirms.")
    expect(TEMPLATE).toContain('"inputFormat": "claude-code"')
    expect(TEMPLATE).toContain("frontmatter `hooks`")
    expect(TEMPLATE).toContain("bundled scripts")
    expect(TEMPLATE).toContain("TeammateIdle")
    expect(TEMPLATE).toContain("PermissionDenied")
    expect(TEMPLATE).toContain("never substitute another event")
  })

  test("documents the .agents targets and write guards", () => {
    expect(TEMPLATE).toContain("<root>/.agents/hooks.json")
    expect(TEMPLATE).toContain("<root>/.agents/hooks.local.json")
    expect(TEMPLATE).toContain("default target `hooks.local.json`")
    expect(TEMPLATE).toContain("~/.config/graphagent/hooks.json")
    expect(TEMPLATE).toContain("~/.config/graphagent/skills/")
    expect(TEMPLATE).toContain("`~/.agents/skills` is read-only: never write there")
    expect(TEMPLATE).toContain("$HOME")
    expect(TEMPLATE).toContain("refuse every project target")
    expect(TEMPLATE).toContain("Never write `~/.claude/`")
  })

  test("applies the 600-second timeout rule with its exclusions", () => {
    expect(TEMPLATE).toContain("foreground command hook")
    expect(TEMPLATE).toContain('"timeout": 600')
    for (const event of ["SessionEnd", "UserPromptSubmit", "PreModelSwitch", "PostModelSwitch", "MessageDisplay"]) {
      expect(TEMPLATE).toContain(event)
    }
    expect(TEMPLATE).toContain("`async` entries")
    expect(TEMPLATE).toContain("`http` / `mcp_tool`")
    expect(TEMPLATE).toContain("Preserve every existing `timeout` as written")
  })

  test("maps .mcp.json entries into the mcpServers shape", () => {
    expect(TEMPLATE).toContain("mcpServers")
    expect(TEMPLATE).toContain('`type: "local"`')
    expect(TEMPLATE).toContain('`type: "remote"`')
    expect(TEMPLATE).toContain("`environment`")
    expect(TEMPLATE).toContain("cannot map: report it and skip that entry")
  })

  test("reports the conversion outcome", () => {
    expect(TEMPLATE).toContain("Import result")
    expect(TEMPLATE).toContain("Already present (deduplicated)")
    expect(TEMPLATE).toContain("Not verified")
    expect(TEMPLATE).toContain("Original Claude files unchanged")
  })
})
