import { test, expect, describe, afterEach, beforeEach, spyOn } from "bun:test"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { ConfigCompaction } from "@opencode-ai/core/config/compaction"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Cause, Effect, Exit, Layer } from "effect"
import { logLines } from "effect/testing/TestConsole"
import { NamedError } from "@opencode-ai/core/util/error"
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http"
import { NodeFileSystem, NodePath } from "@effect/platform-node"
import { Config } from "@/config/config"
import { ConfigManaged } from "@/config/managed"
import { ConfigParse } from "../../src/config/parse"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"

import { InstanceRef } from "../../src/effect/instance-ref"
import type { InstanceContext } from "../../src/project/instance-context"
import { Auth } from "../../src/auth"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Env } from "../../src/env"
import {
  provideTmpdirInstance,
  TestInstance,
  tmpdir,
  tmpdirScoped,
  withTestInstance,
  provideInstanceEffect,
  reloadInstance,
  testInstanceStoreLayer,
} from "../fixture/fixture"
import { InstanceRuntime } from "@/project/instance-runtime"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { testEffect } from "../lib/effect"
import path from "path"
import fs from "fs/promises"
import os from "os"
import { Global } from "@opencode-ai/core/global"
import { ProjectV2 } from "@opencode-ai/core/project"
import { Filesystem } from "@/util/filesystem"
import { AuthTest } from "../fake/auth"
import { NpmTest } from "../fake/npm"

/** Infra layer that provides FileSystem, Path, ChildProcessSpawner for test fixtures */
const infra = CrossSpawnSpawner.defaultLayer.pipe(
  Layer.provideMerge(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
)

const testFlock = EffectFlock.defaultLayer

const unexpectedHttp = HttpClient.make((request) =>
  Effect.die(`unexpected http request: ${request.method} ${request.url}`),
)

const json = (request: Parameters<typeof HttpClientResponse.fromWeb>[0], body: unknown, status = 200) =>
  HttpClientResponse.fromWeb(
    request,
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  )

const wellKnownAuth = (url: string) =>
  Layer.mock(Auth.Service)({
    all: () =>
      Effect.succeed({
        [url]: new Auth.WellKnown({ type: "wellknown", key: "TEST_TOKEN", token: "test-token" }),
      }),
  })

function remoteConfigClient(input: {
  wellKnown: unknown
  remote?: unknown
  remoteHtml?: string
  seen: { wellKnown?: string; remote?: string; authorization?: string }
}) {
  return HttpClient.make((request) => {
    if (request.url.includes(".well-known/graphagent")) {
      input.seen.wellKnown = request.url
      return Effect.succeed(json(request, input.wellKnown))
    }
    if (request.url.includes("config.example.com") && (input.remote !== undefined || input.remoteHtml !== undefined)) {
      input.seen.remote = request.url
      input.seen.authorization = request.headers.authorization
      if (input.remoteHtml !== undefined) {
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(input.remoteHtml, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }),
          ),
        )
      }
      return Effect.succeed(json(request, input.remote))
    }
    return Effect.succeed(json(request, {}, 404))
  })
}

const configLayer = (
  options: {
    auth?: Layer.Layer<Auth.Service>
    client?: HttpClient.HttpClient
  } = {},
) =>
  Config.layer.pipe(
    Layer.provide(testFlock),
    Layer.provide(Env.defaultLayer),
    Layer.provide(options.auth ?? AuthTest.empty),
    Layer.provideMerge(infra),
    Layer.provide(NpmTest.noop),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, options.client ?? unexpectedHttp)),
    Layer.provideMerge(FSUtil.defaultLayer),
  )

const layer = configLayer()

const it = testEffect(layer)
const configIt = (options?: Parameters<typeof configLayer>[0]) => testEffect(configLayer(options))

const CONFIG_SCHEMA_URL = "https://raw.githubusercontent.com/LeXwDeX/GraphAgent/main/schema/config.json"
const schemaConfig = (config: object) => ({ $schema: CONFIG_SCHEMA_URL, ...config })

const provideCurrentInstance = <A, E, R>(effect: Effect.Effect<A, E, R>, ctx: InstanceContext) =>
  effect.pipe(Effect.provideService(InstanceRef, ctx))

const load = (ctx: InstanceContext) =>
  Effect.runPromise(
    Config.Service.use((svc) => provideCurrentInstance(svc.get(), ctx)).pipe(Effect.scoped, Effect.provide(layer)),
  )
const clearEffect = (wait = false) =>
  Config.use
    .invalidate()
    .pipe(
      Effect.scoped,
      Effect.provide(layer),
      Effect.andThen(wait ? Effect.promise(() => InstanceRuntime.disposeAllInstances()) : Effect.void),
    )
const clear = (wait = false) => Effect.runPromise(clearEffect(wait))
// Get managed config directory from environment (set in preload.ts)
const managedConfigDir = process.env.GRAPHAGENT_TEST_MANAGED_CONFIG_DIR!
const originalTestToken = process.env.TEST_TOKEN

beforeEach(async () => {
  await clear(true)
})

afterEach(async () => {
  await fs.rm(managedConfigDir, { force: true, recursive: true }).catch(() => {})
  if (originalTestToken === undefined) delete process.env.TEST_TOKEN
  else process.env.TEST_TOKEN = originalTestToken
  await clear(true)
})

const writeManagedSettingsEffect = (settings: object, filename?: string) =>
  FSUtil.use.writeWithDirs(path.join(managedConfigDir, filename ?? "graphagent.json"), JSON.stringify(settings))

async function writeConfig(dir: string, config: object, name = "graphagent.json") {
  await Filesystem.write(path.join(dir, name), JSON.stringify(config))
}

const writeConfigEffect = (dir: string, config: object, name = "graphagent.json") =>
  FSUtil.use.writeWithDirs(path.join(dir, name), JSON.stringify(config))

const withInstanceDir = <A, E, R>(dir: string, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provideService(TestInstance, { directory: dir }),
    provideInstanceEffect(dir),
    Effect.provide(testInstanceStoreLayer),
    Effect.provide(CrossSpawnSpawner.defaultLayer),
  )

const withGlobalConfigDir = <A, E, R>(dir: string, effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.gen(function* () {
      const previous = process.env.GRAPHAGENT_TEST_CONFIG_DIR
      process.env.GRAPHAGENT_TEST_CONFIG_DIR = dir
      yield* clearEffect(true)
      return previous
    }),
    () => effect,
    (previous) =>
      Effect.gen(function* () {
        if (previous === undefined) delete process.env.GRAPHAGENT_TEST_CONFIG_DIR
        else process.env.GRAPHAGENT_TEST_CONFIG_DIR = previous
        yield* clearEffect(true)
      }),
  )

const withGlobalConfig = <A, E, R>(
  input: { config?: object; name?: string },
  fn: (input: { dir: string }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    if (input.config) yield* writeConfigEffect(dir, schemaConfig(input.config), input.name)
    return yield* withGlobalConfigDir(dir, fn({ dir }))
  })

const withConfigTree = <A, E, R>(
  input: { global?: object; project?: object; local?: object },
  effect: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped()
    const global = yield* tmpdirScoped()
    const directory = path.join(root, "project")
    yield* Effect.all(
      [
        input.global ? writeConfigEffect(global, schemaConfig(input.global)) : undefined,
        input.project ? writeConfigEffect(directory, schemaConfig(input.project)) : undefined,
        input.local ? writeConfigEffect(path.join(directory, ".agents"), schemaConfig(input.local)) : undefined,
      ].filter((effect): effect is Effect.Effect<void, FSUtil.Error, FSUtil.Service> => effect !== undefined),
      { concurrency: "unbounded" },
    )
    return yield* withGlobalConfigDir(global, withInstanceDir(directory, effect))
  })

