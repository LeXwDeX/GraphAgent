// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Flag } from "@graphagent/core/flag/flag"
import { DEFAULT_LANGUAGE } from "@graphagent/core/config/language"
import { registerBuiltinCommands } from "../../src/commands/context"
import {
  createCommandRegistry,
  resolveSlashInput,
  serverCommandSpec,
  slashCommandEntries,
  type CommandRegistry,
  type CommandScope,
  type CommandSpec,
  type ServerCommandLike,
} from "../../src/commands/registry"
import { setLanguage } from "../../src/i18n"

beforeEach(() => {
  setLanguage("en")
})

afterEach(() => {
  setLanguage(DEFAULT_LANGUAGE)
})

function builtins(options: { log?: (message: string) => void } = {}) {
  const registry = createCommandRegistry(options)
  const dispose = registerBuiltinCommands(registry)
  return { registry, dispose }
}

function ids(registry: CommandRegistry, scope: CommandScope) {
  return registry.list(scope).map((spec) => spec.id)
}

function spec(overrides: Partial<CommandSpec> & Pick<CommandSpec, "id">): CommandSpec {
  return {
    category: "debug",
    scope: ["session"],
    source: "builtin",
    ...overrides,
  }
}

const WORKSPACE_IDS = Flag.GRAPHAGENT_WORKSPACES ? ["workspace.list", "workspace.set"] : []

const HOME_IDS = [
  "session.list",
  "session.new",
  "agent.list",
  "model.list",
  "prompt.editor",
  "config.open",
  "config.permissions",
  "mcp.list",
  "provider.connect",
  "theme.switch",
  "trust.open",
  ...WORKSPACE_IDS,
  "app.exit",
  "graphagent.status",
  "help.show",
  "app.console",
  "app.debug",
  "app.heap_snapshot",
]

const SESSION_IDS = [
  "session.btw",
  "session.compact",
  "session.copy",
  "session.export",
  "session.fork",
  "session.list",
  "session.move",
  "session.new",
  "session.redo",
  "session.rename",
  "session.timeline",
  "session.undo",
  "agent.list",
  "agent.subagents",
  "model.list",
  "diff.open",
  "prompt.editor",
  "session.drawer.toggle",
  "dag.open",
  "hooks.list",
  "config.open",
  "config.permissions",
  "mcp.list",
  "prompt.skills",
  "provider.connect",
  "theme.switch",
  "trust.open",
  ...WORKSPACE_IDS,
  "app.exit",
  "graphagent.status",
  "help.show",
  "app.console",
  "app.debug",
  "app.heap_snapshot",
]

const SUBAGENT_IDS = [
  "session.copy",
  "session.export",
  "session.list",
  "session.new",
  "agent.subagents",
  "session.drawer.toggle",
  "dag.open",
  "config.open",
  "theme.switch",
  "app.exit",
  "graphagent.status",
  "help.show",
  "app.console",
  "app.debug",
  "app.heap_snapshot",
]

describe("builtin scope snapshots", () => {
  test("home", () => {
    const { registry, dispose } = builtins()
    expect(ids(registry, "home")).toEqual(HOME_IDS)
    dispose()
  })

  test("session", () => {
    const { registry, dispose } = builtins()
    expect(ids(registry, "session")).toEqual(SESSION_IDS)
    dispose()
  })

  test("subagent", () => {
    const { registry, dispose } = builtins()
    expect(ids(registry, "subagent")).toEqual(SUBAGENT_IDS)
    dispose()
  })

  test("subagent palette excludes session-only actions", () => {
    const { registry, dispose } = builtins()
    const subagent = new Set(ids(registry, "subagent"))
    for (const id of [
      "session.rename",
      "session.fork",
      "session.undo",
      "session.redo",
      "session.compact",
      "session.move",
      "session.btw",
      "session.timeline",
      "model.list",
      "agent.list",
      "prompt.editor",
      "prompt.skills",
      "diff.open",
      "hooks.list",
      "config.permissions",
    ]) {
      expect(subagent.has(id)).toBe(false)
    }
    dispose()
  })
})

