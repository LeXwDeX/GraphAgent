// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import * as fs from "fs/promises"
import os from "os"
import path from "path"
import { loadChainWithSummaries, summarizeChain } from "@/hook"

/**
 * A sample conversion output: project hooks.json, project-local hooks.local.json,
 * and the user-level hooks.json. The template writes these files; this fixture
 * keeps their documented shape loadable by the hooks chain.
 */
const projectHooks = {
  PreToolUse: [
    {
      matcher: "Bash",
      hooks: [{ type: "command", command: "bash .agents/hooks/guard.sh", inputFormat: "claude-code", timeout: 600 }],
    },
  ],
  PostToolUse: [{ hooks: [{ type: "http", url: "https://example.invalid/hook" }] }],
}

const localHooks = {
  UserPromptSubmit: [{ hooks: [{ type: "command", command: "bash .agents/hooks/local.sh" }] }],
}

const globalHooks = {
  SessionEnd: [{ hooks: [{ type: "command", command: "bash ~/.config/graphagent/hooks/session-end.sh" }] }],
}

describe("import-claude conversion output", () => {
  test("loads hooks.json and hooks.local.json through the hooks chain", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "import-claude-project-"))
    const globalDir = await fs.mkdtemp(path.join(os.tmpdir(), "import-claude-global-"))
    try {
      await fs.mkdir(path.join(root, ".agents"), { recursive: true })
      await fs.writeFile(path.join(root, ".agents", "hooks.json"), JSON.stringify(projectHooks))
      await fs.writeFile(path.join(root, ".agents", "hooks.local.json"), JSON.stringify(localHooks))
      await fs.writeFile(path.join(globalDir, "hooks.json"), JSON.stringify(globalHooks))

      const loaded = loadChainWithSummaries(root, globalDir)

      expect(loaded.invalid).toEqual([])
      expect(loaded.settings.hooks?.PreToolUse?.[0]?.hooks?.[0]).toMatchObject({
        type: "command",
        inputFormat: "claude-code",
        timeout: 600,
      })
      expect(loaded.settings.hooks?.UserPromptSubmit).toHaveLength(1)
      expect(loaded.summaries.map((entry) => entry.scope)).toEqual(["global", "project", "project", "local"])
      expect(summarizeChain(root, globalDir)).toHaveLength(loaded.summaries.length)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
      await fs.rm(globalDir, { recursive: true, force: true })
    }
  })
})
