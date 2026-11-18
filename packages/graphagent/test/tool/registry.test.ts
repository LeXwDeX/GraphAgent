import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import path from "path"
import { Effect } from "effect"
import { LayerNode } from "@graphagent/core/effect/layer-node"
import { Database } from "@graphagent/core/database/database"
import { Project } from "@graphagent/core/project"
import { ProjectTable } from "@graphagent/core/project/sql"
import { AbsolutePath } from "@graphagent/core/schema"
import { SessionTable } from "@graphagent/core/session/sql"
import { ToolRegistry, definitionKey } from "@/tool/registry"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestConfig } from "../fixture/config"
import { Config } from "@/config/config"
import { Agent } from "@/agent/agent"
import { InstanceState } from "@/effect/instance-state"
import { ProjectV2 } from "@graphagent/core/project"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { ChildRegistry } from "@/session/child/registry"

import { RuntimeFlags } from "@/effect/runtime-flags"
import { ModelV2 } from "@graphagent/core/model"
import { resolveProfile } from "@graphagent/core/model-profile"
import { ProviderTest } from "../fake/provider"
import { SystemPrompt } from "@/session/system"
import { SessionReminders } from "@/session/reminders"

/** The `dag.permission` tier the fake global configuration reports (#1324); `undefined` is the `allow` default. */
const permissionTier: { tier: "allow" | "ask" | "readonly" | undefined } = { tier: undefined }

const configLayer = TestConfig.layer({
  directories: () => InstanceState.directory.pipe(Effect.map((dir) => [path.join(dir, ".agents")])),
  dagGlobal: () => Effect.sync(() => (permissionTier.tier ? { permission: permissionTier.tier } : {})),
})

const root = LayerNode.group([ToolRegistry.node, Agent.node, Database.node])
const replacements = [
  LayerNode.replace(Config.node, configLayer),
  LayerNode.replace(RuntimeFlags.node, RuntimeFlags.layer()),
]

const it = testEffect(LayerNode.buildLayer(root, { replacements }))

afterEach(async () => {
  await disposeAllInstances()
})