describe("decommissioned commands", () => {
  const REMOVED = [
    "share",
    "unshare",
    "org",
    "orgs",
    "switch-org",
    "variants",
    "dag-cancel",
    "continue",
    "mo",
    "models",
    "mcps",
    "themes",
    "timestamps",
    "thinking",
  ]

  test("slash names and ids are absent from every scope", () => {
    const { registry, dispose } = builtins()
    for (const name of REMOVED) {
      expect(registry.find(name)).toBeUndefined()
      expect(registry.find(`/${name}`)).toBeUndefined()
    }
    for (const scope of ["home", "session", "subagent"] as const) {
      const values = ids(registry, scope)
      for (const name of REMOVED) expect(values).not.toContain(name)
      expect(values).not.toContain("variant.list")
      expect(values).not.toContain("org.list")
    }
    dispose()
  })

  test("renamed commands expose only the v2 surface", () => {
    const { registry, dispose } = builtins()
    expect(registry.find("model")?.id).toBe("model.list")
    expect(registry.find("mcp")?.id).toBe("mcp.list")
    expect(registry.find("theme")?.id).toBe("theme.switch")
    expect(registry.find("agents")?.id).toBe("agent.subagents")
    dispose()
  })
})

describe("alias matching", () => {
  test("slash prefixes are optional", () => {
    const { registry, dispose } = builtins()
    expect(registry.find("/clear")?.id).toBe("session.new")
    expect(registry.find("clear")?.id).toBe("session.new")
    expect(registry.find("/resume")?.id).toBe("session.list")
    expect(registry.find("summarize")?.id).toBe("session.compact")
    expect(registry.find("/settings")?.id).toBe("config.open")
    expect(registry.find("/q")?.id).toBe("app.exit")
    expect(registry.find("quit")?.id).toBe("app.exit")
    dispose()
  })

  test("slash completion rows carry display names and aliases", () => {
    const { registry, dispose } = builtins()
    const entries = slashCommandEntries(registry, "session")
    const byId = new Map(entries.map((entry) => [entry.spec.id, entry]))
    expect(byId.get("session.new")?.display).toBe("/new")
    expect(byId.get("session.new")?.aliases).toEqual(["/clear"])
    expect(byId.get("session.btw")?.requiresArgs).toBe(true)
    expect(byId.get("session.rename")?.requiresArgs).toBe(false)
    expect(byId.get("app.exit")?.aliases).toEqual(["/quit", "/q"])
    expect(byId.has("app.debug")).toBe(false)
    dispose()
  })
})

describe("duplicate registration", () => {
  test("builtin registered after a server command wins and logs one line", () => {
    const logs: string[] = []
    const registry = createCommandRegistry({ log: (message) => logs.push(message) })
    const server = serverCommandSpec({ name: "exit" }, () => {})!
    registry.register(server)
    const dispose = registerBuiltinCommands(registry)

    expect(registry.find("exit")?.source).toBe("builtin")
    expect(registry.find("exit")?.id).toBe("app.exit")
    expect(ids(registry, "session")).not.toContain("server.exit")
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('builtin "app.exit" wins over server "server.exit"')
    dispose()
  })

  test("builtin registered before a server command still wins with one line", () => {
    const logs: string[] = []
    const registry = createCommandRegistry({ log: (message) => logs.push(message) })
    const dispose = registerBuiltinCommands(registry)
    registry.register(serverCommandSpec({ name: "exit" }, () => {})!)

    expect(registry.find("exit")?.id).toBe("app.exit")
    expect(ids(registry, "session")).not.toContain("server.exit")
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('keeping "app.exit", ignoring "server.exit"')
    dispose()
  })

  test("duplicate ids and duplicate server names are ignored with one line each", () => {
    const logs: string[] = []
    const registry = createCommandRegistry({ log: (message) => logs.push(message) })
    const first = serverCommandSpec({ name: "demo" }, () => {})!
    registry.register(first)
    registry.register({ ...first, description: "same id again" })
    registry.register({ ...first, id: "server.demo-other" })

    expect(registry.list("session").filter((item) => item.slash?.name === "demo")).toHaveLength(1)
    expect(logs).toHaveLength(2)
    expect(logs[0]).toContain('duplicate id "server.demo"')
    expect(logs[1]).toContain('duplicate "/demo"')
  })
})

