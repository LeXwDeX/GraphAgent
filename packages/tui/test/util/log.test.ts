// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { Global } from "@graphagent/core/global"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { TuiLog } from "../../src/util/log"

/** `target` is `root` itself or something below it. */
function within(root: string, target: string) {
  const relative = path.relative(root, target)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

// What an installed GraphAgent uses: the default XDG data directory of the user's real home.
const REAL_DATA = path.join(os.homedir(), ".local", "share", "graphagent")

describe("the test process keeps off the user's own directories", () => {
  test("test/preload.ts gave it a temporary home with the layout of a real one", () => {
    const home = process.env.GRAPHAGENT_TEST_HOME
    expect(home).toBeDefined()
    if (!home) return
    expect(path.basename(home)).toStartWith("graphagent-tui-test-")
    expect(within(os.tmpdir(), home)).toBe(true)
    expect(process.env.XDG_DATA_HOME).toBe(path.join(home, ".local", "share"))
    expect(process.env.XDG_STATE_HOME).toBe(path.join(home, ".local", "state"))
    expect(process.env.XDG_CACHE_HOME).toBe(path.join(home, ".cache"))
    expect(process.env.XDG_CONFIG_HOME).toBe(path.join(home, ".config"))
  })

  test("TuiLog writes below that home, not below the user's data directory", () => {
    const home = process.env.GRAPHAGENT_TEST_HOME ?? ""
    const target = TuiLog.logFilePath()
    expect(within(home, target)).toBe(true)
    expect(within(REAL_DATA, target)).toBe(false)
    expect(within(REAL_DATA, Global.Path.log)).toBe(false)
  })

  test("so does every directory the data layer derives from the XDG variables", () => {
    const home = process.env.GRAPHAGENT_TEST_HOME ?? ""
    for (const key of ["home", "data", "cache", "config", "state", "log", "bin", "repos"] as const) {
      expect(within(home, Global.Path[key]), key).toBe(true)
      expect(within(REAL_DATA, Global.Path[key]), key).toBe(false)
    }
  })

  test("a line written through TuiLog lands in the temporary file", async () => {
    const marker = `tui-log-isolation pid=${process.pid} at=${Date.now()}`
    TuiLog.write("log", marker)
    const target = TuiLog.logFilePath()
    // The append is not awaited by `write`; wait for it to show up.
    for (let attempt = 0; attempt < 200; attempt++) {
      const text = await fs.readFile(target, "utf8").catch(() => "")
      if (text.includes(marker)) return
      await Bun.sleep(10)
    }
    throw new Error(`the line never reached ${target}`)
  })
})
