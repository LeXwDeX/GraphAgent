import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { readJSON } from "@/hook"
import { HookCommandSchema } from "@/hook/schema"
import * as Log from "@/util/log"

// Legacy aliases, wrappers and removed event names must fail closed: the entry
// is not loaded and the loader leaves exactly one warning per file (and per
// event name) instead of silently degrading.

async function writeHooks(json: unknown): Promise<{ dir: string; file: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hook-legacy-"))
  await fs.mkdir(path.join(dir, ".agents"), { recursive: true })
  const file = path.join(dir, ".agents", "hooks.json")
  await fs.writeFile(file, JSON.stringify(json))
  return { dir, file }
}

let restore: (() => void) | undefined
afterEach(() => {
  restore?.()
  restore = undefined
})

function capture(message: string): string[] {
  const seen: string[] = []
  restore = Log.setSink((entry) => {
    if (entry.message === message) seen.push(entry.message)
  })
  return seen
}

describe("legacy hook configuration is rejected", () => {
  test('the "mcp" handler alias is rejected with one warning', async () => {
    const { dir, file } = await writeHooks({
      PreToolUse: [{ hooks: [{ type: "mcp", command: "mcp__srv__tool" }] }],
    })
    const warnings = capture("invalid hook command skipped")
    try {
      expect(HookCommandSchema.safeParse({ type: "mcp", command: "mcp__srv__tool" }).success).toBe(false)
      expect(readJSON(file)?.hooks?.PreToolUse).toEqual([])
      await Log.flush()
      expect(warnings).toHaveLength(1)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("http without url is rejected with one warning", async () => {
    const { dir, file } = await writeHooks({
      PreToolUse: [{ hooks: [{ type: "http", command: "echo legacy" }] }],
    })
    const warnings = capture("invalid hook command skipped")
    try {
      expect(readJSON(file)?.hooks?.PreToolUse).toEqual([])
      await Log.flush()
      expect(warnings).toHaveLength(1)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("prompt and agent without prompt are rejected with one warning each", async () => {
    const { dir, file } = await writeHooks({
      PreToolUse: [{ hooks: [{ type: "prompt" }, { type: "agent" }] }],
    })
    const warnings = capture("invalid hook command skipped")
    try {
      expect(readJSON(file)?.hooks?.PreToolUse).toEqual([])
      await Log.flush()
      expect(warnings).toHaveLength(2)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test('the legacy {"hooks": {...}} wrapper is rejected with one warning', async () => {
    const { dir, file } = await writeHooks({
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: "true" }] }] },
    })
    const warnings = capture('hooks.json must use top-level event keys; the "hooks" wrapper is ignored')
    try {
      expect(readJSON(file)?.hooks).toEqual({})
      await Log.flush()
      expect(warnings).toHaveLength(1)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("removed event names warn once per event and are not loaded", async () => {
    const { dir, file } = await writeHooks({
      PermissionDenied: [{ hooks: [{ type: "command", command: "true" }] }],
      TeammateIdle: [{ hooks: [{ type: "command", command: "true" }] }],
    })
    const warnings = capture("unknown hook event skipped")
    try {
      expect(readJSON(file)?.hooks).toEqual({})
      await Log.flush()
      expect(warnings).toHaveLength(2)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