describe("visibility and execution", () => {
  test("hidden and disabled commands stay out of lists and slash resolution", () => {
    const registry = createCommandRegistry({ log: () => {} })
    const hidden = spec({ id: "test.hidden", hidden: true, slash: { name: "secret" } })
    const disabled = spec({ id: "test.disabled", enabled: () => false, slash: { name: "off" } })
    const visible = spec({ id: "test.visible", slash: { name: "shown" } })
    registry.register(hidden)
    registry.register(disabled)
    registry.register(visible)

    expect(ids(registry, "session")).toEqual(["test.visible"])
    expect(registry.find("secret")).toBe(hidden)
    expect(resolveSlashInput(registry, "session", "/secret")).toEqual({ kind: "message" })
    expect(resolveSlashInput(registry, "session", "/off")).toEqual({ kind: "message" })
    expect(resolveSlashInput(registry, "session", "/shown").kind).toBe("builtin")
  })

  test("hidden commands run for key origin only", async () => {
    const registry = createCommandRegistry({ log: () => {} })
    const calls: string[] = []
    registry.register(spec({ id: "test.hidden", hidden: true }))
    registry.setHandler("test.hidden", (ctx) => {
      calls.push(ctx.origin)
    })

    expect(await registry.run("test.hidden", { args: "", origin: "palette" })).toBe(false)
    expect(await registry.run("test.hidden", { args: "", origin: "key" })).toBe(true)
    expect(calls).toEqual(["key"])
  })

  test("unknown ids and missing handlers return false", async () => {
    const registry = createCommandRegistry({ log: () => {} })
    registry.register(spec({ id: "test.no-handler" }))
    expect(await registry.run("test.missing", { args: "", origin: "palette" })).toBe(false)
    expect(await registry.run("test.no-handler", { args: "", origin: "palette" })).toBe(false)
  })
})

describe("list caching", () => {
  test("scope lists and slash entries are reused until the command set changes", () => {
    let enabledChecks = 0
    const registry = createCommandRegistry({ log: () => {} })
    const dispose = registry.register(
      spec({
        id: "test.cached",
        slash: { name: "cached" },
        enabled: () => {
          enabledChecks++
          return true
        },
      }),
    )

    const version = registry.version()
    const firstList = registry.list("session")
    expect(enabledChecks).toBe(1)
    const firstEntries = slashCommandEntries(registry, "session")
    const secondEntries = slashCommandEntries(registry, "session")
    expect(registry.list("session")).toBe(firstList)
    expect(secondEntries).toBe(firstEntries)
    expect(enabledChecks).toBe(1)
    expect(registry.version()).toBe(version)

    const detach = registry.setHandler("test.cached", () => {})
    expect(registry.version()).toBe(version)
    expect(slashCommandEntries(registry, "session")).toBe(firstEntries)
    detach()

    const extra = registry.register(spec({ id: "test.extra", slash: { name: "extra" } }))
    expect(registry.version()).toBe(version + 1)
    expect(registry.list("session")).not.toBe(firstList)
    expect(slashCommandEntries(registry, "session")).not.toBe(firstEntries)
    expect(enabledChecks).toBe(2)

    extra()
    dispose()
  })
})

describe("server commands", () => {
  const NAMES = ["init", "review", "goal", "subgoal", "memory", "dag-auto", "import-claude", "create-hook"]

  test("v2 server commands are listed and submitted through one path", () => {
    const { registry, dispose } = builtins()
    const runs: string[] = []
    const disposers = NAMES.map((name) =>
      registry.register(
        serverCommandSpec({ name }, (ctx) => {
          runs.push(`${name}:${ctx.args}`)
        })!,
      ),
    )

    for (const name of NAMES) {
      expect(registry.find(name)?.id).toBe(`server.${name}`)
      expect(registry.find(name)?.source).toBe("server")
      expect(ids(registry, "session")).toContain(`server.${name}`)
      expect(ids(registry, "home")).not.toContain(`server.${name}`)
      expect(resolveSlashInput(registry, "session", `/${name} payload`)).toMatchObject({
        kind: "server",
        name,
        args: "payload",
      })
    }
    expect(resolveSlashInput(registry, "home", "/goal payload")).toEqual({ kind: "message" })

    const goal = registry.find("goal")!
    void registry.run(goal.id, { args: "payload", origin: "slash" })
    expect(runs).toEqual(["goal:payload"])

    for (const disposeServer of disposers) disposeServer()
    dispose()
  })

  test("mcp commands keep the display suffix and skill entries are excluded", () => {
    const { registry, dispose } = builtins()
    registry.register(serverCommandSpec({ name: "browser", source: "mcp" }, () => {})!)
    expect(serverCommandSpec({ name: "skillful", source: "skill" }, () => {})).toBeUndefined()

    const entry = slashCommandEntries(registry, "session").find((item) => item.spec.id === "server.browser")
    expect(entry?.display).toBe("/browser:mcp")
    expect(resolveSlashInput(registry, "session", "/browser open")).toMatchObject({
      kind: "server",
      name: "browser",
      args: "open",
    })
    dispose()
  })

  test("commands with an argument table advertise optional args", () => {
    const { registry, dispose } = builtins()
    registry.register(serverCommandSpec({ name: "dag-mode" }, () => {})!)
    const spec = registry.find("dag-mode")!
    expect(spec.slash?.args).toBe("optional")
    expect(
      slashCommandEntries(registry, "session").find((entry) => entry.spec.id === "server.dag-mode")?.requiresArgs,
    ).toBe(false)
    dispose()
  })
})