const wellKnown = (input: {
  authUrl?: string
  config?: unknown
  remoteConfig?: { url: string; headers?: Record<string, string> }
  remote?: unknown
  remoteHtml?: string
  wellKnown?: unknown
}) => {
  const seen: { wellKnown?: string; remote?: string; authorization?: string } = {}
  const client = remoteConfigClient({
    seen,
    wellKnown: input.wellKnown ?? {
      ...(input.config !== undefined ? { config: input.config } : {}),
      ...(input.remoteConfig !== undefined ? { remote_config: input.remoteConfig } : {}),
    },
    remote: input.remote,
    remoteHtml: input.remoteHtml,
  })
  return {
    seen,
    it: configIt({ auth: wellKnownAuth(input.authUrl ?? "https://example.com"), client }),
  }
}

function withProcessEnv<A, E, R>(key: string, value: string | undefined, effect: Effect.Effect<A, E, R>) {
  return withProcessEnvs({ [key]: value }, effect)
}

function withProcessEnvs<A, E, R>(entries: Record<string, string | undefined>, effect: Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const originals: Record<string, string | undefined> = {}
      for (const [key, value] of Object.entries(entries)) {
        originals[key] = process.env[key]
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      return originals
    }),
    () => effect,
    (originals) =>
      Effect.sync(() => {
        for (const [key, original] of Object.entries(originals)) {
          if (original !== undefined) process.env[key] = original
          else delete process.env[key]
        }
      }),
  )
}

async function check(map: (dir: string) => string) {
  if (process.platform !== "win32") return
  await using globalTmp = await tmpdir()
  await using tmp = await tmpdir({ git: true, config: { snapshot: true } })
  const prev = process.env.GRAPHAGENT_TEST_CONFIG_DIR
  process.env.GRAPHAGENT_TEST_CONFIG_DIR = globalTmp.path
  await clear()
  try {
    await writeConfig(globalTmp.path, {
      $schema: "https://opencode.ai/config.json",
      snapshot: false,
    })
    await withTestInstance({
      directory: map(tmp.path),
      fn: async (ctx) => {
        const cfg = await load(ctx)
        expect(cfg.snapshot).toBe(true)
        expect(ctx.directory).toBe(Filesystem.resolve(tmp.path))
        expect(ctx.project.id).not.toBe(ProjectV2.ID.global)
      },
    })
  } finally {
    await InstanceRuntime.disposeAllInstances()
    if (prev === undefined) delete process.env.GRAPHAGENT_TEST_CONFIG_DIR
    else process.env.GRAPHAGENT_TEST_CONFIG_DIR = prev
    await clear()
  }
}

it.instance("loads config with defaults when no files exist", () =>
  Effect.gen(function* () {
    const config = yield* Config.use.get()
    expect(config.username).toBeDefined()
  }),
)

it.instance("falls back to generic username when system user info is unavailable", () =>
  Effect.gen(function* () {
    const userInfo = spyOn(os, "userInfo").mockImplementation(() => {
      throw Object.assign(new Error("missing passwd entry"), { code: "ENOENT" })
    })
    try {
      const config = yield* Config.use.get()
      expect(config.username).toBe("user")
    } finally {
      userInfo.mockRestore()
    }
  }),
)

it.effect("creates global jsonc config with schema when no global configs exist", () =>
  withGlobalConfig({}, ({ dir }) =>
    Effect.gen(function* () {
      yield* Config.use.get().pipe(provideInstanceEffect(dir))

      const content = yield* FSUtil.use.readFileString(path.join(dir, "graphagent.jsonc"))
      expect(content).toContain(`"$schema": "${CONFIG_SCHEMA_URL}"`)
    }).pipe(Effect.provide(testInstanceStoreLayer), Effect.provide(CrossSpawnSpawner.defaultLayer)),
  ),
)

it.effect("does not create global config when GRAPHAGENT_CONFIG_DIR is set", () =>
  Effect.gen(function* () {
    const custom = yield* tmpdirScoped()
    yield* withGlobalConfig({}, ({ dir }) =>
      withProcessEnv(
        "GRAPHAGENT_CONFIG_DIR",
        custom,
        Effect.gen(function* () {
          yield* Config.use.get().pipe(provideInstanceEffect(dir))

          expect(yield* FSUtil.use.existsSafe(path.join(dir, "graphagent.jsonc"))).toBe(false)
        }).pipe(Effect.provide(testInstanceStoreLayer), Effect.provide(CrossSpawnSpawner.defaultLayer)),
      ),
    )
  }),
)

it.instance(
  "loads JSON config file",
  Effect.gen(function* () {
    const config = yield* Config.use.get()
    expect(config.model).toBe("test/model")
    expect(config.username).toBe("testuser")
  }),
  { config: { model: "test/model", username: "testuser" } },
)

it.instance(
  "loads shell config field",
  Effect.gen(function* () {
    const config = yield* Config.use.get()
    expect(config.shell).toBe("bash")
  }),
  { config: { shell: "bash" } },
)

it.instance("updates config and preserves empty shell sentinel", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* writeConfigEffect(
      test.directory,
      { $schema: "https://opencode.ai/config.json", shell: "bash" },
      "config.json",
    )

    yield* Config.Service.use((svc) => svc.update(ConfigParse.schema(ConfigV1.Info, { shell: "" }, "test:config")))

    const writtenConfig = yield* FSUtil.use.readJson(path.join(test.directory, "config.json"))
    expect(writtenConfig).toMatchObject({ shell: "" })
  }),
)

it.effect("updates global config and omits empty shell key in json", () =>
  withGlobalConfig({ config: { shell: "bash" } }, ({ dir }) =>
    Effect.gen(function* () {
      yield* Config.use.updateGlobal({ shell: "" })

      const writtenConfig = yield* FSUtil.use.readJson(path.join(dir, "graphagent.json"))
      expect(writtenConfig).not.toHaveProperty("shell")
    }),
  ),
)

it.effect("updates global config and omits empty shell key in jsonc", () =>
  withGlobalConfig({ config: { shell: "bash", model: "test/model" }, name: "graphagent.jsonc" }, ({ dir }) =>
    Effect.gen(function* () {
      yield* Config.use.updateGlobal({ shell: "" })

      const file = path.join(dir, "graphagent.jsonc")
      const writtenConfig = yield* FSUtil.use.readFileString(file)
      const parsed = ConfigParse.schema(ConfigV1.Info, ConfigParse.jsonc(writtenConfig, file), file)
      expect(writtenConfig).not.toContain('"shell"')
      expect(parsed.shell).toBeUndefined()
      expect(parsed.model).toBe("test/model")
    }),
  ),
)

it.instance(
  "loads formatter boolean config",
  Effect.gen(function* () {
    const config = yield* Config.use.get()
    expect(config.formatter).toBe(true)
  }),
  { config: { formatter: true } },
)

it.instance(
  "loads lsp boolean config",
  Effect.gen(function* () {
    const config = yield* Config.use.get()
    expect(config.lsp).toBe(true)
  }),
  { config: { lsp: true } },
)

test("loads project config from Git Bash and MSYS2 paths on Windows", async () => {
  // Git Bash and MSYS2 both use /<drive>/... paths on Windows.
  await check((dir) => {
    const drive = dir[0].toLowerCase()
    const rest = dir.slice(2).replaceAll("\\", "/")
    return `/${drive}${rest}`
  })
})

