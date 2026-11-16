// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { Effect, Option } from "effect"
import type { Config } from "@/config/config"
import { Permission } from "@/permission"
import { ChildRegistry } from "@/session/child/registry"
import type { ChildOwner } from "@/session/child/types"
import { SessionID } from "@/session/schema"

/**
 * #1324: the run policy of an asking session is read in one place,
 * `Permission.runPolicyOf`. `Permission.ask` builds its policy from it, and so
 * does the hook guard, so a tool hook and a permission request of the same
 * session always see the same tier. This pins the shared reading itself: no
 * policy and no configuration read for a session with no active run, the tier
 * read afresh on every call, and the verdict the tier decides.
 */

type Tier = "allow" | "ask" | "readonly"

/** A fake global configuration whose tier can change between calls, and that counts how often it is read. */
const fakeConfig = (state: { tier: Tier | undefined; reads: number }): Pick<Config.Interface, "dagGlobal"> => ({
  dagGlobal: () =>
    Effect.sync(() => {
      state.reads++
      return state.tier ? { permission: state.tier } : {}
    }),
})

const withRun = async <A>(label: string, owner: ChildOwner, body: (sessionID: SessionID) => Promise<A>) => {
  const childSessionID = SessionID.make(`ses_run_policy_${label}`)
  const entry = ChildRegistry.create({
    id: `crun_run_policy_${label}`,
    childSessionID,
    parentSessionID: SessionID.make("ses_run_policy_root"),
    ownerKind: owner.kind,
    ownerKey: owner,
    permission: { ask: "auto" },
    detached: false,
    directory: undefined,
    owner: {},
  })
  expect(ChildRegistry.register(entry)).toBe(true)
  try {
    return await body(childSessionID)
  } finally {
    ChildRegistry.end(entry, { type: "completed" })
    ChildRegistry.release(entry)
  }
}

const node: ChildOwner = { kind: "dag_node", workflowID: "dag_run_policy", nodeID: "n01", attempt: 0 }

describe("Permission.runPolicyOf", () => {
  test("a session with no active run has no policy, and the configuration is not read for it", async () => {
    const state = { tier: "readonly" as Tier | undefined, reads: 0 }
    const policy = await Effect.runPromise(
      Permission.runPolicyOf({ config: fakeConfig(state), database: undefined })(SessionID.make("ses_run_policy_none")),
    )
    expect(Option.isNone(policy)).toBe(true)
    expect(state.reads).toBe(0)
  })

  for (const [tier, mode, ask] of [
    [undefined, "allow", "auto"],
    ["allow", "allow", "auto"],
    ["ask", "ask", "user"],
    ["readonly", "readonly", "auto"],
  ] as const)
    test(`a DAG node under the ${tier ?? "(unset)"} tier is unattended, in ${mode} mode, answered by ${ask}`, async () => {
      const state = { tier, reads: 0 }
      await withRun(`node_${tier ?? "unset"}`, node, async (sessionID) => {
        const policy = await Effect.runPromise(
          Permission.runPolicyOf({ config: fakeConfig(state), database: undefined })(sessionID),
        )
        expect(
          Option.isSome(policy)
            ? { unattended: policy.value.unattended, mode: policy.value.mode, ask: policy.value.ask }
            : policy,
        ).toEqual({
          unattended: true,
          mode,
          ask,
        })
        expect(state.reads).toBe(1)
      })
    })

  test("without a configuration the tier is the default one", async () => {
    await withRun("no_config", node, async (sessionID) => {
      const policy = await Effect.runPromise(
        Permission.runPolicyOf({ config: undefined, database: undefined })(sessionID),
      )
      expect(Option.isSome(policy) ? policy.value.mode : undefined).toBe("allow")
    })
  })

  test("the tier is read on every call: a switch reaches the next one", async () => {
    const state = { tier: "allow" as Tier | undefined, reads: 0 }
    await withRun("switch", node, async (sessionID) => {
      const policyOf = Permission.runPolicyOf({ config: fakeConfig(state), database: undefined })
      const modes: Array<string | undefined> = []
      for (const tier of ["allow", "readonly", "ask", "allow"] as const) {
        state.tier = tier
        const policy = await Effect.runPromise(policyOf(sessionID))
        modes.push(Option.isSome(policy) ? policy.value.mode : undefined)
      }
      expect(modes).toEqual(["allow", "readonly", "ask", "allow"])
      expect(state.reads).toBe(4)
    })
  })
})
