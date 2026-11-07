import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "fs/promises"
import os from "os"
import path from "path"
import { Effect } from "effect"
import { RuntimeAsset } from "@graphagent/core/runtime-asset"

const cleanups: Array<() => void | Promise<void>> = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(async (cleanup) => cleanup()))
})

describe("RuntimeAsset managed candidates", () => {
  test("rejects a download with the wrong SHA-256 before publishing cache files", async () => {
    const root = await temporaryRoot()
    const cache = path.join(root, "cache")
    const runtime = RuntimeAsset.managed({
      platform: currentPlatform(),
      cacheDirectory: cache,
      fetch: () => Promise.resolve(new Response("corrupt")),
    })

    const result = await Effect.runPromise(
      runtime.resolve(rawDescriptor("https://assets.example/tool", "0".repeat(64)), { sources: ["public"] }),
    )

    expect(result._tag).toBe("Unavailable")
    expect(await Array.fromAsync(new Bun.Glob("**/tool").scan({ cwd: cache, onlyFiles: true }))).toEqual([])
  })

  test("verifies, extracts, atomically caches, and reuses a tar.gz asset", async () => {
    const root = await temporaryRoot()
    const archive = await tarFixture(root)
    const bytes = await Bun.file(archive).bytes()
    const requests = { count: 0 }
    const runtime = RuntimeAsset.managed({
      platform: currentPlatform(),
      cacheDirectory: path.join(root, "cache"),
      fetch: () => {
        requests.count++
        return Promise.resolve(new Response(bytes))
      },
    })
    const asset = archiveDescriptor("https://assets.example/fixture.tar.gz", sha256(bytes))

    const downloaded = await Effect.runPromise(runtime.resolve(asset, { sources: ["public"] }))
    const cached = await Effect.runPromise(runtime.resolve(asset, { sources: ["cache"] }))

    expect(downloaded).toMatchObject({ _tag: "Available", source: "public" })
    expect(cached).toMatchObject({ _tag: "Available", source: "cache" })
    expect(downloaded._tag === "Available" ? await Bun.file(downloaded.path).text() : "").toBe("fixture executable\n")
    expect(cached._tag === "Available" ? cached.path : "").toBe(downloaded._tag === "Available" ? downloaded.path : "")
    expect(requests.count).toBe(1)
  })

  test("deduplicates concurrent downloads and never exposes a partial executable", async () => {
    const root = await temporaryRoot()
    const cache = path.join(root, "cache")
    const requested = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const requests = { count: 0 }
    const bytes = new TextEncoder().encode("executable")
    const runtime = RuntimeAsset.managed({
      platform: currentPlatform(),
      cacheDirectory: cache,
      fetch: async () => {
        requests.count++
        requested.resolve()
        await release.promise
        return new Response(bytes)
      },
    })
    const asset = rawDescriptor("https://assets.example/tool", sha256(bytes))

    const first = Effect.runPromise(runtime.resolve(asset, { sources: ["public"] }))
    const second = Effect.runPromise(runtime.resolve(asset, { sources: ["public"] }))
    await requested.promise
    expect(await Array.fromAsync(new Bun.Glob("**/tool").scan({ cwd: cache, onlyFiles: true }))).toEqual([])
    release.resolve()
    const results = await Promise.all([first, second])

    expect(results.every((result) => result._tag === "Available")).toBe(true)
    expect(requests.count).toBe(1)
    expect(results[0]).toEqual(results[1])
  })

  test("rejects a cache entry whose executable digest no longer matches metadata", async () => {
    const root = await temporaryRoot()
    const bytes = new TextEncoder().encode("original")
    const runtime = RuntimeAsset.managed({
      platform: currentPlatform(),
      cacheDirectory: path.join(root, "cache"),
      fetch: () => Promise.resolve(new Response(bytes)),
    })
    const asset = rawDescriptor("https://assets.example/tool", sha256(bytes))
    const downloaded = await Effect.runPromise(runtime.resolve(asset, { sources: ["public"] }))
    if (downloaded._tag !== "Available") throw new Error("fixture download failed")
    await Bun.write(downloaded.path, "tampered")

    const result = await Effect.runPromise(runtime.resolve(asset, { sources: ["cache"] }))

    expect(result._tag).toBe("Unavailable")
    expect(result._tag === "Unavailable" ? result.attempts[0]?.reason : "").toContain("digest")
  })
})

function currentPlatform(): RuntimeAsset.Platform {
  return { os: process.platform, arch: process.arch }
}

function rawDescriptor(url: string, digest: string): RuntimeAsset.Descriptor {
  return {
    id: "fixture-raw",
    version: "1.0.0",
    required: false,
    targets: [
      {
        ...currentPlatform(),
        executable: "tool",
        artifact: "tool",
        archive: "raw",
        public: url,
        sha256: digest,
      },
    ],
  }
}

function archiveDescriptor(url: string, digest: string): RuntimeAsset.Descriptor {
  return {
    id: "fixture-archive",
    version: "1.0.0",
    required: false,
    targets: [
      {
        ...currentPlatform(),
        executable: "tool",
        artifact: "fixture.tar.gz",
        archive: "tar.gz",
        entry: "bin/tool",
        public: url,
        sha256: digest,
      },
    ],
  }
}

async function temporaryRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "runtime-asset-"))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  return root
}

async function tarFixture(root: string) {
  const source = path.join(root, "source")
  const archive = path.join(root, "fixture.tar.gz")
  await mkdir(path.join(source, "bin"), { recursive: true })
  await Bun.write(path.join(source, "bin", "tool"), "fixture executable\n")
  const child = Bun.spawn(["tar", "-czf", archive, "-C", source, "."], { stdout: "pipe", stderr: "pipe" })
  const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited])
  if (exitCode !== 0) throw new Error(`tar fixture failed: ${stderr}`)
  return archive
}

function sha256(bytes: Uint8Array) {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
}
