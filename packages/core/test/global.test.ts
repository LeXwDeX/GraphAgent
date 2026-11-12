import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { APP_NAME } from "@graphagent/core/brand"
import { Global } from "@graphagent/core/global"

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

  // #1040: operatorRoots() is the one shared list project-layer loaders check
  // to tell operator-owned content from the opened workspace. It must list
  // GRAPHAGENT_CONFIG_DIR explicitly, not only through Path.config, so a
  // GRAPHAGENT_TEST_CONFIG_DIR override (test isolation only) never makes it
  // disappear from the list.
  test("operatorRoots lists Path.config, ~/.agents, and GRAPHAGENT_CONFIG_DIR even when a test override shadows Path.config", () => {
    const previousTest = process.env.GRAPHAGENT_TEST_CONFIG_DIR
    const previousConfigDir = process.env.GRAPHAGENT_CONFIG_DIR
    const testShadow = path.join(os.tmpdir(), "graphagent-operator-roots-test-shadow")
    const configDir = path.join(os.tmpdir(), "graphagent-operator-roots-config-dir")
    process.env.GRAPHAGENT_TEST_CONFIG_DIR = testShadow
    process.env.GRAPHAGENT_CONFIG_DIR = configDir
    try {
      expect(Global.Path.config).toBe(testShadow)
      const roots = Global.operatorRoots()
      expect(roots).toContain(testShadow)
      expect(roots).toContain(path.join(Global.Path.home, ".agents"))
      expect(roots).toContain(configDir)
    } finally {
      if (previousTest === undefined) delete process.env.GRAPHAGENT_TEST_CONFIG_DIR
      else process.env.GRAPHAGENT_TEST_CONFIG_DIR = previousTest
      if (previousConfigDir === undefined) delete process.env.GRAPHAGENT_CONFIG_DIR
      else process.env.GRAPHAGENT_CONFIG_DIR = previousConfigDir
    }
  })
})