test("loads project config from Cygwin paths on Windows", async () => {
  await check((dir) => {
    const drive = dir[0].toLowerCase()
    const rest = dir.slice(2).replaceAll("\\", "/")
    return `/cygdrive/${drive}${rest}`
  })
})

it.instance("ignores legacy tui keys in opencode config", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* writeConfigEffect(test.directory, {
      $schema: "https://opencode.ai/config.json",
      model: "test/model",
      theme: "legacy",
      tui: { scroll_speed: 4 },
    })

    const config = yield* Config.use.get()
    expect(config.model).toBe("test/model")
    expect((config as Record<string, unknown>).theme).toBeUndefined()
    expect((config as Record<string, unknown>).tui).toBeUndefined()
  }),
)

it.instance("loads JSONC config file", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* FSUtil.use.writeWithDirs(
      path.join(test.directory, "graphagent.jsonc"),
      `{
        // This is a comment
        "$schema": "https://opencode.ai/config.json",
        "model": "test/model",
        "username": "testuser"
      }`,
    )
    const config = yield* Config.use.get()
    expect(config.model).toBe("test/model")
    expect(config.username).toBe("testuser")
  }),
)

it.instance("jsonc overrides json in the same directory", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* writeConfigEffect(
      test.directory,
      {
        $schema: "https://opencode.ai/config.json",
        model: "base",
        username: "base",
      },
      "graphagent.jsonc",
    )
    yield* writeConfigEffect(test.directory, {
      $schema: "https://opencode.ai/config.json",
      model: "override",
    })
    const config = yield* Config.use.get()
    expect(config.model).toBe("base")
    expect(config.username).toBe("base")
  }),
)

it.instance("handles environment variable substitution", () =>
  withProcessEnv(
    "TEST_VAR",
    "test-user",
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* writeConfigEffect(test.directory, {
        $schema: "https://opencode.ai/config.json",
        username: "{env:TEST_VAR}",
      })
      const config = yield* Config.use.get()
      expect(config.username).toBe("test-user")
    }),
  ),
)

it.instance("preserves env variables when adding $schema to config", () =>
  withProcessEnv(
    "PRESERVE_VAR",
    "secret_value",
    Effect.gen(function* () {
      const test = yield* TestInstance
      // Config without $schema - should trigger auto-add
      yield* FSUtil.use.writeWithDirs(
        path.join(test.directory, "graphagent.json"),
        JSON.stringify({ username: "{env:PRESERVE_VAR}" }),
      )
      const config = yield* Config.use.get()
      expect(config.username).toBe("secret_value")

      // Read the file to verify the env variable was preserved
      const content = yield* FSUtil.use.readFileString(path.join(test.directory, "graphagent.json"))
      expect(content).toContain("{env:PRESERVE_VAR}")
      expect(content).not.toContain("secret_value")
      expect(content).toContain("$schema")
    }),
  ),
)

it.instance("handles file inclusion substitution", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* FSUtil.use.writeWithDirs(path.join(test.directory, "included.txt"), "test-user")
    yield* writeConfigEffect(test.directory, {
      $schema: "https://opencode.ai/config.json",
      username: "{file:included.txt}",
    })
    const config = yield* Config.use.get()
    expect(config.username).toBe("test-user")
  }),
)

it.instance("handles file inclusion with replacement tokens", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* FSUtil.use.writeWithDirs(path.join(test.directory, "included.md"), "const out = await Bun.$`echo hi`")
    yield* writeConfigEffect(test.directory, {
      $schema: "https://opencode.ai/config.json",
      username: "{file:included.md}",
    })
    const config = yield* Config.use.get()
    expect(config.username).toBe("const out = await Bun.$`echo hi`")
  }),
)

it.instance("validates config schema and throws on invalid values", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* writeConfigEffect(test.directory, {
      $schema: "https://opencode.ai/config.json",
      model: 42,
    })
    const exit = yield* Config.use.get().pipe(Effect.exit)
    expect(Exit.isFailure(exit)).toBe(true)
  }),
)

it.instance("throws error for invalid JSON", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* FSUtil.use.writeWithDirs(path.join(test.directory, "graphagent.json"), "{ invalid json }")
    const exit = yield* Config.use.get().pipe(Effect.exit)
    expect(Exit.isFailure(exit)).toBe(true)
  }),
)

it.instance("handles agent configuration", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* writeConfigEffect(test.directory, {
      $schema: "https://opencode.ai/config.json",
      agent: {
        test_agent: {
          model: "test/model",
          temperature: 0.7,
          description: "test agent",
        },
      },
    })
    const config = yield* Config.use.get()
    expect(config.agent?.["test_agent"]).toEqual(
      expect.objectContaining({
        model: "test/model",
        temperature: 0.7,
        description: "test agent",
      }),
    )
  }),
)

it.instance("treats agent variant as model-scoped setting (not provider option)", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* writeConfigEffect(test.directory, {
      $schema: "https://opencode.ai/config.json",
      agent: {
        test_agent: {
          model: "openai/gpt-5.2",
          variant: "xhigh",
          max_tokens: 123,
        },
      },
    })
    const config = yield* Config.use.get()
    const agent = config.agent?.["test_agent"]

    expect(agent?.variant).toBe("xhigh")
    expect(agent?.options).toMatchObject({
      max_tokens: 123,
    })
    expect(agent?.options).not.toHaveProperty("variant")
  }),
)

it.instance("handles command configuration", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* writeConfigEffect(test.directory, {
      $schema: "https://opencode.ai/config.json",
      command: {
        test_command: {
          template: "test template",
          description: "test command",
          agent: "test_agent",
        },
      },
    })
    const config = yield* Config.use.get()
    expect(config.command?.["test_command"]).toEqual({
      template: "test template",
      description: "test command",
      agent: "test_agent",
    })
  }),
)

it.instance("migrates mode field to agent field", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* writeConfigEffect(test.directory, {
      $schema: "https://opencode.ai/config.json",
      mode: {
        test_mode: {
          model: "test/model",
          temperature: 0.5,
        },
      },
    })
    const config = yield* Config.use.get()
    expect(config.agent?.["test_mode"]).toEqual({
      model: "test/model",
      temperature: 0.5,
      mode: "primary",
      options: {},
      permission: {},
    })
  }),
)

it.instance("accepts the deprecated reference field", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* writeConfigEffect(test.directory, {
      $schema: "https://opencode.ai/config.json",
      reference: {
        local: { path: "../library" },
        sdk: { repository: "github.com/example/sdk", branch: "main" },
        shorthand: "github.com/example/docs",
      },
    })
    const config = yield* Config.use.get()
    expect(config.reference).toEqual({
      local: { path: "../library" },
      sdk: { repository: "github.com/example/sdk", branch: "main" },
      shorthand: "github.com/example/docs",
    })
  }),
)

it.instance("loads config from .agents directory", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* FSUtil.use.writeWithDirs(
      path.join(test.directory, ".agents", "agent", "test.md"),
      `---
model: test/model
---
Test agent prompt`,
    )

    const config = yield* Config.use.get()
    expect(config.agent?.["test"]).toEqual(
      expect.objectContaining({
        name: "test",
        model: "test/model",
        prompt: "Test agent prompt",
      }),
    )
  }),
)

it.instance("agent markdown permission config preserves user key order", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* FSUtil.use.writeWithDirs(
      path.join(test.directory, ".agents", "agent", "ordered.md"),
      `---
permission:
  bash: allow
  "*": deny
  edit: ask
---
Ordered permissions`,
    )

    const config = yield* Config.use.get()
    expect(Object.keys(config.agent?.ordered?.permission ?? {})).toEqual(["bash", "*", "edit"])
  }),
)