describe("tool.registry", () => {
  for (const id of ["gpt-oss-120b", "gpt-5", "gpt-5-codex", "gpt-4.1", "Claude-Sonnet-4"])
    it.instance(`editing instructions match registered tools for ${id}`, () =>
      Effect.gen(function* () {
        const registry = yield* ToolRegistry.Service
        const agents = yield* Agent.Service
        const agent = yield* agents.get("plan")
        if (!agent) throw new Error("plan agent not found")
        const model = ProviderTest.model({ id: ModelV2.ID.make(id) })
        const tools = (yield* registry.tools({ modelID: model.id, providerID: model.providerID, agent })).map(
          (t) => t.id,
        )
        expect(tools.filter((name) => ["apply_patch", "edit", "write"].includes(name))).toEqual(
          id === "gpt-5" || id === "gpt-5-codex" ? ["apply_patch"] : ["edit", "write"],
        )
        for (const exists of [false, true]) {
          const text = [
            ...SystemPrompt.provider(tools),
            SessionReminders.planModePrompt({ plan: "/plans/test.md", exists, tools }),
          ].join("\n")
          const references = [...text.matchAll(/Use (apply_patch|edit(?: and write)?|write) for manual file edits\./g)]
          expect(references.length).toBeGreaterThan(0)
          for (const reference of references)
            for (const name of reference[1].split(" and ")) expect(tools).toContain(name)
          for (const name of ["apply_patch", "edit", "write"])
            if (!tools.includes(name)) expect(text).not.toContain(`using the ${name} tool`)
          expect(text).not.toContain("${")
        }
        const disabled = SystemPrompt.provider([]).join("\n")
        expect(disabled).not.toContain("apply_patch")
        const reminder = SessionReminders.planModePrompt({ plan: "/plans/test.md", exists: false, tools: [] })
        expect(reminder).not.toContain("plan_exit")
        expect(reminder).toContain("No file-editing tool is available")
        expect(
          SessionReminders.planModePrompt({ plan: "/plans/test.md", exists: true, tools: ["plan_exit"] }),
        ).toContain("Call plan_exit")
      }),
    )

  const editingIDs = (ids: ReadonlyArray<string>) => ids.filter((id) => ["apply_patch", "edit", "write"].includes(id))

  const rootSession = (directory: string, name: string): Session.Info => ({
    id: SessionID.make(`ses_registry_${name}`),
    slug: `registry-${name}`,
    role: "root",
    projectID: ProjectV2.ID.global,
    directory,
    title: `registry ${name}`,
    version: "1.0.0",
    time: { created: 1, updated: 1 },
  })

  // B2 (#1463): the edit tool family follows the lowercased API id, like every other id-based decision.
  it.instance("editing tools follow the lowercased API id", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const agents = yield* Agent.Service
      const build = yield* agents.get("build")
      if (!build) throw new Error("build agent not found")
      const session = rootSession(yield* InstanceState.directory, "edit_family")
      const actual: Record<string, { tools: string[]; resolved: string[] }> = {}
      for (const id of ["GPT-5", "gpt-5", "GPT-5-Codex", "GPT-OSS-120B", "gpt-oss-120b", "GPT-4.1", "gpt-4.1"]) {
        const model = ProviderTest.model({ id: ModelV2.ID.make(id) })
        const tools = yield* registry.tools({ providerID: model.providerID, modelID: model.id, agent: build })
        const resolved = yield* registry.resolve({ model, agent: build, session })
        actual[id] = {
          tools: editingIDs(tools.map((tool) => tool.id)),
          resolved: editingIDs(resolved.map((entry) => entry.id)),
        }
      }
      const patch = { tools: ["apply_patch"], resolved: ["apply_patch"] }
      const files = { tools: ["edit", "write"], resolved: ["edit", "write"] }
      expect(actual).toEqual({
        "GPT-5": patch,
        "gpt-5": patch,
        "GPT-5-Codex": patch,
        "GPT-OSS-120B": files,
        "gpt-oss-120b": files,
        "GPT-4.1": files,
        "gpt-4.1": files,
      })
    }),
  )

  // `profile.edit_tools` reaches `resolve` only: `tools` is asked about ids that may not be registered models.
  it.instance("a configured profile.editTools decides the edit tool family of resolve", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const agents = yield* Agent.Service
      const build = yield* agents.get("build")
      if (!build) throw new Error("build agent not found")
      const session = rootSession(yield* InstanceState.directory, "edit_profile")
      const configured = (apiID: string, editTools: "edit" | "apply_patch") =>
        ProviderTest.model({
          id: ModelV2.ID.make(apiID),
          profile: resolveProfile({
            providerID: "openai",
            apiID,
            config: { profile: { edit_tools: editTools } },
          }),
        })
      const resolved = (model: ReturnType<typeof ProviderTest.model>) =>
        registry.resolve({ model, agent: build, session }).pipe(Effect.map((entries) => entries.map((e) => e.id)))

      const forEdit = configured("gpt-5", "edit")
      const forPatch = configured("gpt-oss-120b", "apply_patch")
      expect(forEdit.profile?.sources.editTools).toBe("config")
      expect(forPatch.profile?.sources.editTools).toBe("config")

      // The same `gpt-5` first without a profile (the built-in rule: apply_patch), then with one that asks for edit:
      // only the edit tool family differs between the two resolutions, so the cached definitions must not be shared.
      const builtin = ProviderTest.model({ id: ModelV2.ID.make("gpt-5") })
      expect(editingIDs(yield* resolved(builtin))).toEqual(["apply_patch"])
      expect(editingIDs(yield* resolved(forEdit))).toEqual(["edit", "write"])
      expect(editingIDs(yield* resolved(forPatch))).toEqual(["apply_patch"])
      expect(editingIDs(yield* resolved(builtin))).toEqual(["apply_patch"])

      const tools = yield* registry.tools({ providerID: builtin.providerID, modelID: builtin.id, agent: build })
      expect(editingIDs(tools.map((tool) => tool.id))).toEqual(["apply_patch"])
    }),
  )

  it.instance("registers agent messaging as a built-in tool", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      expect(yield* registry.ids()).toContain("agent")
    }),
  )

  it.instance("registers memory_search as a built-in tool", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service

      expect(yield* registry.ids()).toContain("memory_search")
    }),
  )

  it.instance("does not expose task_status", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()

      expect(ids).not.toContain("task_status")
    }),
  )

  // #1072: reminders are the user's. The model may suggest one in text, but no
  // tool lets it create, change or list one, so it cannot arm a timer to wake
  // itself.
  it.instance("exposes no tool that creates, changes or lists reminders", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()

      expect(ids.length).toBeGreaterThan(0)
      expect(ids.filter((id) => /remind|alarm|timer|schedul|cron|wake/i.test(id))).toEqual([])
    }),
  )

  it.instance("does not load legacy JavaScript tools from project tool directories", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const directory = yield* InstanceState.directory
      yield* Effect.promise(async () => {
        for (const name of ["tool", "tools", ".agents/tool", ".agents/tools"]) {
          const dir = path.join(directory, name)
          await mkdir(dir, { recursive: true })
          await writeFile(
            path.join(dir, "legacy.ts"),
            `export const legacy = { description: "legacy", args: {}, execute: async () => "legacy" }\n`,
          )
        }
      })

      const ids = yield* registry.ids()
      expect(ids).not.toContain("legacy")
    }),
  )

  it.instance("exposes the task background parameter unconditionally", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const agents = yield* Agent.Service
      const build = yield* agents.get("build")
      if (!build) throw new Error("build agent not found")
      const directory = yield* InstanceState.directory
      const session = {
        id: SessionID.make("ses_registry_task_background"),
        slug: "registry-task-background",
        role: "root",
        projectID: ProjectV2.ID.global,
        directory,
        title: "registry task background",
        version: "1.0.0",
        time: { created: 1, updated: 1 },
      } as Session.Info
      const model = ProviderTest.model()
      const task = (yield* registry.resolve({ model, agent: build, session })).find((entry) => entry.id === "task")

      expect(task?.jsonSchema).toBeDefined()
      expect((task?.jsonSchema?.properties as Record<string, unknown> | undefined)?.background).toBeDefined()
    }),
  )

  it.instance("every built-in tool declares a known effects class", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const agents = yield* Agent.Service
      const build = yield* agents.get("build")
      if (!build) throw new Error("build agent not found")
      const registered = yield* registry.all()
      expect(registered.length).toBeGreaterThanOrEqual(16)
      const missing = registered
        .filter((definition) => definition.effects === undefined)
        .map((definition) => definition.id)
      expect(missing).toEqual([])
      for (const definition of registered) {
        expect(["read", "workspace_write", "unknown"]).toContain(definition.effects ?? "")
      }
      // The definition-stage rebuild used by `tools` must preserve the declaration too.
      const rebuilt = []
      for (const id of ["test-model", "gpt-5"]) {
        const model = id === "gpt-5" ? ProviderTest.model({ id: ModelV2.ID.make(id) }) : ProviderTest.model()
        rebuilt.push(...(yield* registry.tools({ providerID: model.providerID, modelID: model.id, agent: build })))
      }
      for (const definition of rebuilt) expect(definition.effects).toBeDefined()
    }),
  )

  it.instance("hides workspace-writing tools from a run that denies workspace writes", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const agents = yield* Agent.Service
      const build = yield* agents.get("build")
      if (!build) throw new Error("build agent not found")
      const directory = yield* InstanceState.directory
      const parentID = SessionID.make(`ses_registry_ws_parent_${crypto.randomUUID()}`)
      const childID = SessionID.make(`ses_registry_ws_child_${crypto.randomUUID()}`)
      const session = {
        id: childID,
        parentID,
        slug: "registry-workspace-writes",
        role: "task_child",
        projectID: ProjectV2.ID.global,
        directory,
        title: "registry workspace writes",
        version: "1.0.0",
        time: { created: 1, updated: 1 },
      } as Session.Info
      const entry = ChildRegistry.create({
        id: `crun_${crypto.randomUUID()}`,
        childSessionID: childID,
        parentSessionID: parentID,
        ownerKind: "dag_node",
        ownerKey: { kind: "dag_node", workflowID: "wf_registry", nodeID: "review", attempt: 0 },
        permission: { ask: "auto", workspaceWrites: "deny" },
        detached: false,
        directory: undefined,
        owner: {},
      })
      expect(ChildRegistry.register(entry)).toBe(true)

      yield* Effect.gen(function* () {
        // gpt-oss edits through edit/write, gpt-5 through apply_patch.
        for (const model of [
          ProviderTest.model({ id: ModelV2.ID.make("gpt-oss-120b") }),
          ProviderTest.model({ id: ModelV2.ID.make("gpt-5") }),
        ]) {
          const entries = yield* registry.resolve({ model, agent: build, session })
          const ids = entries.map((resolved) => resolved.id)
          expect(ids).toContain("bash")
          expect(ids).not.toContain("edit")
          expect(ids).not.toContain("write")
          expect(ids).not.toContain("apply_patch")
          expect(entries.filter((resolved) => resolved.effects === "workspace_write")).toHaveLength(0)
        }
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            ChildRegistry.end(entry, { type: "completed" })
            ChildRegistry.release(entry)
          }),
        ),
      )

      // The same session without an active run sees the agent's editing tools again.
      const allowed = yield* registry.resolve({
        model: ProviderTest.model({ id: ModelV2.ID.make("gpt-oss-120b") }),
        agent: build,
        session,
      })
      expect(allowed.map((resolved) => resolved.id)).toContain("edit")
    }),
  )

  it.instance(
    "hides workspace-writing tools from a DAG node under the readonly tier, with no static workspaceWrites deny",
    () =>
      Effect.gen(function* () {
        const registry = yield* ToolRegistry.Service
        const agents = yield* Agent.Service
        const build = yield* agents.get("build")
        if (!build) throw new Error("build agent not found")
        const directory = yield* InstanceState.directory
        const parentID = SessionID.make(`ses_registry_ro_parent_${crypto.randomUUID()}`)
        const childID = SessionID.make(`ses_registry_ro_child_${crypto.randomUUID()}`)
        const session = {
          id: childID,
          parentID,
          slug: "registry-readonly-tier",
          role: "task_child",
          projectID: ProjectV2.ID.global,
          directory,
          title: "registry readonly tier",
          version: "1.0.0",
          time: { created: 1, updated: 1 },
        } as Session.Info
        // No `workspaceWrites: "deny"` here: the node's own worker profile
        // would normally keep its editing tools. Only the global tier hides them.
        const entry = ChildRegistry.create({
          id: `crun_${crypto.randomUUID()}`,
          childSessionID: childID,
          parentSessionID: parentID,
          ownerKind: "dag_node",
          ownerKey: { kind: "dag_node", workflowID: "wf_registry_ro", nodeID: "impl", attempt: 0 },
          permission: { ask: "auto" },
          detached: false,
          directory: undefined,
          owner: {},
        })
        expect(ChildRegistry.register(entry)).toBe(true)

        yield* Effect.gen(function* () {
          permissionTier.tier = "readonly"
          const model = ProviderTest.model({ id: ModelV2.ID.make("gpt-oss-120b") })
          const entries = yield* registry.resolve({ model, agent: build, session })
          const ids = entries.map((resolved) => resolved.id)
          expect(ids).toContain("bash")
          expect(ids).not.toContain("edit")
          expect(ids).not.toContain("write")
          expect(ids).not.toContain("apply_patch")

          // Switching back to `allow` is picked up on the very next resolve.
          permissionTier.tier = "allow"
          const allowed = yield* registry.resolve({ model, agent: build, session })
          expect(allowed.map((resolved) => resolved.id)).toContain("edit")
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              permissionTier.tier = undefined
              ChildRegistry.end(entry, { type: "completed" })
              ChildRegistry.release(entry)
            }),
          ),
        )
      }),
  )

  it.instance(
    "hides workspace-writing tools from a task child while its root is in DAG mode under the readonly tier",
    () =>
      Effect.gen(function* () {
        const registry = yield* ToolRegistry.Service
        const agents = yield* Agent.Service
        const build = yield* agents.get("build")
        if (!build) throw new Error("build agent not found")
        const directory = yield* InstanceState.directory
        const rootID = SessionID.make(`ses_registry_ro_task_root_${crypto.randomUUID()}`)
        const childID = SessionID.make(`ses_registry_ro_task_child_${crypto.randomUUID()}`)
        const session = {
          id: childID,
          parentID: rootID,
          slug: "registry-readonly-task",
          role: "task_child",
          projectID: ProjectV2.ID.global,
          directory,
          title: "registry readonly task",
          version: "1.0.0",
          time: { created: 1, updated: 1 },
        } as Session.Info
        const entry = ChildRegistry.create({
          id: `crun_${crypto.randomUUID()}`,
          childSessionID: childID,
          parentSessionID: rootID,
          ownerKind: "task",
          ownerKey: { kind: "task", toolCallID: "call_registry_ro_task" },
          permission: { ask: "root-dag-mode" },
          detached: false,
          directory: undefined,
          owner: {},
        })
        expect(ChildRegistry.register(entry)).toBe(true)

        const { db } = yield* Database.Service
        const projectID = Project.ID.make("prj_registry_ro_task")
        const setRootDagMode = (mode: "on" | "off") =>
          Effect.gen(function* () {
            yield* db
              .insert(ProjectTable)
              .values({ id: projectID, worktree: AbsolutePath.make(directory), sandboxes: [] })
              .onConflictDoNothing()
              .run()
              .pipe(Effect.orDie)
            yield* db
              .insert(SessionTable)
              .values({
                id: rootID,
                project_id: projectID,
                slug: "registry-readonly-task-root",
                directory: AbsolutePath.make(directory),
                title: "registry readonly task root",
                version: "0",
                dag_mode: mode,
              })
              .onConflictDoUpdate({ target: SessionTable.id, set: { dag_mode: mode } })
              .run()
              .pipe(Effect.orDie)
          })

        yield* Effect.gen(function* () {
          permissionTier.tier = "readonly"
          const model = ProviderTest.model({ id: ModelV2.ID.make("gpt-oss-120b") })

          yield* setRootDagMode("on")
          const unattended = yield* registry.resolve({ model, agent: build, session })
          expect(unattended.map((resolved) => resolved.id)).not.toContain("edit")

          // DAG mode off: the task child is attended, and the readonly tier does not touch it.
          yield* setRootDagMode("off")
          const attended = yield* registry.resolve({ model, agent: build, session })
          expect(attended.map((resolved) => resolved.id)).toContain("edit")
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              permissionTier.tier = undefined
              ChildRegistry.end(entry, { type: "completed" })
              ChildRegistry.release(entry)
            }),
          ),
        )
      }),
  )

  it.instance("resolves entries deterministically in registration order", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const agents = yield* Agent.Service
      const build = yield* agents.get("build")
      if (!build) throw new Error("build agent not found")
      const directory = yield* InstanceState.directory
      const session = {
        id: SessionID.make("ses_registry_order"),
        slug: "registry-order",
        role: "root",
        projectID: ProjectV2.ID.global,
        directory,
        title: "registry order",
        version: "1.0.0",
        time: { created: 1, updated: 1 },
      } as Session.Info
      const model = ProviderTest.model()
      const first = yield* registry.resolve({ model, agent: build, session })
      const second = yield* registry.resolve({ model, agent: build, session })
      expect(JSON.stringify(first.map((entry) => entry.id))).toBe(JSON.stringify(second.map((entry) => entry.id)))
      const order = (yield* registry.tools({ providerID: model.providerID, modelID: model.id, agent: build })).map(
        (definition) => definition.id,
      )
      const resolved = first.map((entry) => entry.id)
      expect(resolved).toEqual(order.filter((id) => resolved.includes(id)))
    }),
  )
})

