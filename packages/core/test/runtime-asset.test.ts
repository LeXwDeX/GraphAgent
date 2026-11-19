// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdtemp, readFile, rm } from "fs/promises"
import os from "os"
import path from "path"
import { Effect, Result } from "effect"
import { LayerNode } from "@graphagent/core/effect/layer-node"
import { RuntimeAsset } from "@graphagent/core/runtime-asset"
import { RipgrepAsset } from "@graphagent/core/runtime-asset/catalog/ripgrep"

// Run last-in first-out so a test's own cleanup sees the files and PATH that `fakeRg` set up.
const cleanups: Array<() => void | Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

describe("RuntimeAsset", () => {
  test("uses the deterministic source order and reports provenance", async () => {
    const attempts: RuntimeAsset.Source[] = []
    const runtime = RuntimeAsset.make({
      platform: { os: "linux", arch: "x64" },
      candidates: candidates({
        system: () => {
          attempts.push("system")
          return Effect.fail(new RuntimeAsset.CandidateUnavailable({ reason: "not installed" }))
        },
        packaged: () => {
          attempts.push("packaged")
          return Effect.succeed({ path: "/app/assets/rg" })
        },
        cache: () => {
          attempts.push("cache")
          return Effect.succeed({ path: "/cache/rg" })
        },
      }),
    })

    const result = await Effect.runPromise(runtime.resolve(descriptor(false)))

    expect(result).toMatchObject({
      _tag: "Available",
      path: "/app/assets/rg",
      source: "packaged",
      id: "ripgrep",
      version: "15.1.0",
      platform: { os: "linux", arch: "x64" },
    })
    expect(attempts).toEqual(["system", "packaged"])
  })

  test("selects only the target matching the current platform", async () => {
    const runtime = RuntimeAsset.make({
      platform: { os: "linux", arch: "x64" },
      candidates: candidates({
        system: (request) => Effect.succeed({ path: `/system/${request.target.executable}` }),
      }),
    })

    const result = await Effect.runPromise(runtime.resolve(descriptor(false)))

    expect(result).toMatchObject({ _tag: "Available", path: "/system/rg", sha256: "linux-digest" })
  })

  test("does not call mirror or public adapters when network sources are disabled", async () => {
    const attempts: RuntimeAsset.Source[] = []
    const candidate =
      (source: RuntimeAsset.Source): RuntimeAsset.Candidate =>
      () => {
        attempts.push(source)
        return source === "mirror" || source === "public"
          ? Effect.succeed({ path: `/network/${source}/rg` })
          : Effect.fail(new RuntimeAsset.CandidateUnavailable({ reason: `${source} unavailable` }))
      }
    const runtime = RuntimeAsset.make({
      platform: { os: "linux", arch: "x64" },
      candidates: candidates({
        system: candidate("system"),
        packaged: candidate("packaged"),
        cache: candidate("cache"),
        mirror: candidate("mirror"),
        public: candidate("public"),
      }),
    })

    const result = await Effect.runPromise(
      runtime.resolve(descriptor(false), { sources: ["system", "packaged", "cache"] }),
    )

    expect(result._tag).toBe("Unavailable")
    expect(attempts).toEqual(["system", "packaged", "cache"])
  })

  test("returns typed unavailability for optional assets and fails required assets", async () => {
    const runtime = RuntimeAsset.make({
      platform: { os: "linux", arch: "x64" },
      candidates: candidates({}),
    })

    const optional = await Effect.runPromise(runtime.resolve(descriptor(false)))
    const required = await Effect.runPromise(runtime.resolve(descriptor(true)).pipe(Effect.result))

    expect(optional).toMatchObject({ _tag: "Unavailable", id: "ripgrep", required: false })
    expect(optional._tag === "Unavailable" ? optional.attempts : []).toHaveLength(RuntimeAsset.sources.length)
    expect(Result.isFailure(required)).toBe(true)
    if (Result.isFailure(required)) {
      expect(required.failure).toMatchObject({ _tag: "RequiredAssetUnavailable", id: "ripgrep" })
    }
  })

  test("redacts credentials and sensitive query values from diagnostics", async () => {
    const runtime = RuntimeAsset.make({
      platform: { os: "linux", arch: "x64" },
      candidates: candidates({
        mirror: () =>
          Effect.fail(
            new RuntimeAsset.CandidateUnavailable({
              reason: "download failed: https://user:secret@mirror.example.com/rg?token=sensitive&file=rg",
            }),
          ),
      }),
    })

    const result = await Effect.runPromise(runtime.resolve(descriptor(false), { sources: ["mirror"] }))
    const reason = result._tag === "Unavailable" ? result.attempts[0]?.reason : ""

    expect(reason).toContain("mirror.example.com/rg")
    expect(reason).toContain("file=rg")
    expect(reason).not.toContain("user")
    expect(reason).not.toContain("secret")
    expect(reason).not.toContain("sensitive")
  })

  test("builds both defaultLayer and LayerNode without ambient services", async () => {
    const resolve = Effect.gen(function* () {
      const runtime = yield* RuntimeAsset.Service
      return yield* runtime.resolve(descriptor(false))
    })

    const direct = await Effect.runPromise(resolve.pipe(Effect.provide(RuntimeAsset.defaultLayer)))
    const node = await Effect.runPromise(resolve.pipe(Effect.provide(LayerNode.buildLayer(RuntimeAsset.node))))

    expect(node).toEqual(direct)
  })
})