it.instance("loads agents from .agents/agents (plural)", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* FSUtil.use.writeWithDirs(
      path.join(test.directory, ".agents", "agents", "helper.md"),
      `---
model: test/model
mode: subagent
---
Helper agent prompt`,
    )

    yield* FSUtil.use.writeWithDirs(
      path.join(test.directory, ".agents", "agents", "nested", "child.md"),
      `---
model: test/model
mode: subagent
---
Nested agent prompt`,
    )

    const config = yield* Config.use.get()

    expect(config.agent?.["helper"]).toMatchObject({
      name: "helper",
      model: "test/model",
      mode: "subagent",
      prompt: "Helper agent prompt",
    })

    expect(config.agent?.["nested/child"]).toMatchObject({
      name: "nested/child",
      model: "test/model",
      mode: "subagent",
      prompt: "Nested agent prompt",
    })
  }),
)

it.instance("loads commands from .agents/command (singular)", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* FSUtil.use.writeWithDirs(
      path.join(test.directory, ".agents", "command", "hello.md"),
      `---
description: Test command
---
Hello from singular command`,
    )

    yield* FSUtil.use.writeWithDirs(
      path.join(test.directory, ".agents", "command", "nested", "child.md"),
      `---
description: Nested command
---
Nested command template`,
    )

    const config = yield* Config.use.get()

    expect(config.command?.["hello"]).toEqual({
      description: "Test command",
      template: "Hello from singular command",
    })

    expect(config.command?.["nested/child"]).toEqual({
      description: "Nested command",
      template: "Nested command template",
    })
  }),
)

it.instance("loads commands from .agents/commands (plural)", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* FSUtil.use.writeWithDirs(
      path.join(test.directory, ".agents", "commands", "hello.md"),
      `---
description: Test command
---
Hello from plural commands`,
    )

    yield* FSUtil.use.writeWithDirs(
      path.join(test.directory, ".agents", "commands", "nested", "child.md"),
      `---
description: Nested command
---
Nested command template`,
    )

    const config = yield* Config.use.get()

    expect(config.command?.["hello"]).toEqual({
      description: "Test command",
      template: "Hello from plural commands",
    })

    expect(config.command?.["nested/child"]).toEqual({
      description: "Nested command",
      template: "Nested command template",
    })
  }),
)

it.instance("updates config and writes to file", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* Config.Service.use((svc) =>
      svc.update(ConfigParse.schema(ConfigV1.Info, { model: "updated/model" }, "test:config")),
    )

    const writtenConfig = yield* FSUtil.use.readJson(path.join(test.directory, "config.json"))
    expect(writtenConfig).toMatchObject({ model: "updated/model" })
  }),
)

it.instance("gets config directories", () =>
  Effect.gen(function* () {
    const dirs = yield* Config.use.directories()
    expect(dirs.length).toBeGreaterThanOrEqual(1)
  }),
)

it.effect("does not try to install dependencies in read-only GRAPHAGENT_CONFIG_DIR", () =>
  Effect.gen(function* () {
    if (process.platform === "win32") return

    const dir = yield* tmpdirScoped()
    const readonly = path.join(dir, "readonly")
    yield* FSUtil.use.ensureDir(readonly)
    yield* FSUtil.use.chmod(readonly, 0o555)
    yield* Effect.addFinalizer(() => FSUtil.use.chmod(readonly, 0o755).pipe(Effect.ignore))

    yield* withProcessEnv("GRAPHAGENT_CONFIG_DIR", readonly, Config.use.get().pipe(provideInstanceEffect(dir)))
  }).pipe(Effect.provide(testInstanceStoreLayer), Effect.provide(CrossSpawnSpawner.defaultLayer)),
)

// Note: deduplication and serialization of npm installs is now handled by the
// core Npm.Service (via EffectFlock). Those behaviors are tested in the core
// package's npm tests, not here.

it.effect("global config remains global when project config is disabled", () =>
  withConfigTree(
    {
      global: { model: "global/model" },
      project: { model: "project/model" },
      local: { model: "local/model" },
    },
    withProcessEnv(
      "GRAPHAGENT_DISABLE_PROJECT_CONFIG",
      "true",
      Effect.gen(function* () {
        const config = yield* Config.use.get()
        expect(config.model).toBe("global/model")
      }),
    ),
  ),
)

describe("dynamic compaction configuration", () => {
  const resolve = (config: ConfigV1.Info) =>
    ConfigCompaction.resolveDynamic({
      disabledByEnvironment: false,
      dynamic: config.compaction?.dynamic,
      prune: config.compaction?.prune,
    })

  it.instance("defaults off after loading without manufacturing explicit config", () =>
    Effect.gen(function* () {
      const config = yield* Config.use.get()
      expect(config.compaction?.dynamic).toBeUndefined()
      expect(config.compaction?.prune).toBeUndefined()
      expect(resolve(config)).toMatchObject({
        enabled: false,
        source: "default",
        deprecatedPrune: false,
        skipped: "disabled",
      })
    }),
  )

  it.effect("lets project dynamic override the global dynamic value", () =>
    withConfigTree(
      {
        global: { compaction: { dynamic: false } },
        project: { compaction: { dynamic: true } },
      },
      Effect.gen(function* () {
        const config = yield* Config.use.get()
        expect(config.compaction?.dynamic).toBe(true)
        expect(resolve(config)).toMatchObject({ enabled: true, source: "dynamic" })
      }),
    ),
  )

  it.effect("lets project dynamic disable override the global value", () =>
    withConfigTree(
      {
        global: { compaction: { dynamic: true } },
        project: { compaction: { dynamic: false } },
      },
      Effect.gen(function* () {
        const config = yield* Config.use.get()
        expect(config.compaction?.dynamic).toBe(false)
        expect(resolve(config)).toMatchObject({ enabled: false, source: "dynamic", skipped: "disabled" })
      }),
    ),
  )

  it.effect("resolves new and legacy fields only after layered merge", () =>
    withConfigTree(
      {
        global: { compaction: { dynamic: false } },
        project: { compaction: { prune: true } },
      },
      Effect.gen(function* () {
        const config = yield* Config.use.get()
        expect(config.compaction).toMatchObject({ dynamic: false, prune: true })
        expect(resolve(config)).toMatchObject({ enabled: false, source: "dynamic", deprecatedPrune: false })
      }),
    ),
  )

  it.instance(
    "lets GRAPHAGENT_DISABLE_PRUNE override explicit dynamic enablement",
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const previous = Flag.GRAPHAGENT_DISABLE_PRUNE
        Flag.GRAPHAGENT_DISABLE_PRUNE = true
        return previous
      }),
      () =>
        Effect.gen(function* () {
          const config = yield* Config.use.get()
          expect(config.compaction).toMatchObject({ dynamic: false, prune: false })
        }),
      (previous) => Effect.sync(() => void (Flag.GRAPHAGENT_DISABLE_PRUNE = previous)),
    ),
    { config: { compaction: { dynamic: true, prune: true } } },
  )

  it.instance(
    "keeps automatic full compaction independent from dynamic folding",
    Effect.gen(function* () {
      const config = yield* Config.use.get()
      expect(config.compaction?.auto).toBe(false)
      expect(resolve(config)).toMatchObject({ enabled: false, source: "default", skipped: "disabled" })
    }),
    { config: { compaction: { auto: false } } },
  )

  it.instance(
    "keeps GRAPHAGENT_DISABLE_AUTOCOMPACT independent from dynamic folding",
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const previous = Flag.GRAPHAGENT_DISABLE_AUTOCOMPACT
        Flag.GRAPHAGENT_DISABLE_AUTOCOMPACT = true
        return previous
      }),
      () =>
        Effect.gen(function* () {
          const config = yield* Config.use.get()
          expect(config.compaction).toMatchObject({ auto: false, dynamic: true })
          expect(resolve(config)).toMatchObject({ enabled: true, source: "dynamic" })
        }),
      (previous) => Effect.sync(() => void (Flag.GRAPHAGENT_DISABLE_AUTOCOMPACT = previous)),
    ),
    { config: { compaction: { auto: true, dynamic: true } } },
  )
})