// The definition-stage cache must eliminate repeated schema derivation. Probe
// it in a child process: `mock.module` is process-wide and would leak into
// every other test file.
test("reuses definition-stage work across identical resolutions", async () => {
  const probe = path.join(import.meta.dir, "fixtures", "registry-definition-cache-probe.ts")
  const proc = Bun.spawn([process.execPath, probe], {
    cwd: path.join(import.meta.dir, "../.."),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (exitCode !== 0) throw new Error(`definition cache probe failed (${exitCode})\n${stderr}\n${stdout}`)
  const line = stdout.split("\n").find((item) => item.startsWith("CACHE_RESULT "))
  if (!line) throw new Error(`definition cache probe produced no result\n${stderr}\n${stdout}`)
  const result = JSON.parse(line.slice("CACHE_RESULT ".length))
  expect(result.firstCalls).toBeGreaterThan(0)
  expect(result.secondCalls).toBe(0)
  expect(result.sameIds).toBe(true)
  expect(result.firstKey).toBeTruthy()
  expect(result.secondKey).toBe(result.firstKey)
}, 60_000)

test("every definition-stage input invalidates the cache key", () => {
  const base = {
    origin: "directory-a",
    model: { providerID: "provider-a", id: "model-a", apiID: "api-a", npm: "@ai-sdk/test" },
    flags: { webSearch: false, lsp: false, plan: false, question: false, client: "cli", usePatch: false },
  }
  const key = definitionKey(base)
  expect(definitionKey(base)).toBe(key)

  const variants = {
    origin: { ...base, origin: "directory-b" },
    providerID: { ...base, model: { ...base.model, providerID: "provider-b" } },
    id: { ...base, model: { ...base.model, id: "model-b" } },
    apiID: { ...base, model: { ...base.model, apiID: "api-b" } },
    npm: { ...base, model: { ...base.model, npm: "@ai-sdk/other" } },
    webSearch: { ...base, flags: { ...base.flags, webSearch: true } },
    lsp: { ...base, flags: { ...base.flags, lsp: true } },
    plan: { ...base, flags: { ...base.flags, plan: true } },
    question: { ...base, flags: { ...base.flags, question: true } },
    client: { ...base, flags: { ...base.flags, client: "tui" } },
    usePatch: { ...base, flags: { ...base.flags, usePatch: true } },
  } as const
  for (const [field, variant] of Object.entries(variants)) {
    if (definitionKey(variant) === key) throw new Error(`definition key did not change for ${field}`)
  }
})
