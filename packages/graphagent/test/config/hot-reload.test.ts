// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { ConfigHotReload } from "@/config/hot-reload"

describe("hot-read global config keys", () => {
  test("keeps the hot-read allowlist explicit", () => {
    expect(ConfigHotReload.HOT_RELOAD_GLOBAL_KEYS).toEqual(["dag", "permission", "permissions"])
  })

  test("a dag-only change is hot-read", () => {
    expect(ConfigHotReload.isHotReloadOnly(["dag"])).toBe(true)
  })

  // #1678: permission rules are re-resolved at every permission check, so an edit needs no instance disposal.
  test("a permission change is hot-read, whichever spelling it is written in, alone or with dag", () => {
    expect(ConfigHotReload.isHotReloadOnly(["permission"])).toBe(true)
    expect(ConfigHotReload.isHotReloadOnly(["permissions"])).toBe(true)
    expect(ConfigHotReload.isHotReloadOnly(["dag", "permission"])).toBe(true)
  })

  test("mixed and non-hot changes recreate instances", () => {
    expect(ConfigHotReload.isHotReloadOnly(["dag", "model"])).toBe(false)
    expect(ConfigHotReload.isHotReloadOnly(["permission", "model"])).toBe(false)
    expect(ConfigHotReload.isHotReloadOnly(["model"])).toBe(false)
    expect(ConfigHotReload.isHotReloadOnly(["dag_extra"])).toBe(false)
    expect(ConfigHotReload.isHotReloadOnly(["hookPermissions"])).toBe(false)
  })

  test("an unchanged update is not hot-read", () => {
    expect(ConfigHotReload.isHotReloadOnly([])).toBe(false)
  })
})

// The merged configuration of every open directory embeds the global permission rules; `dag` is read through the
// global layer and never lives there.
describe("readsInstanceConfig", () => {
  test("is true for the permission keys, alone or among others", () => {
    expect(ConfigHotReload.readsInstanceConfig(["permission"])).toBe(true)
    expect(ConfigHotReload.readsInstanceConfig(["permissions"])).toBe(true)
    expect(ConfigHotReload.readsInstanceConfig(["dag", "permission"])).toBe(true)
  })

  test("is false for dag and for any other key", () => {
    expect(ConfigHotReload.readsInstanceConfig(["dag"])).toBe(false)
    expect(ConfigHotReload.readsInstanceConfig(["model", "language"])).toBe(false)
    expect(ConfigHotReload.readsInstanceConfig([])).toBe(false)
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

// #1678: an "always allow" outranks an `ask` rule, so the keys an edit made stricter are the ones whose remembered
// approvals must go. A loosened key leaves them alone.
describe("tightenedPermissionKeys", () => {
  const tightened = ConfigHotReload.tightenedPermissionKeys

  test("allow -> ask and allow -> deny tighten the key", () => {
    expect(tightened({ permission: { edit: "allow" } }, { permission: { edit: "ask" } })).toEqual(["edit"])
    expect(tightened({ permission: { edit: "allow" } }, { permission: { edit: "deny" } })).toEqual(["edit"])
    expect(tightened({ permission: { edit: "ask" } }, { permission: { edit: "deny" } })).toEqual(["edit"])
  })

  test("a key that gains a rule where there was none is tightened when the rule asks or denies", () => {
    expect(tightened({}, { permission: { bash: "ask" } })).toEqual(["bash"])
    expect(tightened({ permission: { edit: "allow" } }, { permission: { edit: "allow", bash: "deny" } })).toEqual([
      "bash",
    ])
  })

  test("loosening, or removing a rule, does not tighten", () => {
    expect(tightened({ permission: { edit: "ask" } }, { permission: { edit: "allow" } })).toEqual([])
    expect(tightened({ permission: { edit: "deny" } }, { permission: { edit: "allow" } })).toEqual([])
    expect(tightened({ permission: { edit: "ask" } }, {})).toEqual([])
    expect(tightened({}, { permission: { edit: "allow" } })).toEqual([])
  })

  test("an unchanged key is not tightened, even when it asks", () => {
    expect(
      tightened({ permission: { edit: "ask", bash: "allow" } }, { permission: { edit: "ask", bash: "deny" } }),
    ).toEqual(["bash"])
    expect(tightened({ permission: { edit: "ask" } }, { permission: { edit: "ask" } })).toEqual([])
  })

  test("a pattern rule counts: the key's rules changed and the new ones hold an ask or a deny", () => {
    expect(
      tightened({ permission: { bash: { "*": "allow" } } }, { permission: { bash: { "*": "allow", "rm *": "deny" } } }),
    ).toEqual(["bash"])
    expect(
      tightened({ permission: { bash: { "*": "ask", "git *": "allow" } } }, { permission: { bash: { "*": "ask" } } }),
    ).toEqual(["bash"])
    expect(
      tightened({ permission: { bash: { "src/*": "ask" } } }, { permission: { bash: { "src/*": "allow" } } }),
    ).toEqual([])
  })

  test("a bare string is the whole-key `*` pattern", () => {
    expect(tightened({ permission: "allow" }, { permission: "ask" })).toEqual(["*"])
  })

  test("the ordered `permissions` list is read like the map", () => {
    expect(
      tightened(
        { permissions: [{ action: "edit", resource: "*", effect: "allow" }] },
        { permissions: [{ action: "edit", resource: "*", effect: "ask" }] },
      ),
    ).toEqual(["edit"])
    expect(
      tightened(
        { permissions: [{ action: "edit", resource: "*", effect: "ask" }] },
        { permissions: [{ action: "edit", resource: "*", effect: "allow" }] },
      ),
    ).toEqual([])
  })

  test("the keys come back sorted, one entry per key", () => {
    expect(
      tightened(
        { permission: { webfetch: "allow", bash: "allow" } },
        {
          permission: { webfetch: "deny", bash: "ask" },
          permissions: [{ action: "bash", resource: "x", effect: "deny" }],
        },
      ),
    ).toEqual(["bash", "webfetch"])
  })
})