it.instance("does not error when only custom agent is a subagent", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* FSUtil.use.writeWithDirs(
      path.join(test.directory, ".agents", "agent", "helper.md"),
      `---
model: test/model
mode: subagent
---
Helper subagent prompt`,
    )

    const config = yield* Config.use.get()
    expect(config.agent?.["helper"]).toMatchObject({
      name: "helper",
      model: "test/model",
      mode: "subagent",
      prompt: "Helper subagent prompt",
    })
  }),
)

it.effect("merges instructions arrays from global and local configs", () =>
  withConfigTree(
    {
      global: { instructions: ["global-instructions.md", "shared-rules.md"] },
      local: { instructions: ["local-instructions.md"] },
    },
    Effect.gen(function* () {
      expect((yield* Config.use.get()).instructions).toEqual([
        "global-instructions.md",
        "shared-rules.md",
        "local-instructions.md",
      ])
    }),
  ),
)

it.effect("deduplicates duplicate instructions from global and local configs", () =>
  withConfigTree(
    {
      global: { instructions: ["duplicate.md", "global-only.md"] },
      local: { instructions: ["duplicate.md", "local-only.md"] },
    },
    Effect.gen(function* () {
      expect((yield* Config.use.get()).instructions).toEqual(["duplicate.md", "global-only.md", "local-only.md"])
    }),
  ),
)

// Legacy tools migration tests

it.instance("migrates legacy tools config to permissions - allow", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* writeConfigEffect(test.directory, {
      $schema: "https://opencode.ai/config.json",
      agent: { test: { tools: { bash: true, read: true } } },
    })

    const config = yield* Config.use.get()
    expect(config.agent?.["test"]?.permission).toEqual({
      bash: "allow",
      read: "allow",
    })
  }),
)

it.instance("migrates legacy tools config to permissions - deny", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* writeConfigEffect(test.directory, {
      $schema: "https://opencode.ai/config.json",
      agent: { test: { tools: { bash: false, webfetch: false } } },
    })

    const config = yield* Config.use.get()
    expect(config.agent?.["test"]?.permission).toEqual({
      bash: "deny",
      webfetch: "deny",
    })
  }),
)

it.instance("migrates legacy write tool to edit permission", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* writeConfigEffect(test.directory, {
      $schema: "https://opencode.ai/config.json",
      agent: { test: { tools: { write: true } } },
    })

    const config = yield* Config.use.get()
    expect(config.agent?.["test"]?.permission).toEqual({ edit: "allow" })
  }),
)

// Managed settings tests
// Note: preload.ts sets GRAPHAGENT_TEST_MANAGED_CONFIG which Global.Path.managedConfig uses

it.instance(
  "managed settings override user settings",
  Effect.gen(function* () {
    yield* writeManagedSettingsEffect({
      $schema: "https://opencode.ai/config.json",
      model: "managed/model",
    })

    const config = yield* Config.use.get()
    expect(config.model).toBe("managed/model")
    expect(config.username).toBe("testuser")
  }),
  { config: { model: "user/model", username: "testuser" } },
)

it.instance(
  "managed settings override project settings",
  Effect.gen(function* () {
    yield* writeManagedSettingsEffect({
      $schema: "https://opencode.ai/config.json",
      autoupdate: false,
      disabled_providers: ["openai"],
    })

    const config = yield* Config.use.get()
    expect(config.autoupdate).toBe(false)
    expect(config.disabled_providers).toEqual(["openai"])
  }),
  { config: { autoupdate: true, disabled_providers: [] } },
)

it.instance("managed jsonc settings override managed json settings", () =>
  Effect.gen(function* () {
    yield* writeManagedSettingsEffect({ model: "managed/json" })
    yield* writeManagedSettingsEffect({ model: "managed/jsonc" }, "graphagent.jsonc")

    const config = yield* Config.use.get()
    expect(config.model).toBe("managed/jsonc")
  }),
)

it.instance(
  "missing managed settings file is not an error",
  Effect.gen(function* () {
    const config = yield* Config.use.get()
    expect(config.model).toBe("user/model")
  }),
  { config: { model: "user/model" } },
)

it.instance("migrates legacy edit tool to edit permission", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* writeConfigEffect(test.directory, {
      $schema: "https://opencode.ai/config.json",
      agent: { test: { tools: { edit: false } } },
    })

    const config = yield* Config.use.get()
    expect(config.agent?.["test"]?.permission).toEqual({ edit: "deny" })
  }),
)

it.instance("migrates legacy patch tool to edit permission", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* writeConfigEffect(test.directory, {
      $schema: "https://opencode.ai/config.json",
      agent: { test: { tools: { patch: true } } },
    })

    const config = yield* Config.use.get()
    expect(config.agent?.["test"]?.permission).toEqual({ edit: "allow" })
  }),
)

it.instance("migrates mixed legacy tools config", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* writeConfigEffect(test.directory, {
      $schema: "https://opencode.ai/config.json",
      agent: { test: { tools: { bash: true, write: true, read: false, webfetch: true } } },
    })

    const config = yield* Config.use.get()
    expect(config.agent?.["test"]?.permission).toEqual({
      bash: "allow",
      edit: "allow",
      read: "deny",
      webfetch: "allow",
    })
  }),
)

it.instance("merges legacy tools with existing permission config", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* writeConfigEffect(test.directory, {
      $schema: "https://opencode.ai/config.json",
      agent: { test: { permission: { glob: "allow" }, tools: { bash: true } } },
    })

    const config = yield* Config.use.get()
    expect(config.agent?.["test"]?.permission).toEqual({
      glob: "allow",
      bash: "allow",
    })
  }),
)

it.instance("permission config preserves user key order", () =>
  // Permission precedence follows the order users write in config, so parsing
  // must not canonicalise known keys ahead of wildcard or custom keys.
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* writeConfigEffect(test.directory, {
      $schema: "https://opencode.ai/config.json",
      permission: {
        "*": "deny",
        edit: "ask",
        write: "ask",
        external_directory: "ask",
        read: "allow",
        todowrite: "allow",
        "thoughts_*": "allow",
        "reasoning_model_*": "allow",
        "tools_*": "allow",
        "pr_comments_*": "allow",
      },
    })

    const config = yield* Config.use.get()
    expect(Object.keys(config.permission!)).toEqual([
      "*",
      "edit",
      "write",
      "external_directory",
      "read",
      "todowrite",
      "thoughts_*",
      "reasoning_model_*",
      "tools_*",
      "pr_comments_*",
    ])
  }),
)

test("config parser preserves permission order while ignoring unknown top-level keys", () => {
  const config = ConfigParse.schema(
    ConfigV1.Info,
    {
      permission: {
        bash: "allow",
        "*": "deny",
        edit: "ask",
      },
      plugins: ["example"],
    },
    "test",
  )

  expect(Object.keys(config.permission!)).toEqual(["bash", "*", "edit"])
  expect(config).not.toHaveProperty("plugins")
})

