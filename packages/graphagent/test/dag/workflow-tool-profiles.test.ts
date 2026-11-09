// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect } from "bun:test"
import { SessionV1 } from "@graphagent/core/v1/session"
import { ModelV2 } from "@graphagent/core/model"
import { ProviderV2 } from "@graphagent/core/provider"
import { PermissionV1 } from "@graphagent/core/v1/permission"
import { Effect } from "effect"
import { jsonSchema, tool } from "ai"
import { Agent } from "@/agent/agent"
import { SessionID } from "@/session/schema"
import { deriveSubagentSessionPermission, subagentDefaultDeniedTools } from "@/agent/subagent-permissions"
import { Permission } from "@/permission"
import { resolveTools } from "@/session/llm/request"
import { testEffect } from "../lib/effect"

const it = testEffect(Agent.defaultLayer)

const TOOL_NAMES = [
  "edit",
  "write",
  "apply_patch",
  "read",
  "grep",
  "glob",
  "bash",
  "webfetch",
  "websearch",
  "todowrite",
  "task",
  "skill",
  "serena_initial_instructions",
  "question",
  "plan_exit",
] as const

const TOOLS = Object.fromEntries(
  TOOL_NAMES.map((name) => [
    name,
    tool({
      description: name,
      inputSchema: jsonSchema({ type: "object", properties: {} }),
    }),
  ]),
)

function user(tools?: Record<string, boolean>): SessionV1.User {
  return {
    id: SessionV1.MessageID.make("msg_tool_profile"),
    sessionID: SessionID.make("ses_tool_profile"),
    role: "user",
    time: { created: 0 },
    agent: "build",
    model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
    ...(tools ? { tools } : {}),
  }
}

function advertised(
  agent: Agent.Info,
  permission: Parameters<typeof deriveSubagentSessionPermission>[0]["parentSessionPermission"] = [],
  tools = TOOLS,
  runtimeTools?: Record<string, boolean>,
  nativePermission: PermissionV1.Ruleset = [],
) {
  return Object.keys(
    resolveTools({
      agent,
      permission,
      nativePermission,
      tools,
      user: user(runtimeTools),
    }),
  )
}

const childPermission = (agent: Agent.Info) =>
  deriveSubagentSessionPermission({ parentSessionPermission: [], subagent: agent })

