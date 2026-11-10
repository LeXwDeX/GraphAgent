// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { enumerateProjectEntries, type ProjectLayerFile } from "@/project/trust"

function enumerate(files: ProjectLayerFile[], tracked: string[] = []) {
  return enumerateProjectEntries({ files, isTracked: (file) => tracked.includes(file) })
}

const hooksJson = `{
  "PreToolUse": [
    {
      "matcher": "Bash",
      "hooks": [{ "type": "command", "command": "./scripts/guard.sh" }]
    },
    {
      "matcher": "Edit|Write",
      "hooks": [
        { "type": "http", "url": "https://example.com/hook" },
        { "type": "prompt", "prompt": "review" }
      ]
    }
  ],
  "Stop": [
    { "hooks": [{ "type": "command", "command": "bun run .agents/check.ts" }] }
  ]
}`

describe("hooks.json entries", () => {
  test("enumerates every hook with a stable location id", () => {
    const { entries } = enumerate([{ file: "hooks.json", text: hooksJson }])

    expect(entries.map((entry) => entry.id)).toEqual([
      "hooks.json|hook|PreToolUse|Bash|1",
      "hooks.json|hook|PreToolUse|Edit%7CWrite|1",
      "hooks.json|hook|PreToolUse|Edit%7CWrite|2",
      "hooks.json|hook|Stop||1",
    ])
    expect(entries.map((entry) => entry.kind)).toEqual(["command", "http", "prompt", "command"])
    expect(entries[0]?.matcher).toBe("Bash")
    expect(entries[3]?.matcher).toBeUndefined()
    expect(entries[0]?.source).toEqual({ file: "hooks.json", line: 5 })
    expect(entries[2]?.source).toEqual({ file: "hooks.json", line: 11 })
  })

  test("collects project file references from command hooks", () => {
    const { entries } = enumerate([{ file: "hooks.json", text: hooksJson }])

    expect(entries[0]?.references).toEqual(["./scripts/guard.sh"])
    expect(entries[3]?.references).toEqual([".agents/check.ts"])
    expect(entries[1]?.references).toEqual([])
    expect(entries[0]?.display).toEqual({
      text: "./scripts/guard.sh",
      commands: ["./scripts/guard.sh"],
      urls: [],
      envKeys: [],
    })
    expect(entries[1]?.display.urls).toEqual(["https://example.com/hook"])
  })

  test("numbers entries sharing file, category, label and matcher", () => {
    const text = `{
      "PreToolUse": [
        { "matcher": "Bash", "hooks": [{ "type": "command", "command": "one" }] },
        { "matcher": "Bash", "hooks": [{ "type": "command", "command": "two" }] }
      ]
    }`
    const { entries } = enumerate([{ file: "hooks.json", text }])

    expect(entries.map((entry) => entry.id)).toEqual([
      "hooks.json|hook|PreToolUse|Bash|1",
      "hooks.json|hook|PreToolUse|Bash|2",
    ])
    expect(entries.map((entry) => entry.index)).toEqual([1, 2])
  })

  test("skips invalid hooks, unknown events and the legacy hooks wrapper", () => {
    const text = `{
      "PreToolUse": [
        { "hooks": [{ "type": "command" }, { "type": "command", "command": "kept" }] }
      ],
      "NotAnEvent": [{ "hooks": [{ "type": "command", "command": "ignored" }] }]
    }`
    const { entries } = enumerate([{ file: "hooks.json", text }])
    expect(entries.map((entry) => entry.display.text)).toEqual(["kept"])

    const wrapped = enumerate([{ file: "hooks.json", text: `{"hooks":{"Stop":[{"hooks":[]}]}}` }])
    expect(wrapped.entries).toEqual([])
  })

  test("reports malformed JSON instead of guessing", () => {
    const result = enumerate([{ file: "hooks.json", text: "{ nope" }])
    expect(result.entries).toEqual([])
    expect(result.invalidFiles).toEqual(["hooks.json"])
  })
})

describe("mcp.json entries", () => {
  const text = `{
  "mcpServers": {
    "local": {
      "type": "local",
      "command": ["bun", "run", ".agents/server.ts"],
      "cwd": "tools",
      "environment": { "TOKEN": "secret" }
    },
    "remote": { "type": "remote", "url": "https://mcp.example.com", "headers": { "Authorization": "Bearer x" } }
  }
}`

  test("enumerates local and remote servers", () => {
    const { entries } = enumerate([{ file: "mcp.json", text }])

    expect(entries.map((entry) => entry.id)).toEqual(["mcp.json|mcp|local||1", "mcp.json|mcp|remote||1"])
    expect(entries[0]?.mcpType).toBe("local")
    expect(entries[0]?.cwd).toBe("tools")
    expect(entries[0]?.references).toEqual([".agents/server.ts"])
    expect(entries[0]?.display.commands).toEqual(["bun run .agents/server.ts"])
    expect(entries[0]?.display.envKeys).toEqual(["TOKEN"])
    expect(entries[0]?.source.line).toBe(3)
    expect(entries[0]?.canonical.environment).toEqual(["TOKEN"])

    expect(entries[1]?.mcpType).toBe("remote")
    expect(entries[1]?.display.urls).toEqual(["https://mcp.example.com"])
    expect(entries[1]?.canonical.headers).toEqual(["Authorization"])
  })

  test("skips disabled-looking servers with an unsupported shape", () => {
    const { entries } = enumerate([{ file: "mcp.json", text: `{"mcpServers":{"x":{"type":"local","command":"bun"}}}` }])
    expect(entries).toEqual([])
  })
})

