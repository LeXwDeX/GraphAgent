// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { ConfigHotReload } from "@/config/hot-reload"
import { Permission } from "@/permission"
import { Wildcard } from "@graphagent/core/util/wildcard"
import type { PermissionV1 } from "@graphagent/core/v1/permission"

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

  // An `allow` that goes leaves its key to whatever is behind it, so what the key still holds does not say whether it
  // got stricter.
  test("deleting an allow tightens the key, whatever it falls back to", () => {
    const asks = { action: "*", resource: "*", effect: "ask" }
    const bashAllow = { action: "bash", resource: "*", effect: "allow" }
    // The `*` rule did not change and the `bash` rule is gone: `bash` falls back to `*`, which asks.
    expect(tightened({ permissions: [asks, bashAllow] }, { permissions: [asks] })).toEqual(["bash"])
    expect(tightened({ permission: { "*": "ask", bash: "allow" } }, { permission: { "*": "ask" } })).toEqual(["bash"])
    expect(tightened({ permission: { bash: "allow" } }, {})).toEqual(["bash"])
    // Another allow may still cover it: one more question, never a missed one.
    expect(tightened({ permission: { "*": "allow", bash: "allow" } }, { permission: { "*": "allow" } })).toEqual([
      "bash",
    ])
  })

  test("deleting or replacing a pattern rule that allowed tightens the key", () => {
    const rules = { bash: { "git *": "allow", "*": "ask" } }
    expect(tightened({ permission: rules }, { permission: { bash: { "*": "ask" } } })).toEqual(["bash"])
    // A string in place of the object drops every pattern rule it held.
    expect(tightened({ permission: rules }, { permission: { bash: "ask" } })).toEqual(["bash"])
    expect(tightened({ permission: rules }, { permission: { bash: { "git status": "allow", "*": "ask" } } })).toEqual([
      "bash",
    ])
  })

  test("only the keys that lost an allow are named", () => {
    expect(
      tightened(
        { permission: { "*": "ask", bash: "allow", edit: "allow", webfetch: "allow" } },
        { permission: { "*": "ask", edit: "allow", webfetch: "allow" } },
      ),
    ).toEqual(["bash"])
  })

  test("a wildcard key that gave up an allow covers every key", () => {
    expect(tightened({ permissions: [{ action: "*", resource: "*", effect: "allow" }] }, { permissions: [] })).toEqual([
      "*",
    ])
    expect(
      tightened({ permission: { "*": "allow", edit: "allow" } }, { permission: { "*": "ask", edit: "allow" } }),
    ).toEqual(["*"])
    // Another wildcard key names itself; the approvals it matches go with it.
    expect(tightened({ permission: { "mcp_*": "allow" } }, { permission: { "mcp_*": "ask" } })).toEqual(["mcp_*"])
  })

  test("only loosening tightens nothing: a new allow, a rule that asked or denied removed, or ask or deny turned allow", () => {
    const asks = { action: "*", resource: "*", effect: "ask" }
    expect(
      tightened({ permissions: [asks] }, { permissions: [asks, { action: "bash", resource: "*", effect: "allow" }] }),
    ).toEqual([])
    expect(
      tightened({ permission: { bash: { "*": "ask" } } }, { permission: { bash: { "*": "ask", "git *": "allow" } } }),
    ).toEqual([])
    expect(tightened({ permission: { "*": "ask", edit: "ask" } }, { permission: { "*": "ask" } })).toEqual([])
    expect(
      tightened({ permission: { bash: "deny", edit: "ask" } }, { permission: { bash: "allow", edit: "allow" } }),
    ).toEqual([])
    expect(tightened({ permission: { edit: "allow" } }, { permission: { edit: "allow", bash: "allow" } })).toEqual([])
  })

  // Of two rules that match, the later one decides, so putting an `ask` behind an `allow` is a stricter edit even
  // though no rule was added or removed.
  test("a rule that moves behind a later one tightens, though no rule was added or removed", () => {
    const asks = { action: "*", resource: "*", effect: "ask" }
    const allows = { action: "bash", resource: "*", effect: "allow" }
    expect(tightened({ permissions: [asks, allows] }, { permissions: [allows, asks] })).toEqual(["*"])
    // Either way round it is the order alone that is judged, so the move that loosens is named too: one more question.
    expect(tightened({ permissions: [allows, asks] }, { permissions: [asks, allows] })).toEqual(["*"])
  })

  test("an ask written again behind an allow tightens the key, though the same ask was already there", () => {
    const asks = { action: "bash", resource: "*", effect: "ask" }
    const allows = { action: "bash", resource: "*", effect: "allow" }
    expect(tightened({ permissions: [asks, allows] }, { permissions: [asks, allows, asks] })).toEqual(["bash"])
  })

  test("the ordered list replaces the map when both are written, so an edit to the map alone changes nothing", () => {
    const list = [{ action: "bash", resource: "*", effect: "ask" }]
    expect(
      tightened(
        { permissions: list, permission: { bash: "allow" } },
        { permissions: list, permission: { bash: "deny" } },
      ),
    ).toEqual([])
    // Once the list goes, the map is what is left.
    expect(tightened({ permissions: list, permission: { bash: "allow" } }, { permission: { bash: "allow" } })).toEqual(
      [],
    )
    expect(tightened({ permissions: list, permission: { bash: "allow" } }, { permission: { bash: "deny" } })).toEqual([
      "bash",
    ])
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

// What an edit has to get right is a statement about requests, so it is checked against the permission check itself.
// Over many random edits (a rule added, deleted, moved, turned or narrowed), every request that an `allow` let through
// and that now asks must belong to a key the edit names. A request that no rule names falls back to the agent's own
// rules, which are `allow` for most keys and `ask` for a few, so it is judged under both. Globs of `*` and of `?`,
// wildcard keys and exact keys all take part: it is where two globs overlap that a check made on a few requests would
// have gaps.
describe("tightenedPermissionKeys against Permission.evaluate", () => {
  const KEYS = ["*", "bash", "edit", "webfetch", "mcp_*", "b*", "ed*", "?"]
  const PATTERNS = ["*", "git *", "git status", "rm *", "rm ?", "src/*", "*.ts", "src/a*", "x*", "*x", "a?c", "?"]
  const ACTIONS = ["allow", "ask", "deny"] as const
  const REQUESTS = {
    keys: ["bash", "edit", "webfetch", "mcp_x", "bar", "b", "*", "mcp_*"],
    patterns: [
      "*",
      "?",
      "",
      "git status",
      "git push",
      "rm foo",
      "rm -rf x",
      "src/a.ts",
      "src/a/b.ts",
      "x",
      "xx",
      "abc",
      "rm *",
    ],
  }
  const FALLBACKS: PermissionV1.Ruleset[] = [[], [{ permission: "*", pattern: "*", action: "allow" }]]

  type Entry = { action: string; resource: string; effect: (typeof ACTIONS)[number] }

  function random(seed: number) {
    let state = seed >>> 0
    return () => {
      state = (state + 0x6d2b79f5) >>> 0
      let mixed = Math.imul(state ^ (state >>> 15), state | 1)
      mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61)
      return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
    }
  }

  test("no request that an allow let through and that now asks escapes the keys an edit names", () => {
    const next = random(1678)
    const pick = <T>(items: readonly T[]) => items[Math.floor(next() * items.length)]
    const entry = (): Entry => ({ action: pick(KEYS), resource: pick(PATTERNS), effect: pick(ACTIONS) })
    const edit = (rules: Entry[]): Entry[] => {
      const copy = rules.map((rule) => ({ ...rule }))
      for (let step = 0, steps = 1 + Math.floor(next() * 2); step < steps; step++) {
        const at = Math.floor(next() * copy.length)
        switch (Math.floor(next() * 6)) {
          case 0:
            copy.splice(Math.floor(next() * (copy.length + 1)), 0, entry())
            break
          case 1:
            copy.splice(at, 1)
            break
          case 2:
            if (copy[at]) copy[at].effect = pick(ACTIONS)
            break
          case 3:
            if (copy[at]) copy[at].resource = pick(PATTERNS)
            break
          case 4:
            if (copy[at]) copy[at].action = pick(KEYS)
            break
          default: {
            const other = Math.floor(next() * copy.length)
            if (copy[at] && copy[other]) [copy[at], copy[other]] = [copy[other], copy[at]]
          }
        }
      }
      return copy
    }
    const ruleset = (rules: Entry[]) =>
      rules.map((rule) => ({ permission: rule.action, pattern: rule.resource, action: rule.effect }))

    const escaped: string[] = []
    for (let round = 0; round < 1500; round++) {
      const before = Array.from({ length: Math.floor(next() * 6) }, entry)
      const after = edit(before)
      const named = ConfigHotReload.tightenedPermissionKeys({ permissions: before }, { permissions: after })
      const was = ruleset(before)
      const now = ruleset(after)
      for (const permission of REQUESTS.keys) {
        if (named.some((key) => Wildcard.match(permission, key))) continue
        for (const pattern of REQUESTS.patterns) {
          for (const fallback of FALLBACKS) {
            if (
              Permission.evaluate(permission, pattern, fallback, was).action === "allow" &&
              Permission.evaluate(permission, pattern, fallback, now).action === "ask"
            )
              escaped.push(JSON.stringify({ before, after, permission, pattern, named }))
          }
        }
      }
    }
    expect(escaped.slice(0, 3)).toEqual([])
  })
})
