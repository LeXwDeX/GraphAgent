import fs from "fs/promises"
import path from "path"
import { describe, expect, test } from "bun:test"
import { NodeFileSystem } from "@effect/platform-node"
import { Effect, Layer, Option } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { Npm } from "@opencode-ai/core/npm"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { tmpdir } from "./fixture/tmpdir"

// CI runners blackhole the registry audit POST that arborist.reify issues,
// hanging these fixtures past Bun's default 5000ms test timeout. Audit is
// incidental to what these tests assert; NpmConfig.load spreads process.env
// into Arborist, so disabling it here keeps reify hermetic.
process.env.npm_config_audit = "false"

const win = process.platform === "win32"
const FIXTURE_DEP = "fixture-plugin-dep"

const writePackage = (dir: string, pkg: Record<string, unknown>) =>
  Bun.write(
    path.join(dir, "package.json"),
    JSON.stringify({
      version: "1.0.0",
      ...pkg,
    }),
  )

const npmLayer = (cache: string) =>
  Npm.layer.pipe(
    Layer.provide(EffectFlock.layer),
    Layer.provide(FSUtil.layer),
    Layer.provide(Global.layerWith({ cache, state: path.join(cache, "state") })),
    Layer.provide(NodeFileSystem.layer),
  )

describe("Npm.sanitize", () => {
  test("keeps normal scoped package specs unchanged", () => {
    expect(Npm.sanitize("@opencode/acme")).toBe("@opencode/acme")
    expect(Npm.sanitize("@opencode/acme@1.0.0")).toBe("@opencode/acme@1.0.0")
    expect(Npm.sanitize("prettier")).toBe("prettier")
  })

  test("handles git https specs", () => {
    const spec = "acme@git+https://github.com/opencode/acme.git"
    const expected = win ? "acme@git+https_//github.com/opencode/acme.git" : spec
    expect(Npm.sanitize(spec)).toBe(expected)
  })
})

describe("Npm.add", () => {
  test("reifies when package cache directory exists without the package installed", async () => {
    await using tmp = await tmpdir()
    await fs.mkdir(path.join(tmp.path, "fixture-provider"))
    await writePackage(path.join(tmp.path, "fixture-provider"), {
      name: "fixture-provider",
      main: "index.js",
    })
    await Bun.write(path.join(tmp.path, "fixture-provider", "index.js"), "export const fixture = true\n")

    const spec = `fixture-provider@file:${path.join(tmp.path, "fixture-provider")}`
    await fs.mkdir(path.join(tmp.path, "cache", "packages", Npm.sanitize(spec)), { recursive: true })

    const entry = await Effect.gen(function* () {
      const npm = yield* Npm.Service
      return yield* npm.add(spec)
    }).pipe(Effect.scoped, Effect.provide(npmLayer(path.join(tmp.path, "cache"))), Effect.runPromise)

    expect(entry.entrypoint).toBeDefined()
  })
})

interface AddSpec {
  name: string
  version?: string
}

const lockSnapshot = async (lockPath: string) => {
  const [bytes, stat] = await Promise.all([fs.readFile(lockPath), fs.stat(lockPath)])
  return { bytes: bytes.toString(), ino: stat.ino, mtimeMs: stat.mtimeMs }
}

const install = (dir: string, cache: string, add: AddSpec[] = []) =>
  Effect.gen(function* () {
    const npm = yield* Npm.Service
    yield* npm.install(dir, add.length ? { add } : undefined)
  }).pipe(Effect.scoped, Effect.provide(npmLayer(cache)), Effect.runPromise)

// Seeds a project whose fixture dependency resolves from an existing local copy
// (declared via a file: spec so the initial reify stays offline), then builds a
// real package-lock.json through the genuine forcing path: one install with a
// missing file: dependency reaches reify and writes the lock arborist owns.
const seedFixtureProject = async (dir: string) => {
  const localPlugin = path.join(dir, "local-plugin")
  await fs.mkdir(localPlugin, { recursive: true })
  await writePackage(localPlugin, { name: FIXTURE_DEP, main: "index.js" })
  await Bun.write(path.join(localPlugin, "index.js"), "export const plugin = true\n")

  const helper = path.join(dir, "helper-dep")
  await fs.mkdir(helper, { recursive: true })
  await writePackage(helper, { name: "fixture-helper-dep", main: "index.js" })
  await Bun.write(path.join(helper, "index.js"), "export const helper = true\n")

  await writePackage(dir, {
    name: "fixture",
    dependencies: {
      [FIXTURE_DEP]: "file:./local-plugin",
      "fixture-helper-dep": "file:./helper-dep",
    },
  })

  await install(dir, path.join(dir, "cache"), [{ name: "fixture-helper-dep", version: "file:./helper-dep" }])
}