describe("resolveSlashInput submission rules", () => {
  test("builtin commands resolve locally, including aliases", () => {
    const { registry, dispose } = builtins()
    expect(resolveSlashInput(registry, "session", "/exit")).toMatchObject({
      kind: "builtin",
      spec: { id: "app.exit" },
      args: "",
    })
    expect(resolveSlashInput(registry, "session", "/quit")).toMatchObject({
      kind: "builtin",
      spec: { id: "app.exit" },
    })
    expect(resolveSlashInput(registry, "session", "/q")).toMatchObject({
      kind: "builtin",
      spec: { id: "app.exit" },
    })
    expect(resolveSlashInput(registry, "home", "/new")).toMatchObject({
      kind: "builtin",
      spec: { id: "session.new" },
    })
    dispose()
  })

  test("commands without a slash are normal messages", () => {
    const { registry, dispose } = builtins()
    for (const input of ["exit", "quit", ":q", "/nope", "/", "/ "]) {
      expect(resolveSlashInput(registry, "session", input)).toEqual({ kind: "message" })
    }
    dispose()
  })

  test("commands outside the active scope are normal messages", () => {
    const { registry, dispose } = builtins()
    expect(resolveSlashInput(registry, "subagent", "/rename title")).toEqual({ kind: "message" })
    expect(resolveSlashInput(registry, "subagent", "/model")).toEqual({ kind: "message" })
    expect(resolveSlashInput(registry, "subagent", "/btw question")).toEqual({ kind: "message" })
    expect(resolveSlashInput(registry, "home", "/goal target")).toEqual({ kind: "message" })
    expect(resolveSlashInput(registry, "home", "/dag")).toEqual({ kind: "message" })
    dispose()
  })

  test("arguments preserve spacing and multiple lines", () => {
    const { registry, dispose } = builtins()
    expect(resolveSlashInput(registry, "session", "/btw hello\nsecond line")).toMatchObject({
      kind: "builtin",
      args: "hello\nsecond line",
    })
    expect(resolveSlashInput(registry, "session", "/btw    spaced")).toMatchObject({
      kind: "builtin",
      args: "   spaced",
    })
    expect(resolveSlashInput(registry, "session", "/rename  ")).toMatchObject({
      kind: "builtin",
      args: " ",
    })
    dispose()
  })

  test("server commands in session scope resolve to server submission", () => {
    const { registry, dispose } = builtins()
    registry.register(serverCommandSpec({ name: "init" }, () => {})!)
    registry.register(serverCommandSpec({ name: "dag-mode" }, () => {})!)
    expect(resolveSlashInput(registry, "session", "/init")).toMatchObject({
      kind: "server",
      name: "init",
      args: "",
    })
    expect(resolveSlashInput(registry, "session", "/dag-mode on\nreason")).toMatchObject({
      kind: "server",
      name: "dag-mode",
      args: "on\nreason",
    })
    dispose()
  })
})

describe("server command source filtering", () => {
  test("skill sources are not registered", () => {
    const { registry, dispose } = builtins()
    const command: ServerCommandLike = { name: "from-skill", source: "skill" }
    expect(serverCommandSpec(command, () => {})).toBeUndefined()
    expect(registry.find("from-skill")).toBeUndefined()
    dispose()
  })
})
