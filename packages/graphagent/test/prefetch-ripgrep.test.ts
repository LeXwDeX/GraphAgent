// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { derivePlatform, distDirectories } from "../script/prefetch-ripgrep-lib"

const NAMES = [
  "graphagent-linux-x64",
  "graphagent-darwin-arm64",
  "graphagent-windows-x64",
  ".rg-cache",
  "previous-linux-x64",
  "graphagent",
]

describe("prefetch-ripgrep dist directories", () => {
  test("selects only artifact directories for the given prefix", () => {
    expect(distDirectories(NAMES, "graphagent")).toEqual([
      "graphagent-linux-x64",
      "graphagent-darwin-arm64",
      "graphagent-windows-x64",
    ])
  })

  test("does not hardcode the graphagent prefix", () => {
    expect(distDirectories(["agent-linux-x64", "graphagent-linux-x64"], "agent")).toEqual(["agent-linux-x64"])
  })

  test("--only keeps a single matching artifact directory", () => {
    expect(distDirectories(NAMES, "graphagent", "graphagent-darwin-arm64")).toEqual(["graphagent-darwin-arm64"])
    expect(distDirectories(NAMES, "graphagent", "graphagent-win32-x64")).toEqual([])
    expect(distDirectories(NAMES, "graphagent", ".rg-cache")).toEqual([])
  })
})

describe("prefetch-ripgrep platform derivation", () => {
  test("maps the three release platforms", () => {
    expect(derivePlatform("graphagent-linux-x64")).toEqual({ os: "linux", arch: "x64" })
    expect(derivePlatform("graphagent-darwin-arm64")).toEqual({ os: "darwin", arch: "arm64" })
    expect(derivePlatform("graphagent-windows-x64")).toEqual({ os: "win32", arch: "x64" })
  })

  test("derivation is independent of the artifact prefix", () => {
    expect(derivePlatform("agent-darwin-arm64")).toEqual({ os: "darwin", arch: "arm64" })
  })

  test("returns undefined for non-artifact or unsupported directories", () => {
    expect(derivePlatform(".rg-cache")).toBeUndefined()
    expect(derivePlatform("graphagent-freebsd-x64")).toBeUndefined()
    expect(derivePlatform("graphagent-linux-riscv64")).toBeUndefined()
    expect(derivePlatform("graphagent-linux")).toBeUndefined()
  })
})