// MCP config merging tests

it.instance("project config can override MCP server enabled status", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    // Simulates a base config (like from remote .well-known) with disabled MCP.
    yield* writeConfigEffect(test.directory, {
      $schema: "https://opencode.ai/config.json",
      mcp: {
        jira: {
          type: "remote",
          url: "https://jira.example.com/mcp",
          enabled: false,
        },
        wiki: {
          type: "remote",
          url: "https://wiki.example.com/mcp",
          enabled: false,
        },
      },
    })
    // Project config enables just jira.
    yield* writeConfigEffect(
      test.directory,
      {
        $schema: "https://opencode.ai/config.json",
        mcp: {
          jira: {
            type: "remote",
            url: "https://jira.example.com/mcp",
            enabled: true,
          },
        },
      },
      "graphagent.jsonc",
    )

    const config = yield* Config.use.get()
    expect(config.mcp?.jira).toEqual({
      type: "remote",
      url: "https://jira.example.com/mcp",
      enabled: true,
    })
    expect(config.mcp?.wiki).toEqual({
      type: "remote",
      url: "https://wiki.example.com/mcp",
      enabled: false,
    })
  }),
)

it.instance("MCP config deep merges preserving base config properties", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* writeConfigEffect(test.directory, {
      $schema: "https://opencode.ai/config.json",
      mcp: {
        myserver: {
          type: "remote",
          url: "https://myserver.example.com/mcp",
          enabled: false,
          headers: {
            "X-Custom-Header": "value",
          },
        },
      },
    })
    yield* writeConfigEffect(
      test.directory,
      {
        $schema: "https://opencode.ai/config.json",
        mcp: {
          myserver: {
            type: "remote",
            url: "https://myserver.example.com/mcp",
            enabled: true,
          },
        },
      },
      "graphagent.jsonc",
    )

    const config = yield* Config.use.get()
    expect(config.mcp?.myserver).toEqual({
      type: "remote",
      url: "https://myserver.example.com/mcp",
      enabled: true,
      headers: {
        "X-Custom-Header": "value",
      },
    })
  }),
)

it.instance("local .agents config can override MCP from project config", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* writeConfigEffect(test.directory, {
      $schema: "https://opencode.ai/config.json",
      mcp: {
        docs: {
          type: "remote",
          url: "https://docs.example.com/mcp",
          enabled: false,
        },
      },
    })
    yield* FSUtil.use.ensureDir(path.join(test.directory, ".agents"))
    yield* writeConfigEffect(
      path.join(test.directory, ".agents"),
      {
        $schema: "https://opencode.ai/config.json",
        mcp: {
          docs: {
            type: "remote",
            url: "https://docs.example.com/mcp",
            enabled: true,
          },
        },
      },
      "graphagent.json",
    )

    const config = yield* Config.use.get()
    expect(config.mcp?.docs?.enabled).toBe(true)
  }),
)

const remoteProjectOverride = wellKnown({
  config: {
    mcp: { jira: { type: "remote", url: "https://jira.example.com/mcp", enabled: false } },
  },
})

remoteProjectOverride.it.instance(
  "project config overrides remote well-known config",
  () =>
    Effect.gen(function* () {
      const config = yield* Config.use.get()
      expect(remoteProjectOverride.seen.wellKnown).toBe("https://example.com/.well-known/graphagent")
      expect(config.mcp?.jira?.enabled).toBe(true)
    }),
  {
    git: true,
    config: { mcp: { jira: { type: "remote", url: "https://jira.example.com/mcp", enabled: true } } },
  },
)

const trailingSlashWellKnown = wellKnown({
  authUrl: "https://example.com/",
  config: {
    mcp: { slack: { type: "remote", url: "https://slack.example.com/mcp", enabled: true } },
  },
})

trailingSlashWellKnown.it.instance("wellknown URL with trailing slash is normalized", () =>
  Effect.gen(function* () {
    yield* Config.use.get()
    expect(trailingSlashWellKnown.seen.wellKnown).toBe("https://example.com/.well-known/graphagent")
  }),
)

test("remote well-known config can use FetchHttpClient layer", async () => {
  let fetchedUrl: string | undefined
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      fetchedUrl = request.url
      return new Response(
        JSON.stringify({
          config: {
            mcp: { jira: { type: "remote", url: "https://jira.example.com/mcp", enabled: true } },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    },
  })

  try {
    await provideTmpdirInstance(
      () =>
        Config.Service.use((svc) =>
          Effect.gen(function* () {
            const config = yield* svc.get()
            expect(fetchedUrl).toBe(`${server.url.origin}/.well-known/graphagent`)
            expect(config.mcp?.jira?.enabled).toBe(true)
          }),
        ),
      { git: true },
    ).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          Config.layer.pipe(
            Layer.provide(testFlock),
            Layer.provide(FSUtil.defaultLayer),
            Layer.provide(Env.defaultLayer),
            Layer.provide(wellKnownAuth(server.url.origin)),
            Layer.provideMerge(infra),
            Layer.provide(NpmTest.noop),
            Layer.provide(FetchHttpClient.layer),
          ),
          testInstanceStoreLayer,
        ),
      ),
      Effect.runPromise,
    )
  } finally {
    await server.stop(true)
  }
})

const templatedHeaderWellKnown = wellKnown({
  remoteConfig: {
    url: "https://config.example.com/graphagent.json",
    headers: { Authorization: "Bearer {env:TEST_TOKEN}" },
  },
  remote: {
    mcp: { confluence: { type: "remote", url: "https://confluence.example.com/mcp", enabled: true } },
  },
})

templatedHeaderWellKnown.it.instance("wellknown remote_config supports templated env vars in headers", () =>
  Effect.gen(function* () {
    const config = yield* Config.use.get()
    expect(templatedHeaderWellKnown.seen.wellKnown).toBe("https://example.com/.well-known/graphagent")
    expect(templatedHeaderWellKnown.seen.remote).toBe("https://config.example.com/graphagent.json")
    expect(templatedHeaderWellKnown.seen.authorization).toBe("Bearer test-token")
    expect(config.mcp?.confluence?.enabled).toBe(true)
  }),
)

const remotePrecedenceWellKnown = wellKnown({
  config: {
    mcp: { confluence: { type: "remote", url: "https://confluence.example.com/mcp", enabled: false } },
  },
  remoteConfig: { url: "https://config.example.com/{env:TEST_TOKEN}/graphagent.json" },
  remote: {
    config: { mcp: { confluence: { type: "remote", url: "https://confluence.example.com/mcp", enabled: true } } },
  },
})

remotePrecedenceWellKnown.it.instance(
  "wellknown remote_config url tokens and nested config override embedded config",
  () =>
    Effect.gen(function* () {
      const config = yield* Config.use.get()
      expect(remotePrecedenceWellKnown.seen.remote).toBe("https://config.example.com/test-token/graphagent.json")
      expect(config.mcp?.confluence?.enabled).toBe(true)
    }),
)

const envIsolationWellKnown = wellKnown({
  remoteConfig: {
    url: "https://config.example.com/graphagent.json",
    headers: { Authorization: "Bearer {env:TEST_TOKEN}" },
  },
  remote: {
    mcp: { confluence: { type: "remote", url: "https://confluence.example.com/mcp", enabled: true } },
  },
})

envIsolationWellKnown.it.instance(
  "wellknown token env substitution does not mutate process env",
  () =>
    Effect.gen(function* () {
      process.env.TEST_TOKEN = "preexisting-token"
      const config = yield* Config.use.get()
      expect(envIsolationWellKnown.seen.authorization).toBe("Bearer test-token")
      expect(config.username).toBe("test-token")
      expect(process.env.TEST_TOKEN).toBe("preexisting-token")
    }),
  { git: true, config: { username: "{env:TEST_TOKEN}" } },
)

