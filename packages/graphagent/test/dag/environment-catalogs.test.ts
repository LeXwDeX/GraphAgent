// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect } from "bun:test"
import { Effect } from "effect"
import type { Agent } from "@/agent/agent"
import { DagEnvironmentCatalogs } from "@/dag/environment-catalogs"
import { Permission } from "@/permission"
import { Provider } from "@/provider/provider"
import { ProviderTest } from "../fake/provider"
import { testEffect } from "../lib/effect"

const open = Permission.fromConfig({ "*": "allow" })
const readOnly = Permission.merge(
  open,
  Permission.fromConfig({ "*": "deny", read: "allow", grep: "allow", glob: "allow", bash: "allow" }),
)

const info = (name: string, permission: Agent.Info["permission"]): Agent.Info => ({
  name,
  mode: "subagent",
  permission,
  options: {},
})

const catalog: Agent.Info[] = [
  info("build", open),
  info("general", Permission.merge(open, Permission.fromConfig({ todowrite: "deny" }))),
  // plan keeps an edit allow-list for its plan file and is a read-only profile.
  info("plan", Permission.merge(open, Permission.fromConfig({ edit: { "*": "deny", ".agents/plans/*.md": "allow" } }))),
  info("explore", readOnly),
  info("auditor", Permission.merge(readOnly, Permission.fromConfig({ edit: "deny" }))),
  // A read-only agent that a user rule re-opened: a blanket deny, then `edit: allow`.
  info("reopened", Permission.merge(readOnly, Permission.fromConfig({ edit: "allow" }))),
]

// The loader only lists the catalog; every other method is out of scope here.
const agents: Agent.Interface = {
  permissionPolicy: () => Effect.die("not used"),
  get: () => Effect.die("not used"),
  list: () => Effect.succeed(catalog),
  defaultInfo: () => Effect.die("not used"),
  defaultAgent: () => Effect.die("not used"),
  generate: () => Effect.die("not used"),
}

const it = testEffect(ProviderTest.fake().layer)

const load = Effect.gen(function* () {
  const provider = yield* Provider.Service
  return yield* DagEnvironmentCatalogs.makeCatalogLoader(agents, provider)({ directory: process.cwd() })
})

describe("DAG environment catalogs", () => {
  it.effect("worker_types lists every agent in the catalog", () =>
    Effect.gen(function* () {
      const environment = yield* load
      expect([...(environment.worker_types ?? [])].toSorted()).toEqual(
        ["auditor", "build", "explore", "general", "plan", "reopened"].toSorted(),
      )
    }),
  )

  it.effect("writer_types holds exactly the agents whose rules let them edit files", () =>
    Effect.gen(function* () {
      const environment = yield* load
      expect([...(environment.writer_types ?? [])].toSorted()).toEqual(["build", "general", "reopened"])
    }),
  )
})
