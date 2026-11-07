import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { RipgrepBinary } from "@graphagent/core/ripgrep/binary"
import { RuntimeAsset } from "@graphagent/core/runtime-asset"
import { RipgrepAsset } from "@graphagent/core/runtime-asset/catalog/ripgrep"

describe("RipgrepBinary", () => {
  RuntimeAsset.sources.forEach((selected) => {
    test(`falls back through RuntimeAsset candidates to ${selected}`, async () => {
      const attempts: RuntimeAsset.Source[] = []
      const candidate =
        (source: RuntimeAsset.Source): RuntimeAsset.Candidate =>
        () => {
          attempts.push(source)
          return source === selected
            ? Effect.succeed({ path: `/${source}/rg` })
            : Effect.fail(new RuntimeAsset.CandidateUnavailable({ reason: `${source} unavailable` }))
        }
      const candidates: RuntimeAsset.Candidates = {
        system: candidate("system"),
        packaged: candidate("packaged"),
        cache: candidate("cache"),
        mirror: candidate("mirror"),
        public: candidate("public"),
      }
      const layer = RipgrepBinary.layer.pipe(
        Layer.provide(
          RuntimeAsset.layer({
            platform: { os: "linux", arch: "x64" },
            candidates,
          }),
        ),
      )
      const filepath = await Effect.runPromise(
        Effect.gen(function* () {
          return yield* (yield* RipgrepBinary.Service).filepath
        }).pipe(Effect.provide(layer)),
      )

      expect(filepath).toBe(`/${selected}/rg`)
      expect(attempts).toEqual(RuntimeAsset.sources.slice(0, RuntimeAsset.sources.indexOf(selected) + 1))
    })
  })

  test("pins official archive metadata for every supported target", () => {
    expect(RipgrepAsset.descriptor).toMatchObject({ id: "ripgrep", version: "15.1.0", required: true })
    expect(RipgrepAsset.descriptor.targets).toHaveLength(7)
    expect(
      RipgrepAsset.descriptor.targets.every(
        (target) =>
          target.public?.includes(`/15.1.0/${target.artifact}`) &&
          target.entry?.endsWith(`/${target.executable}`) &&
          /^[a-f0-9]{64}$/.test(target.sha256 ?? ""),
      ),
    ).toBe(true)
  })
})
