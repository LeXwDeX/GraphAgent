// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { ConfigHotReload } from "@/config/hot-reload"

describe("hot-read global config keys", () => {
  test("keeps the hot-read allowlist explicit", () => {
    expect(ConfigHotReload.HOT_RELOAD_GLOBAL_KEYS).toEqual(["dag"])
  })

  test("a dag-only change is hot-read", () => {
    expect(ConfigHotReload.isHotReloadOnly(["dag"])).toBe(true)
  })

  test("mixed and non-dag changes recreate instances", () => {
    expect(ConfigHotReload.isHotReloadOnly(["dag", "model"])).toBe(false)
    expect(ConfigHotReload.isHotReloadOnly(["model"])).toBe(false)
    expect(ConfigHotReload.isHotReloadOnly(["dag_extra"])).toBe(false)
  })

  test("an unchanged update is not hot-read", () => {
    expect(ConfigHotReload.isHotReloadOnly([])).toBe(false)
  })
})

describe("changedTopLevelKeys", () => {
  test("reports added, removed, and changed top-level keys only", () => {
    expect(
      ConfigHotReload.changedTopLevelKeys(
        { dag: { mode: "off", concurrency: 5 }, model: "a/b" },
        { dag: { mode: "on", concurrency: 5 }, username: "user" },
      ),
    ).toEqual(["dag", "model", "username"])
  })

  test("reports a nested dag change under its top-level key", () => {
    expect(
      ConfigHotReload.changedTopLevelKeys(
        { dag: { mode: "off", budget: { tokens: 10, warn_ratio: 0.8 } } },
        { dag: { mode: "off", budget: { tokens: 20, warn_ratio: 0.8 } } },
      ),
    ).toEqual(["dag"])
  })

  test("key order alone is not a change", () => {
    expect(
      ConfigHotReload.changedTopLevelKeys(
        { dag: { mode: "on", budget: { tokens: 10, warn_ratio: 0.8 } } },
        { dag: { budget: { warn_ratio: 0.8, tokens: 10 }, mode: "on" } },
      ),
    ).toEqual([])
  })

  test("array element changes are detected", () => {
    expect(
      ConfigHotReload.changedTopLevelKeys(
        { dag: { safety: { extra: [{ permission: "bash" }] } } },
        { dag: { safety: { extra: [{ permission: "edit" }] } } },
      ),
    ).toEqual(["dag"])
  })
})
