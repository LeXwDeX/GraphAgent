// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, test } from "bun:test"
import { jsonSchema, tool } from "ai"
import { Effect, Layer } from "effect"
import { LocationServiceMap } from "@graphagent/core/location-layer"
import type { PermissionV1 } from "@graphagent/core/v1/permission"
import { Agent } from "../../src/agent/agent"
import { McpReadonly } from "../../src/agent/mcp-readonly"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { McpCatalog } from "../../src/mcp/catalog"
import { Permission } from "../../src/permission"
import { Provider } from "../../src/provider/provider"
import { Skill } from "../../src/skill"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

/**
 * #1454: an MCP tool that declares `readOnlyHint` is visible to, and callable by, the five read-only built-in
 * subagents. The grant is an increment on top of their rules (`McpReadonly.adjust`), so a deny the user writes
 * for the tool still closes it.
 */

const it = testEffect(
  Agent.layer.pipe(
    Layer.provideMerge(Provider.defaultLayer),
    Layer.provide(Auth.defaultLayer),
    Layer.provideMerge(Config.defaultLayer),
    Layer.provide(Skill.defaultLayer),
    Layer.provide(LocationServiceMap.layer),
    Layer.provide(RuntimeFlags.layer({})),
  ),
)

afterEach(async () => {
  await disposeAllInstances()
})

const agentNamed = (name: string) =>
  Effect.gen(function* () {
    const agent = yield* Agent.Service.use((svc) => svc.get(name))
    if (!agent) throw new Error(`Expected the ${name} agent`)
    return agent
  })

const policyOf = (name: string) => Agent.Service.use((svc) => svc.permissionPolicy(name))

const rule = (permission: string, action: PermissionV1.Rule["action"], pattern = "*"): PermissionV1.Rule => ({
  permission,
  pattern,
  action,
})

const READ_ONLY_AGENTS = ["architect", "auditor", "explore", "researcher", "review"]

describe("McpReadonly.qualifies", () => {
  it.instance("is true for exactly the five read-only built-in subagents", () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service.use((svc) => svc.list())
      const names = agents
        .filter((agent) => McpReadonly.qualifies(agent))
        .map((agent) => agent.name)
        .toSorted()
      expect(names).toEqual(READ_ONLY_AGENTS)

      // Everything else is left out for its own reason: a primary agent, a writer, a composer.
      for (const name of ["build", "plan", "compaction", "title", "summary"]) {
        expect(McpReadonly.qualifies(yield* agentNamed(name)), name).toBe(false)
      }
      for (const name of ["general", "prototyper"]) {
        expect(McpReadonly.qualifies(yield* agentNamed(name)), name).toBe(false)
      }
      for (const name of ["surveyor", "mapper"]) {
        expect(McpReadonly.qualifies(yield* agentNamed(name)), name).toBe(false)
      }
    }),
  )

  it.instance("leaves out an agent that can write, is not built in, is not a subagent or is a composer", () =>
    Effect.gen(function* () {
      const explore = yield* agentNamed("explore")
      expect(McpReadonly.qualifies(explore)).toBe(true)

      // A configuration that gives explore the file tools turns it into a writer.
      const writer = { ...explore, permission: [...explore.permission, rule("edit", "allow")] }
      expect(McpReadonly.qualifies(writer)).toBe(false)
      // A custom agent, even one with explore's rules, and an agent whose mode was changed.
      expect(McpReadonly.qualifies({ ...explore, native: false })).toBe(false)
      const unmarked = { name: explore.name, mode: explore.mode, permission: explore.permission }
      expect(McpReadonly.qualifies(unmarked)).toBe(false)
      expect(McpReadonly.qualifies({ ...explore, mode: "all" })).toBe(false)
      expect(McpReadonly.qualifies({ ...explore, mode: "primary" })).toBe(false)
      expect(McpReadonly.qualifies({ ...explore, contract: { role: "composer" } })).toBe(false)
    }),
  )
})