describe("DAG worker tool profiles", () => {
  it.instance("advertises todowrite to a non-DAG build session", () =>
    Effect.gen(function* () {
      const build = yield* (yield* Agent.Service).get("build")
      expect(build).toBeDefined()
      const tools = advertised(build!)
      expect(tools).toContain("todowrite")
      expect(tools).toContain("task")
      expect(tools).toContain("edit")
    }),
  )

  it.instance("hides derived todowrite and task from a DAG build worker", () =>
    Effect.gen(function* () {
      const build = yield* (yield* Agent.Service).get("build")
      expect(build).toBeDefined()
      const tools = advertised(build!, childPermission(build!))
      expect(tools).not.toContain("todowrite")
      expect(tools).not.toContain("task")
      expect(tools).toContain("edit")
      expect(tools).toContain("skill")
    }),
  )

  it.instance("keeps only the read-only profile's explicit allows for explore", () =>
    Effect.gen(function* () {
      const explore = yield* (yield* Agent.Service).get("explore")
      expect(explore).toBeDefined()
      const tools = advertised(explore!, childPermission(explore!))
      for (const allowed of [
        "read",
        "grep",
        "glob",
        "bash",
        "webfetch",
        "websearch",
        "skill",
        "serena_initial_instructions",
      ]) {
        expect(tools).toContain(allowed)
      }
      for (const denied of ["edit", "write", "apply_patch", "todowrite", "task", "question", "plan_exit"]) {
        expect(tools).not.toContain(denied)
      }
    }),
  )

  it.instance("keeps pattern-scoped plan edit while hiding its derived todowrite", () =>
    Effect.gen(function* () {
      const plan = yield* (yield* Agent.Service).get("plan")
      expect(plan).toBeDefined()
      const tools = advertised(plan!, childPermission(plan!))
      expect(tools).toContain("edit")
      expect(tools).toContain("task")
      expect(tools).toContain("skill")
      expect(tools).not.toContain("todowrite")
    }),
  )

  it.instance("hides plan edit when an inherited glob deny covers every allowed plan path", () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      const plan = yield* agents.get("plan")
      expect(plan).toBeDefined()
      const native = Permission.fromConfig({ edit: { "*": "deny", ".agents/plans/*.md": "allow" } })
      const planLike: Agent.Info = { ...plan!, permission: native }
      const covering = deriveSubagentSessionPermission({
        parentSessionPermission: Permission.fromConfig({ edit: { ".agents/plans/*": "deny" } }),
        subagent: planLike,
      })
      expect(advertised(planLike, covering, TOOLS, undefined, native)).not.toContain("edit")

      const noncovering = deriveSubagentSessionPermission({
        parentSessionPermission: Permission.fromConfig({ edit: { ".agents/plans/private/*": "deny" } }),
        subagent: planLike,
      })
      expect(advertised(planLike, noncovering, TOOLS, undefined, native)).toContain("edit")
    }),
  )

  it.instance("preserves runtime tool authorization and refuses to override role denies", () =>
    Effect.gen(function* () {
      const build = yield* (yield* Agent.Service).get("build")
      expect(build).toBeDefined()
      expect(advertised(build!, [], TOOLS, { read: true })).toContain("read")
      expect(advertised(build!, [], TOOLS, { read: false })).not.toContain("read")
      expect(advertised(build!, [], TOOLS, { todowrite: true })).toContain("todowrite")
      expect(advertised(build!, childPermission(build!), TOOLS, { todowrite: true })).not.toContain("todowrite")
    }),
  )

  it.instance("hides only definitively denied tools", () =>
    Effect.gen(function* () {
      const build = yield* (yield* Agent.Service).get("build")
      expect(build).toBeDefined()
      expect(advertised(build!, Permission.fromConfig({ edit: { "docs/*": "deny" } }))).toContain("edit")
      const denied = advertised(build!, Permission.fromConfig({ edit: "deny" }))
      expect(denied).not.toContain("edit")
      expect(denied).not.toContain("write")
      expect(denied).not.toContain("apply_patch")
    }),
  )

  it.instance("derives role defaults from the agent's resolved ruleset", () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      const build = yield* agents.get("build")
      const general = yield* agents.get("general")
      const plan = yield* agents.get("plan")
      const explore = yield* agents.get("explore")
      expect(build && general && plan && explore).toBeDefined()

      expect(subagentDefaultDeniedTools(build!)).toEqual(["todowrite", "task"])
      expect(subagentDefaultDeniedTools(general!)).toEqual(["task"])
      expect(subagentDefaultDeniedTools(plan!)).toEqual(["todowrite"])
      expect(subagentDefaultDeniedTools(explore!)).toEqual(["todowrite", "task"])

      const custom: Agent.Info = {
        name: "custom",
        mode: "subagent",
        options: {},
        permission: Permission.fromConfig({ todowrite: "deny", task: { "*": "deny" } }),
      }
      expect(subagentDefaultDeniedTools(custom)).toEqual([])
    }),
  )

  it.instance("does not advertise a tool that a native role deny blocks despite a user allow", () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      const explore = yield* agents.get("explore")
      expect(explore).toBeDefined()
      const policy = yield* agents.permissionPolicy("explore")
      const userAllowed: Agent.Info = {
        ...explore!,
        permission: Permission.merge(explore!.permission, Permission.fromConfig({ edit: "allow" })),
      }

      // The configured rules alone would expose edit. The native-first split
      // must still hide it, matching Permission.ask's actual precedence.
      expect(advertised(userAllowed)).toContain("edit")
      expect(advertised(userAllowed, [], TOOLS, undefined, policy.native)).not.toContain("edit")
      expect(advertised(userAllowed, [], TOOLS, undefined, policy.native)).toContain("read")
      expect(advertised(userAllowed, childPermission(userAllowed), TOOLS, undefined, policy.native)).not.toContain(
        "edit",
      )
    }),
  )
})