describe("Npm.install", () => {
  test("respects omit from project .npmrc", async () => {
    await using tmp = await tmpdir()

    await writePackage(tmp.path, {
      name: "fixture",
      dependencies: {
        "prod-pkg": "file:./prod-pkg",
      },
      devDependencies: {
        "dev-pkg": "file:./dev-pkg",
      },
    })
    await Bun.write(path.join(tmp.path, ".npmrc"), "omit=dev\n")
    await fs.mkdir(path.join(tmp.path, "prod-pkg"))
    await fs.mkdir(path.join(tmp.path, "dev-pkg"))
    await writePackage(path.join(tmp.path, "prod-pkg"), { name: "prod-pkg" })
    await writePackage(path.join(tmp.path, "dev-pkg"), { name: "dev-pkg" })

    await Npm.install(tmp.path)

    await expect(fs.stat(path.join(tmp.path, "node_modules", "prod-pkg"))).resolves.toBeDefined()
    await expect(fs.stat(path.join(tmp.path, "node_modules", "dev-pkg"))).rejects.toThrow()
  })

  test("preserves package-lock across consecutive installs when a dependency already exists locally", async () => {
    await using tmp = await tmpdir()
    await seedFixtureProject(tmp.path)

    const lockPath = path.join(tmp.path, "package-lock.json")
    const bootstrapped = await lockSnapshot(lockPath)

    await install(tmp.path, path.join(tmp.path, "cache"), [{ name: FIXTURE_DEP, version: "1.17.11-main.3" }])
    const afterFirst = await lockSnapshot(lockPath)

    await install(tmp.path, path.join(tmp.path, "cache"), [{ name: FIXTURE_DEP, version: "1.17.11-main.3" }])
    const afterSecond = await lockSnapshot(lockPath)

    expect(afterFirst).toEqual(bootstrapped)
    expect(afterSecond).toEqual(afterFirst)
  })

  test("still reifies package-lock when a local dependency install is mixed with a missing dependency", async () => {
    await using tmp = await tmpdir()
    await seedFixtureProject(tmp.path)

    const extra = path.join(tmp.path, "extra-dep")
    await fs.mkdir(extra, { recursive: true })
    await writePackage(extra, { name: "fixture-extra-dep", main: "index.js" })
    await Bun.write(path.join(extra, "index.js"), "export const extra = true\n")

    await install(tmp.path, path.join(tmp.path, "cache"), [
      { name: FIXTURE_DEP, version: "file:./local-plugin" },
      { name: "fixture-extra-dep", version: "file:./extra-dep" },
    ])

    const lockPath = path.join(tmp.path, "package-lock.json")
    const lock = JSON.parse(await fs.readFile(lockPath, "utf8"))
    expect(lock.lockfileVersion).toBe(3)
    expect(lock.packages[""].dependencies["fixture-extra-dep"]).toMatch(/^file:/)
    expect(lock.packages["node_modules/fixture-extra-dep"]).toBeDefined()
    await expect(fs.stat(path.join(tmp.path, "node_modules", "fixture-extra-dep"))).resolves.toBeDefined()
  })

  test("reifies package-lock when package.json drifts from the lock", async () => {
    await using tmp = await tmpdir()
    await seedFixtureProject(tmp.path)

    const drift = path.join(tmp.path, "drift-dep")
    await fs.mkdir(drift, { recursive: true })
    await writePackage(drift, { name: "fixture-drift-dep", main: "index.js" })
    await Bun.write(path.join(drift, "index.js"), "export const drift = true\n")

    const pkgPath = path.join(tmp.path, "package.json")
    const pkg = JSON.parse(await fs.readFile(pkgPath, "utf8"))
    pkg.dependencies["fixture-drift-dep"] = "file:./drift-dep"
    await Bun.write(pkgPath, JSON.stringify(pkg, null, 2))

    await install(tmp.path, path.join(tmp.path, "cache"))

    const lockPath = path.join(tmp.path, "package-lock.json")
    const lock = JSON.parse(await fs.readFile(lockPath, "utf8"))
    expect(lock.lockfileVersion).toBe(3)
    expect(lock.packages[""].dependencies).toMatchObject({ "fixture-drift-dep": "file:./drift-dep" })
    expect(lock.packages["node_modules/fixture-drift-dep"]).toBeDefined()
    await expect(fs.stat(path.join(tmp.path, "node_modules", "fixture-drift-dep"))).resolves.toBeDefined()
  })
})