describe("McpReadonly.adjust", () => {
  it.instance("adds an allow for each id after the native rules and before the user's, and moves their indices", () =>
    Effect.gen(function* () {
      const explore = yield* agentNamed("explore")
      const { native } = yield* policyOf("explore")
      const user = [rule("srv_c", "deny"), rule("bash", "ask", "rm *")]
      const policy = { native, rules: [...native, ...user], userRuleIndices: [native.length, native.length + 1] }
      const before = structuredClone(policy)

      const adjusted = McpReadonly.adjust(explore, policy, ["srv_a", "srv_b"])
      expect(adjusted.native).toEqual([...native, rule("srv_a", "allow"), rule("srv_b", "allow")])
      expect(adjusted.rules).toEqual([...native, rule("srv_a", "allow"), rule("srv_b", "allow"), ...user])
      // The user's rules moved by the number of rules put in front of them; the new allows are not among them.
      expect(adjusted.userRuleIndices).toEqual([native.length + 2, native.length + 3])
      for (const index of [native.length, native.length + 1]) expect(adjusted.userRuleIndices).not.toContain(index)

      // Nothing the caller passed in was changed.
      expect(policy).toEqual(before)
      expect(adjusted.native).not.toBe(policy.native)
      expect(adjusted.rules).not.toBe(policy.rules)
    }),
  )

  it.instance("moves only the indices at or after the native rules, adds one allow for an id given twice", () =>
    Effect.gen(function* () {
      const explore = yield* agentNamed("explore")
      const { native } = yield* policyOf("explore")
      const policy = { native, rules: [...native, rule("srv_c", "deny")], userRuleIndices: [0, native.length] }

      const adjusted = McpReadonly.adjust(explore, policy, ["srv_a", "srv_a", "srv_b"])
      expect(adjusted.native).toEqual([...native, rule("srv_a", "allow"), rule("srv_b", "allow")])
      expect(adjusted.rules.filter((entry) => entry.permission === "srv_a")).toHaveLength(1)
      expect(adjusted.userRuleIndices).toEqual([0, native.length + 2])
      expect(adjusted.rules[native.length + 2]).toEqual(rule("srv_c", "deny"))
    }),
  )

  it.instance("a policy with no user rule indices still has none after the adjustment", () =>
    Effect.gen(function* () {
      const explore = yield* agentNamed("explore")
      const { native } = yield* policyOf("explore")
      const adjusted = McpReadonly.adjust(explore, { native, rules: [...native] }, ["srv_a"])
      expect("userRuleIndices" in adjusted).toBe(false)
      expect(adjusted.rules).toEqual([...native, rule("srv_a", "allow")])
    }),
  )

  it.instance("returns the policy as it is when there is nothing to add or nothing to grant", () =>
    Effect.gen(function* () {
      const explore = yield* agentNamed("explore")
      const { native } = yield* policyOf("explore")
      const policy = { native, rules: [...native, rule("srv_c", "deny")], userRuleIndices: [native.length] }

      // No id.
      expect(McpReadonly.adjust(explore, policy, [])).toBe(policy)
      // An agent that does not qualify: a writer, a primary agent, a composer.
      for (const name of ["general", "build", "prototyper", "surveyor"]) {
        expect(McpReadonly.adjust(yield* agentNamed(name), policy, ["srv_a"]), name).toBe(policy)
      }
      // Rules that do not begin with the native rules, whatever the way they differ.
      const shorter = { native, rules: native.slice(1) }
      expect(McpReadonly.adjust(explore, shorter, ["srv_a"])).toBe(shorter)
      const changed = { native, rules: [{ ...native[0], action: "ask" as const }, ...native.slice(1)] }
      expect(McpReadonly.adjust(explore, changed, ["srv_a"])).toBe(changed)
      const moved = { native, rules: [{ ...native[0], pattern: "other" }, ...native.slice(1)] }
      expect(McpReadonly.adjust(explore, moved, ["srv_a"])).toBe(moved)
      const renamed = { native, rules: [{ ...native[0], permission: "other" }, ...native.slice(1)] }
      expect(McpReadonly.adjust(explore, renamed, ["srv_a"])).toBe(renamed)
    }),
  )

  it.instance("a deny the user wrote after the native rules still hides the tool", () =>
    Effect.gen(function* () {
      const explore = yield* agentNamed("explore")
      const { native } = yield* policyOf("explore")
      const ids = ["srv_a", "srv_b"]
      const policy = { native, rules: [...native, rule("srv_a", "deny")] }

      // The native `*` deny hides both tools before the grant.
      expect(Permission.disabledByPolicy(ids, policy.native, policy.rules)).toEqual(new Set(ids))
      const adjusted = McpReadonly.adjust(explore, policy, ids)
      // After it, only the tool the user denied is hidden.
      expect(Permission.disabledByPolicy(ids, adjusted.native, adjusted.rules)).toEqual(new Set(["srv_a"]))
      // The grant is for the ids it was given: the other tools stay hidden.
      expect(Permission.disabledByPolicy(["srv_z"], adjusted.native, adjusted.rules)).toEqual(new Set(["srv_z"]))
      // The native rules still decide the built-ins: edit stays denied, read stays allowed.
      expect(Permission.disabledByPolicy(["edit", "read"], adjusted.native, adjusted.rules)).toEqual(new Set(["edit"]))
    }),
  )

  it.instance("a wildcard deny the user wrote for a server also closes its read-only tools", () =>
    Effect.gen(function* () {
      const explore = yield* agentNamed("explore")
      const { native } = yield* policyOf("explore")
      const policy = { native, rules: [...native, rule("srv_*", "deny")] }
      const adjusted = McpReadonly.adjust(explore, policy, ["srv_a", "other_b"])
      expect(Permission.disabledByPolicy(["srv_a", "other_b"], adjusted.native, adjusted.rules)).toEqual(
        new Set(["srv_a"]),
      )
    }),
  )

  it.instance(
    "the check `Permission.ask` makes on each agent's own rules ends in an allow, and in a deny after one",
    () =>
      Effect.gen(function* () {
        // `ask` looks the tool up in the native rules, then in all the rules; a deny from either refuses the call.
        const decide = (policy: McpReadonly.Policy) => [
          Permission.evaluate("srv_a", "*", policy.native).action,
          Permission.evaluate("srv_a", "*", policy.rules).action,
        ]
        for (const name of READ_ONLY_AGENTS) {
          const agent = yield* agentNamed(name)
          const policy = yield* policyOf(name)
          expect(decide(policy), name).toEqual(["deny", "deny"])
          expect(decide(McpReadonly.adjust(agent, policy, ["srv_a"])), name).toEqual(["allow", "allow"])

          const written = { ...policy, rules: [...policy.rules, rule("srv_a", "deny")] }
          expect(decide(McpReadonly.adjust(agent, written, ["srv_a"])), name).toEqual(["allow", "deny"])
        }
        // The agents that are not among the five are asked as before: general and build allow the tool anyway.
        for (const name of ["general", "build"]) {
          const policy = yield* policyOf(name)
          expect(decide(McpReadonly.adjust(yield* agentNamed(name), policy, ["srv_a"])), name).toEqual(decide(policy))
        }
      }),
  )
})

