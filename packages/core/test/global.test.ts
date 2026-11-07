import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { APP_NAME } from "@opencode-ai/core/brand"
import { Global } from "@opencode-ai/core/global"

describe("global paths", () => {
  test("global directories are scoped by the app name", () => {
    expect(Global.Path.tmp).toBe(path.join(os.tmpdir(), APP_NAME))
    expect(path.basename(Global.Path.data)).toBe(APP_NAME)
    expect(path.basename(Global.Path.cache)).toBe(APP_NAME)
    expect(path.basename(Global.Path.state)).toBe(APP_NAME)
    if (!process.env.GRAPHAGENT_CONFIG_DIR) expect(path.basename(Global.Path.config)).toBe(APP_NAME)
    expect(Global.make().tmp).toBe(Global.Path.tmp)
  })

  test("GRAPHAGENT_CONFIG_DIR overrides the config directory", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "graphagent-config-"))
    const previous = process.env.GRAPHAGENT_CONFIG_DIR
    process.env.GRAPHAGENT_CONFIG_DIR = dir
    try {
      expect(Global.Path.config).toBe(dir)
      expect(Global.make().config).toBe(dir)
    } finally {
      if (previous === undefined) delete process.env.GRAPHAGENT_CONFIG_DIR
      else process.env.GRAPHAGENT_CONFIG_DIR = previous
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("tmp path is created on module load", async () => {
    expect((await fs.stat(Global.Path.tmp)).isDirectory()).toBe(true)
  })
})
