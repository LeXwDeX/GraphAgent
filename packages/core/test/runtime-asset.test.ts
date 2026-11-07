import { describe, expect, test } from "bun:test"
import { Effect, Result } from "effect"
import { LayerNode } from "@graphagent/core/effect/layer-node"
import { RuntimeAsset } from "@graphagent/core/runtime-asset"

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