const nullConfigWellKnown = wellKnown({
  wellKnown: {
    config: null,
    remote_config: { url: "https://config.example.com/graphagent.json" },
  },
  remote: {
    mcp: { confluence: { type: "remote", url: "https://confluence.example.com/mcp", enabled: true } },
  },
})

nullConfigWellKnown.it.instance("wellknown config null is treated as absent", () =>
  Effect.gen(function* () {
    const config = yield* Config.use.get()
    expect(nullConfigWellKnown.seen.remote).toBe("https://config.example.com/graphagent.json")
    expect(config.mcp?.confluence?.enabled).toBe(true)
  }),
)

const invalidRemoteWellKnown = wellKnown({
  remoteConfig: { url: "https://config.example.com/graphagent.json" },
  remote: "not an object",
})

invalidRemoteWellKnown.it.instance("wellknown remote_config rejects non-object config responses", () =>
  Effect.gen(function* () {
    const exit = yield* Config.use.get().pipe(Effect.exit)
    expect(invalidRemoteWellKnown.seen.remote).toBe("https://config.example.com/graphagent.json")
    expect(Exit.isFailure(exit)).toBe(true)
  }),
)

const loginPageWellKnown = wellKnown({
  remoteConfig: { url: "https://config.example.com/graphagent.json" },
  remoteHtml: "<!DOCTYPE html><html><head><title>Sign in</title></head><body>Login required</body></html>",
})

loginPageWellKnown.it.instance(
  "wellknown remote_config surfaces an actionable auth error when the gateway returns an HTML login page",
  () =>
    Effect.gen(function* () {
      const exit = yield* Config.use.get().pipe(Effect.exit)
      expect(loginPageWellKnown.seen.remote).toBe("https://config.example.com/graphagent.json")
      expect(Exit.isFailure(exit)).toBe(true)
      const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
      expect(NamedError.hasName(error, "ConfigRemoteAuthError")).toBe(true)
      expect((error as { data?: { url?: string } }).data?.url).toBe("https://example.com")
    }),
)

describe("GRAPHAGENT_DISABLE_PROJECT_CONFIG", () => {
  it.instance(
    "skips project config files when flag is set",
    () =>
      withProcessEnv(
        "GRAPHAGENT_DISABLE_PROJECT_CONFIG",
        "true",
        Effect.gen(function* () {
          const config = yield* Config.use.get()
          expect(config.model).not.toBe("project/model")
          expect(config.username).not.toBe("project-user")
        }),
      ),
    { config: { model: "project/model", username: "project-user" } },
  )

  it.instance("skips project .agents/ directories when flag is set", () =>
    withProcessEnv(
      "GRAPHAGENT_DISABLE_PROJECT_CONFIG",
      "true",
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* FSUtil.use.writeWithDirs(
          path.join(test.directory, ".agents", "command", "test-cmd.md"),
          "# Test Command\nThis is a test command.",
        )
        const directories = yield* Config.use.directories()
        expect(directories.some((d) => d.startsWith(test.directory))).toBe(false)
      }),
    ),
  )

  it.instance("still loads global config when flag is set", () =>
    withProcessEnv(
      "GRAPHAGENT_DISABLE_PROJECT_CONFIG",
      "true",
      Effect.gen(function* () {
        const config = yield* Config.use.get()
        expect(config).toBeDefined()
        expect(config.username).toBeDefined()
      }),
    ),
  )

  it.instance(
    "skips relative instructions with warning when flag is set but no config dir",
    () =>
      withProcessEnvs(
        { GRAPHAGENT_CONFIG_DIR: undefined, GRAPHAGENT_DISABLE_PROJECT_CONFIG: "true" },
        Effect.gen(function* () {
          const test = yield* TestInstance
          yield* FSUtil.use.writeWithDirs(path.join(test.directory, "CUSTOM.md"), "# Custom Instructions")
          // The relative instruction should be skipped without error
          const config = yield* Config.use.get()
          expect(config).toBeDefined()
        }),
      ),
    { config: { instructions: ["./CUSTOM.md"] } },
  )

  it.instance(
    "GRAPHAGENT_CONFIG_DIR still works when flag is set",
    () =>
      Effect.gen(function* () {
        const configDir = yield* tmpdirScoped({ config: { model: "configdir/model" } })
        yield* withProcessEnvs(
          { GRAPHAGENT_DISABLE_PROJECT_CONFIG: "true", GRAPHAGENT_CONFIG_DIR: configDir },
          Effect.gen(function* () {
            const config = yield* Config.use.get()
            expect(config.model).toBe("configdir/model")
          }),
        )
      }),
    { config: { model: "project/model" } },
  )
})

// Regression for #28206: malformed GRAPHAGENT_PERMISSION JSON used to crash
// the app on startup with an unhandled SyntaxError. Loading the config with
// an invalid JSON value in this env var should not throw.
describe("GRAPHAGENT_PERMISSION env var", () => {
  it.instance("does not crash when GRAPHAGENT_PERMISSION contains invalid JSON", () =>
    withProcessEnv(
      "GRAPHAGENT_PERMISSION",
      "{invalid",
      Effect.gen(function* () {
        const config = yield* Config.use.get()
        // Regression: load() used to throw before returning anything.
        expect(config).toBeDefined()
      }),
    ),
  )
})

describe("GRAPHAGENT_CONFIG_CONTENT token substitution", () => {
  it.instance("substitutes {env:} tokens in GRAPHAGENT_CONFIG_CONTENT", () =>
    withProcessEnv(
      "TEST_CONFIG_VAR",
      "test_api_key_12345",
      withProcessEnv(
        "GRAPHAGENT_CONFIG_CONTENT",
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          username: "{env:TEST_CONFIG_VAR}",
        }),
        Effect.gen(function* () {
          const config = yield* Config.use.get()
          expect(config.username).toBe("test_api_key_12345")
        }),
      ),
    ),
  )

  it.instance("substitutes {file:} tokens in GRAPHAGENT_CONFIG_CONTENT", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* FSUtil.use.writeWithDirs(path.join(test.directory, "api_key.txt"), "secret_key_from_file")
      yield* withProcessEnv(
        "GRAPHAGENT_CONFIG_CONTENT",
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          username: "{file:./api_key.txt}",
        }),
        Effect.gen(function* () {
          const config = yield* Config.use.get()
          expect(config.username).toBe("secret_key_from_file")
        }),
      )
    }),
  )
})