describe("McpReadonly.adjust for the helpers of a deferred server (#1574)", () => {
  const HELPERS = ["mcp_describe", "mcp_call"]
  const lazy = { kind: "mcp", readOnly: true, deferred: true }

  it.instance("the native rules of each of the five hide the helpers, and the grant opens both and nothing else", () =>
    Effect.gen(function* () {
      for (const name of READ_ONLY_AGENTS) {
        const agent = yield* agentNamed(name)
        const policy = yield* policyOf(name)
        const ids = McpReadonly.idsOfEntries([{ id: "srv_a", source: lazy }])
        expect(Permission.disabledByPolicy([...HELPERS, "srv_a"], policy.native, policy.rules), name).toEqual(
          new Set([...HELPERS, "srv_a"]),
        )

        const adjusted = McpReadonly.adjust(agent, policy, ids)
        expect(Permission.disabledByPolicy([...HELPERS, "srv_a"], adjusted.native, adjusted.rules), name).toEqual(
          new Set(),
        )
        // The grant is for the ids it was given: a tool of another server and another `mcp_` name stay closed.
        expect(Permission.disabledByPolicy(["srv_z", "mcp_other"], adjusted.native, adjusted.rules), name).toEqual(
          new Set(["srv_z", "mcp_other"]),
        )
        // The allows follow the native rules, the helpers' beside the tool's, so the user's rules come after them.
        expect(adjusted.rules.slice(policy.native.length, policy.native.length + ids.length), name).toEqual(
          ids.map((id) => rule(id, "allow")),
        )
      }
    }),
  )

  it.instance("a deny the user wrote for either helper still closes it, and a deny for mcp_* closes both", () =>
    Effect.gen(function* () {
      const explore = yield* agentNamed("explore")
      const { native } = yield* policyOf("explore")
      const ids = McpReadonly.idsOfEntries([{ id: "srv_a", source: lazy }])
      const closed = (...user: PermissionV1.Rule[]) => {
        const adjusted = McpReadonly.adjust(explore, { native, rules: [...native, ...user] }, ids)
        return Permission.disabledByPolicy([...HELPERS, "srv_a"], adjusted.native, adjusted.rules)
      }
      expect(closed()).toEqual(new Set())
      expect(closed(rule("mcp_call", "deny"))).toEqual(new Set(["mcp_call"]))
      expect(closed(rule("mcp_describe", "deny"))).toEqual(new Set(["mcp_describe"]))
      expect(closed(rule("mcp_*", "deny"))).toEqual(new Set(HELPERS))
      // The tool is its own key: a deny for it leaves the helpers open, and the other way round.
      expect(closed(rule("srv_a", "deny"))).toEqual(new Set(["srv_a"]))
    }),
  )

  it.instance("an agent that is not one of the five gets no helper", () =>
    Effect.gen(function* () {
      const { native } = yield* policyOf("explore")
      const policy = { native, rules: [...native] }
      const ids = McpReadonly.idsOfEntries([{ id: "srv_a", source: lazy }])
      const custom = { ...(yield* agentNamed("explore")), native: false }
      expect(McpReadonly.adjust(custom, policy, ids)).toBe(policy)
      for (const name of ["general", "build", "prototyper", "surveyor"]) {
        expect(McpReadonly.adjust(yield* agentNamed(name), policy, ids), name).toBe(policy)
      }
    }),
  )
})