describe.skipIf(process.platform === "win32")("RuntimeAsset system executable version", () => {
  const requirement = { minimum: "0.10.0" }
  // Mirrors the fixed probe timeout in runtime-asset/index.ts.
  const PROBE_TIMEOUT_MS = 5_000

  test("accepts any system executable when the descriptor sets no minimum", async () => {
    // Any probe of this script fails, so an Available result proves none was run.
    const root = await fakeRg("exit 1")

    const result = await Effect.runPromise(resolveSystem(systemDescriptor()))

    expect(result).toMatchObject({ _tag: "Available", source: "system", path: path.join(root, "rg") })
  })

  test("rejects a system executable older than the minimum", async () => {
    await fakeRg('echo "ripgrep 0.9.0"')

    const result = await Effect.runPromise(resolveSystem(systemDescriptor(requirement)))

    expect(result).toMatchObject({ _tag: "Unavailable", reason: "sources-exhausted" })
    expect(result._tag === "Unavailable" ? result.attempts : []).toEqual([
      { source: "system", reason: "system executable is too old: rg reports 0.9.0, needs >= 0.10.0" },
    ])
  })

  test("refuses every system executable when the descriptor minimum is malformed", async () => {
    await fakeRg('echo "ripgrep 14.1.0"')

    const result = await Effect.runPromise(resolveSystem(systemDescriptor({ minimum: ">=0.10" })))

    expect(attemptReason(result)).toBe("system executable minimum version is invalid: >=0.10")
  })

  test.each([
    ["exactly the minimum", 'echo "ripgrep 0.10.0"'],
    ["apt's 14.1.0 banner", 'echo "ripgrep 14.1.0 (rev af60c2de9d)"\necho\necho "PCRE2 10.42 is available"'],
  ])("accepts a system executable reporting %s", async (_label, body) => {
    const root = await fakeRg(body)

    const result = await Effect.runPromise(resolveSystem(systemDescriptor(requirement)))

    // The probe only gates acceptance: the resolved version stays the descriptor's pinned one.
    expect(result).toMatchObject({
      _tag: "Available",
      source: "system",
      version: "15.1.0",
      path: path.join(root, "rg"),
    })
  })

  test.each([
    ["prints no version", 'echo "ripgrep (unknown build)"', "system executable version is unreadable: rg"],
    ["exits non-zero", 'echo "ripgrep 14.1.0"\nexit 3', "system executable version is unreadable: rg (exit 3)"],
    ["floods stdout", `while :; do echo ${"x".repeat(64)}; done`, "output exceeds"],
  ])("treats an executable that %s as unavailable", async (_label, body, reason) => {
    await fakeRg(body)

    const { result, elapsed } = await resolveTimed(systemDescriptor(requirement))

    expect(result).toMatchObject({ _tag: "Unavailable", reason: "sources-exhausted", attempts: [{ source: "system" }] })
    expect(attemptReason(result)).toContain(reason)
    expect(elapsed).toBeLessThan(PROBE_TIMEOUT_MS)
  })

  test("treats an executable that cannot be started as unavailable", async () => {
    await fakeRg("", "/nonexistent/interpreter")

    const { result, elapsed } = await resolveTimed(systemDescriptor(requirement))

    expect(result).toMatchObject({ _tag: "Unavailable", reason: "sources-exhausted", attempts: [{ source: "system" }] })
    expect(attemptReason(result)).toContain("system executable version is unreadable: rg (")
    expect(elapsed).toBeLessThan(PROBE_TIMEOUT_MS)
  })

  test("kills a system executable that never returns and gives up within the probe timeout", async () => {
    // The background sleep keeps stdout open after the direct child is killed, as a wrapper script's child would.
    const root = await fakeRg(
      ['dir=$(dirname "$0")', 'echo $$ > "$dir/pid"', "sleep 60 &", 'echo $! > "$dir/grandchild"', "wait"].join("\n"),
    )
    cleanups.push(async () => {
      const grandchild = Number(await readFile(path.join(root, "grandchild"), "utf8").catch(() => ""))
      if (grandchild) kill(grandchild)
    })

    const { result, elapsed } = await resolveTimed(systemDescriptor(requirement))

    expect(attemptReason(result)).toContain(`timed out after ${PROBE_TIMEOUT_MS} ms`)
    expect(elapsed).toBeLessThan(PROBE_TIMEOUT_MS + 2_500)
    expect(await gone(Number(await readFile(path.join(root, "pid"), "utf8")))).toBe(true)
    // The probe deadline alone is 5 s, the same as bun's default per-test timeout that the package script keeps.
  }, 15_000)

  test("the pinned ripgrep descriptor skips a system rg too old for the engine's flags", async () => {
    await fakeRg('echo "ripgrep 0.9.0"')

    const result = await Effect.runPromise(resolveSystem(RipgrepAsset.descriptor).pipe(Effect.result))

    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) expect(result.failure.attempts[0]?.reason).toContain("too old")
  })

  test("the pinned ripgrep descriptor keeps accepting apt's 14.1.0", async () => {
    const root = await fakeRg('echo "ripgrep 14.1.0"')

    const result = await Effect.runPromise(resolveSystem(RipgrepAsset.descriptor))

    expect(result).toMatchObject({ _tag: "Available", source: "system", path: path.join(root, "rg") })
  })
})