describe("frontmatter entries", () => {
  test("enumerates skill hooks", () => {
    const text = `---
name: demo
description: demo skill
hooks:
  SessionStart:
    - matcher: "startup"
      hooks:
        - type: command
          command: "./scripts/skill.sh"
  Stop:
    - hooks:
        - type: http
          url: "https://example.com/stop"
---
body
`
    const { entries } = enumerate([{ file: "skills/demo/SKILL.md", text }])

    expect(entries.map((entry) => entry.id)).toEqual([
      "skills/demo/SKILL.md|skill-hook|SessionStart|startup|1",
      "skills/demo/SKILL.md|skill-hook|Stop||1",
    ])
    expect(entries[0]?.references).toEqual(["./scripts/skill.sh"])
    expect(entries[1]?.display.urls).toEqual(["https://example.com/stop"])
  })

  test("enumerates agent file hooks", () => {
    const text = `---
name: reviewer
hooks:
  PreToolUse:
    - hooks:
        - type: command
          command: "bun run .agents/agent-hook.ts"
---
prompt
`
    const { entries } = enumerate([{ file: "agents/reviewer.md", text }])
    expect(entries.map((entry) => entry.id)).toEqual(["agents/reviewer.md|agent-hook|PreToolUse||1"])
    expect(entries[0]?.references).toEqual([".agents/agent-hook.ts"])
  })

  test("enumerates command template shell segments with line numbers", () => {
    const text = `---
description: demo
---
Run !\`echo one\` and !\`./scripts/two.sh\`.
`
    const { entries } = enumerate([{ file: "commands/demo.md", text }])

    expect(entries.map((entry) => entry.id)).toEqual([
      "commands/demo.md|command-shell|demo||1",
      "commands/demo.md|command-shell|demo||2",
    ])
    expect(entries.map((entry) => entry.source.line)).toEqual([4, 4])
    expect(entries[0]?.display.commands).toEqual(["echo one"])
    expect(entries[0]?.references).toEqual([])
    expect(entries[1]?.references).toEqual(["./scripts/two.sh"])
  })
})

describe("settings.json entries", () => {
  const text = `{
  "agent": {
    "reviewer": {
      "hooks": {
        "PreToolUse": [
          { "matcher": "Bash", "hooks": [{ "type": "command", "command": "echo check" }] }
        ]
      }
    }
  },
  "formatter": {
    "custom": { "command": ["bun", "run", ".agents/fmt.ts"], "environment": { "FMT": "1" } }
  },
  "lsp": {
    "custom": { "command": ["node", ".agents/lsp.js"] },
    "off": { "disabled": true }
  }
}`

  test("enumerates agent hooks, formatter and lsp command entries", () => {
    const { entries } = enumerate([{ file: "settings.json", text }])

    expect(entries.map((entry) => entry.id)).toEqual([
      "settings.json|formatter|custom||1",
      "settings.json|lsp|custom||1",
      "settings.json|agent-hook|PreToolUse|Bash|1",
    ])
    expect(entries[0]?.references).toEqual([".agents/fmt.ts"])
    expect(entries[0]?.display.envKeys).toEqual(["FMT"])
    expect(entries[0]?.source.line).toBe(12)
    expect(entries[1]?.references).toEqual([".agents/lsp.js"])
    expect(entries[2]?.canonical.agent).toBe("reviewer")
    expect(entries[2]?.canonical.command).toBe("echo check")
  })
})

describe("local project files", () => {
  const hook = `{"Stop":[{"hooks":[{"type":"command","command":"echo local"}]}]}`

  test("untracked local files are user configuration and stay out of the trust list", () => {
    const result = enumerate([
      { file: "hooks.json", text: hook },
      { file: "hooks.local.json", text: hook },
    ])
    expect(result.entries.map((entry) => entry.id)).toEqual(["hooks.json|hook|Stop||1"])
    expect(result.ignoredLocalFiles).toEqual(["hooks.local.json"])
  })

  test("a git-tracked local file contributes project entries", () => {
    const result = enumerate([{ file: "hooks.local.json", text: hook }], ["hooks.local.json"])
    expect(result.entries.map((entry) => entry.id)).toEqual(["hooks.local.json|hook|Stop||1"])
    expect(result.ignoredLocalFiles).toEqual([])
  })

  test("settings.local.json follows the same rule", () => {
    const text = `{"formatter":{"custom":{"command":["bun","fmt"]}}}`
    const untracked = enumerate([{ file: "settings.local.json", text }])
    expect(untracked.entries).toEqual([])
    expect(untracked.ignoredLocalFiles).toEqual(["settings.local.json"])

    const tracked = enumerate([{ file: "settings.local.json", text }], ["settings.local.json"])
    expect(tracked.entries.map((entry) => entry.id)).toEqual(["settings.local.json|formatter|custom||1"])
  })
})

describe("determinism", () => {
  test("file input order does not change the enumerated ids", () => {
    const a: ProjectLayerFile = { file: "hooks.json", text: hooksJson }
    const b: ProjectLayerFile = {
      file: "skills/demo/SKILL.md",
      text: "---\nname: demo\nhooks:\n  Stop:\n    - hooks:\n        - type: command\n          command: echo stop\n---\n",
    }
    const forward = enumerate([a, b]).entries.map((entry) => entry.id)
    const reverse = enumerate([b, a]).entries.map((entry) => entry.id)
    expect(reverse).toEqual(forward)
  })
})