describe("McpReadonly ids", () => {
  const source = (kind: string, readOnly?: boolean) => ({ kind, ...(readOnly === undefined ? {} : { readOnly }) })

  test("idsOfEntries takes only the MCP server tools marked read-only", () => {
    expect(
      McpReadonly.idsOfEntries([
        { id: "a", source: source("mcp", true) },
        { id: "b", source: source("mcp") },
        { id: "c", source: source("mcp", false) },
        { id: "d", source: source("builtin", true) },
        { id: "e", source: source("mcp-resource") },
        { id: "f", source: source("mcp", true) },
      ]),
    ).toEqual(["a", "f"])
    expect(McpReadonly.idsOfEntries([])).toEqual([])
  })

  test("idsOfTools takes the keys of the tools whose binding says read-only", () => {
    const schema = jsonSchema({ type: "object", properties: {} })
    const bound = (readOnly?: boolean) =>
      McpCatalog.bindTool(tool({ inputSchema: schema }), {
        server: "srv",
        tool: "t",
        source: "unknown",
        ...(readOnly === undefined ? {} : { readOnly }),
      })
    const unbound = tool({ inputSchema: schema })
    expect(
      McpReadonly.idsOfTools({ yes: bound(true), no: bound(false), unmarked: bound(), unbound, also: bound(true) }),
    ).toEqual(["yes", "also"])
    expect(McpReadonly.idsOfTools({})).toEqual([])
  })

  describe("the helpers of a deferred server (#1574)", () => {
    const lazy = (readOnly?: boolean, kind = "mcp") => ({
      kind,
      deferred: true,
      ...(readOnly === undefined ? {} : { readOnly }),
    })

    test("idsOfEntries adds mcp_describe and mcp_call while a read-only tool belongs to a deferred server", () => {
      expect(
        McpReadonly.idsOfEntries([
          { id: "eager", source: source("mcp", true) },
          { id: "lazy", source: lazy(true) },
        ]),
      ).toEqual(["eager", "lazy", "mcp_describe", "mcp_call"])
      // Once, however many such tools there are, and whatever their order.
      expect(
        McpReadonly.idsOfEntries([
          { id: "a", source: lazy(true) },
          { id: "b", source: source("mcp", true) },
          { id: "c", source: lazy(true) },
        ]),
      ).toEqual(["a", "b", "c", "mcp_describe", "mcp_call"])
      expect(McpReadonly.idsOfEntries([{ id: "lazy", source: lazy(true) }])).toEqual([
        "lazy",
        ...McpCatalog.RESERVED_TOOL_KEYS,
      ])
    })

    test("idsOfEntries adds no helper without a deferred read-only MCP tool", () => {
      // A tool of an eager server is reached by its key, with no helper.
      expect(McpReadonly.idsOfEntries([{ id: "eager", source: source("mcp", true) }])).toEqual(["eager"])
      // A deferred tool that did not declare the hint, or declared something else, is no grant of any kind.
      for (const readOnly of [undefined, false]) {
        expect(McpReadonly.idsOfEntries([{ id: "lazy", source: lazy(readOnly) }])).toEqual([])
        expect(
          McpReadonly.idsOfEntries([
            { id: "eager", source: source("mcp", true) },
            { id: "lazy", source: lazy(readOnly) },
          ]),
        ).toEqual(["eager"])
      }
      // Only a server tool counts: not a built-in, a resource helper or a helper entry that carries the same fields.
      for (const kind of ["builtin", "mcp-resource", "mcp-deferred", "direct-shell"]) {
        expect(McpReadonly.idsOfEntries([{ id: "x", source: lazy(true, kind) }]), kind).toEqual([])
      }
      expect(McpReadonly.idsOfEntries([])).toEqual([])
    })

    test("idsOfTools adds the helpers when the tools hold both of them", () => {
      const schema = jsonSchema({ type: "object", properties: {} })
      const bound = (readOnly?: boolean) =>
        McpCatalog.bindTool(tool({ inputSchema: schema }), {
          server: "srv",
          tool: "t",
          source: "unknown",
          ...(readOnly === undefined ? {} : { readOnly }),
        })
      const plain = () => tool({ inputSchema: schema })
      expect(McpReadonly.idsOfTools({ yes: bound(true), mcp_describe: plain(), mcp_call: plain() })).toEqual([
        "yes",
        "mcp_describe",
        "mcp_call",
      ])
      // The helpers stand for the deferred tools, which are not among the tools themselves: both there, nothing else.
      expect(McpReadonly.idsOfTools({ no: bound(), mcp_call: plain(), mcp_describe: plain() })).toEqual([
        "mcp_describe",
        "mcp_call",
      ])
      // One of them is no pair: the registry never adds one alone, so nothing is granted for it.
      expect(McpReadonly.idsOfTools({ yes: bound(true), mcp_describe: plain() })).toEqual(["yes"])
      expect(McpReadonly.idsOfTools({ yes: bound(true), mcp_call: plain() })).toEqual(["yes"])
      expect(McpReadonly.idsOfTools({ no: bound(), other: plain() })).toEqual([])
    })
  })
})