function descriptor(required: boolean): RuntimeAsset.Descriptor {
  return {
    id: "ripgrep",
    version: "15.1.0",
    required,
    targets: [
      { os: "darwin", arch: "arm64", executable: "rg", sha256: "darwin-digest" },
      { os: "linux", arch: "x64", executable: "rg", sha256: "linux-digest" },
    ],
  }
}

function candidates(overrides: Partial<RuntimeAsset.Candidates>): RuntimeAsset.Candidates {
  const unavailable =
    (source: RuntimeAsset.Source): RuntimeAsset.Candidate =>
    () =>
      Effect.fail(new RuntimeAsset.CandidateUnavailable({ reason: `${source} candidate is not configured` }))
  return {
    system: overrides.system ?? unavailable("system"),
    packaged: overrides.packaged ?? unavailable("packaged"),
    cache: overrides.cache ?? unavailable("cache"),
    mirror: overrides.mirror ?? unavailable("mirror"),
    public: overrides.public ?? unavailable("public"),
  }
}

function currentPlatform(): RuntimeAsset.Platform {
  return { os: process.platform, arch: process.arch }
}

function systemDescriptor(system?: RuntimeAsset.Descriptor["system"]): RuntimeAsset.Descriptor {
  return {
    id: "fake-rg",
    version: "15.1.0",
    required: false,
    ...(system ? { system } : {}),
    targets: [{ ...currentPlatform(), executable: "rg" }],
  }
}

async function resolveTimed(asset: RuntimeAsset.Descriptor) {
  const started = performance.now()
  const result = await Effect.runPromise(resolveSystem(asset))
  return { result, elapsed: performance.now() - started }
}

function resolveSystem(asset: RuntimeAsset.Descriptor) {
  // The cache directory is never touched: only the system source is consulted.
  const runtime = RuntimeAsset.managed({
    platform: currentPlatform(),
    cacheDirectory: path.join(os.tmpdir(), "runtime-asset-system-unused"),
  })
  return runtime.resolve(asset, { sources: ["system"] })
}

function attemptReason(result: RuntimeAsset.Resolution) {
  return result._tag === "Unavailable" ? result.attempts[0]?.reason : undefined
}

// Installs an `rg` script in a fresh directory placed first on PATH until the test ends.
async function fakeRg(body: string, interpreter = "/bin/sh") {
  const root = await mkdtemp(path.join(os.tmpdir(), "runtime-asset-system-"))
  const file = path.join(root, "rg")
  await Bun.write(file, `#!${interpreter}\n${body}\n`)
  await chmod(file, 0o755)
  const original = process.env.PATH
  process.env.PATH = [root, original].filter(Boolean).join(path.delimiter)
  cleanups.push(async () => {
    if (original === undefined) delete process.env.PATH
    else process.env.PATH = original
    await rm(root, { recursive: true, force: true })
  })
  return root
}

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function kill(pid: number) {
  try {
    process.kill(pid, "SIGKILL")
  } catch {}
}

async function gone(pid: number, timeout = 2_000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (!alive(pid)) return true
    await Bun.sleep(50)
  }
  return !alive(pid)
}