// #884: DAG settings are machine-wide policy. Only the global layer may set
// them; project files are stripped before the merge and reported once.
describe("DAG settings are read from the global layer only", () => {
  const dagConfig = {
    mode: "on" as const,
    concurrency: 7,
    max_total_nodes: 40,
    budget: { tokens: null, warn_ratio: 0.5 },
    safety: { extra: [{ permission: "bash", pattern: "rm -rf /", reason: "destructive" }] },
  }

  const warning = "ignoring DAG setting from project configuration"
  const occurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1

  it.effect("loads every DAG key from the global config directory", () =>
    withConfigTree(
      { global: { dag: dagConfig } },
      Effect.gen(function* () {
        expect((yield* Config.use.get()).dag).toEqual(dagConfig)
      }),
    ),
  )

  it.effect("ignores DAG settings from the project config file and warns once per key", () =>
    withConfigTree(
      {
        global: { dag: { concurrency: 7 } },
        project: {
          dag: {
            mode: "on",
            concurrency: 9,
            max_total_nodes: 50,
            budget: { tokens: 10 },
            safety: { extra: [{ permission: "edit", pattern: "*" }] },
          },
        },
      },
      Effect.gen(function* () {
        const test = yield* TestInstance
        expect((yield* Config.use.get()).dag).toEqual({ concurrency: 7 })
        const logs = JSON.stringify(yield* logLines)
        expect(logs).toContain(warning)
        expect(logs).toContain(path.join(test.directory, "graphagent.json"))
        expect(logs).toContain("dag.concurrency")
        expect(logs).toContain("dag.safety")
        // A reload re-reads the same project file; the warning is per file and
        // key per process, so the key must not be reported a second time.
        const before = occurrences(logs, "dag.concurrency")
        yield* reloadInstance({ directory: test.directory })
        expect((yield* Config.use.get()).dag).toEqual({ concurrency: 7 })
        expect(occurrences(JSON.stringify(yield* logLines), "dag.concurrency")).toBe(before)
      }),
    ),
  )

  it.effect("ignores DAG settings from .agents project directories", () =>
    withConfigTree(
      { local: { dag: { concurrency: 12 } } },
      Effect.gen(function* () {
        expect((yield* Config.use.get()).dag).toBeUndefined()
        const logs = JSON.stringify(yield* logLines)
        expect(logs).toContain(warning)
        expect(logs).toContain(path.join(".agents", "graphagent.json"))
        expect(logs).toContain("dag.concurrency")
      }),
    ),
  )

  it.effect("treats GRAPHAGENT_CONFIG as the global layer", () =>
    Effect.gen(function* () {
      const file = yield* tmpdirScoped({ config: { dag: { concurrency: 11 } } })
      // Flag values are snapshotted at import time, so runtime changes must
      // update the flag itself rather than the environment.
      yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          const previous = Flag.GRAPHAGENT_CONFIG
          Flag.GRAPHAGENT_CONFIG = path.join(file, "graphagent.json")
          return previous
        }),
        () =>
          withConfigTree(
            {},
            Effect.gen(function* () {
              expect((yield* Config.use.get()).dag?.concurrency).toBe(11)
            }),
          ),
        (previous) =>
          Effect.sync(() => {
            Flag.GRAPHAGENT_CONFIG = previous
          }),
      )
    }),
  )

  it.effect("treats GRAPHAGENT_CONFIG_CONTENT as the global layer", () =>
    withConfigTree(
      {},
      withProcessEnv(
        "GRAPHAGENT_CONFIG_CONTENT",
        JSON.stringify({ dag: { concurrency: 13 } }),
        Effect.gen(function* () {
          expect((yield* Config.use.get()).dag?.concurrency).toBe(13)
        }),
      ),
    ),
  )

  it.effect("treats GRAPHAGENT_CONFIG_DIR as the global layer", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ config: { dag: { concurrency: 14 } } })
      yield* withConfigTree(
        {},
        withProcessEnv(
          "GRAPHAGENT_CONFIG_DIR",
          dir,
          Effect.gen(function* () {
            expect((yield* Config.use.get()).dag?.concurrency).toBe(14)
          }),
        ),
      )
    }),
  )

  it.effect("treats the managed configuration directory as the global layer", () =>
    withConfigTree(
      {},
      Effect.gen(function* () {
        yield* writeManagedSettingsEffect({ dag: { concurrency: 15 } })
        expect((yield* Config.use.get()).dag?.concurrency).toBe(15)
      }),
    ),
  )

  it.effect("rejects invalid DAG values instead of silently coercing them", () =>
    withConfigTree(
      { global: { dag: { concurrency: "x" } } },
      Effect.gen(function* () {
        const exit = yield* Config.use.get().pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
      }),
    ),
  )
})

// parseManagedPlist unit tests — pure function, no OS interaction

test("parseManagedPlist strips MDM metadata keys", async () => {
  const config = ConfigParse.schema(
    ConfigV1.Info,
    ConfigParse.jsonc(
      await ConfigManaged.parseManagedPlist(
        JSON.stringify({
          PayloadDisplayName: "GraphAgent Managed",
          PayloadIdentifier: "io.github.lexwdex.graphagent.managed.test",
          PayloadType: "io.github.lexwdex.graphagent.managed",
          PayloadUUID: "AAAA-BBBB-CCCC",
          PayloadVersion: 1,
          _manualProfile: true,
          model: "mdm/model",
        }),
      ),
      "test:mobileconfig",
    ),
    "test:mobileconfig",
  )
  expect(config.model).toBe("mdm/model")
  // MDM keys must not leak into the parsed config
  expect((config as any).PayloadUUID).toBeUndefined()
  expect((config as any).PayloadType).toBeUndefined()
  expect((config as any)._manualProfile).toBeUndefined()
})

test("parseManagedPlist parses permission rules", async () => {
  const config = ConfigParse.schema(
    ConfigV1.Info,
    ConfigParse.jsonc(
      await ConfigManaged.parseManagedPlist(
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          permission: {
            "*": "ask",
            bash: { "*": "ask", "rm -rf *": "deny", "curl *": "deny" },
            grep: "allow",
            glob: "allow",
            webfetch: "ask",
            "~/.ssh/*": "deny",
          },
        }),
      ),
      "test:mobileconfig",
    ),
    "test:mobileconfig",
  )
  expect(config.permission?.["*"]).toBe("ask")
  expect(config.permission?.grep).toBe("allow")
  expect(config.permission?.webfetch).toBe("ask")
  expect(config.permission?.["~/.ssh/*"]).toBe("deny")
  const bash = config.permission?.bash as Record<string, string>
  expect(bash?.["rm -rf *"]).toBe("deny")
  expect(bash?.["curl *"]).toBe("deny")
})

test("parseManagedPlist parses enabled_providers", async () => {
  const config = ConfigParse.schema(
    ConfigV1.Info,
    ConfigParse.jsonc(
      await ConfigManaged.parseManagedPlist(
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          enabled_providers: ["anthropic", "google"],
        }),
      ),
      "test:mobileconfig",
    ),
    "test:mobileconfig",
  )
  expect(config.enabled_providers).toEqual(["anthropic", "google"])
})

test("parseManagedPlist handles empty config", async () => {
  const config = ConfigParse.schema(
    ConfigV1.Info,
    ConfigParse.jsonc(
      await ConfigManaged.parseManagedPlist(JSON.stringify({ $schema: CONFIG_SCHEMA_URL })),
      "test:mobileconfig",
    ),
    "test:mobileconfig",
  )
  expect(config.$schema).toBe(CONFIG_SCHEMA_URL)
})

for (const enabled of [true, false]) {
  it.instance(`reads reasoning distillation opt-in ${enabled} from graphagent.json`, () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* writeConfigEffect(test.directory, { reasoningDistillation: { enabled } })
      expect((yield* Config.use.get()).reasoningDistillation?.enabled).toBe(enabled)
    }),
  )
}

for (const enabled of [true, false]) {
  it.instance(`loads per-model reasoning distillation override ${enabled}`, () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* writeConfigEffect(test.directory, {
        reasoningDistillation: { enabled: true },
        provider: {
          "test-provider": {
            models: { "test-key": { reasoningDistillation: { enabled } } },
          },
        },
      })
      const config = yield* Config.use.get()
      expect(config.reasoningDistillation?.enabled).toBe(true)
      expect(config.provider?.["test-provider"]?.models?.["test-key"]?.reasoningDistillation?.enabled).toBe(enabled)
    }),
  )
}
