import { describe, expect, test } from "bun:test"
import { declaredModels, sortModelOptions } from "../../../../src/util/model-options"

describe("declaredModels", () => {
  test("holds the keys of a provider's models and the entries of its whitelist", () => {
    const declared = declaredModels({
      provider: {
        alpha: { models: { a1: {}, a2: { name: "Alpha Two" } } },
        beta: { whitelist: ["b1", "b2"] },
        gamma: { models: { g1: {} }, whitelist: ["g2"] },
      },
    })
    expect([...declared.keys()]).toEqual(["alpha", "beta", "gamma"])
    expect([...declared.get("alpha")!]).toEqual(["a1", "a2"])
    expect([...declared.get("beta")!]).toEqual(["b1", "b2"])
    expect([...declared.get("gamma")!].sort()).toEqual(["g1", "g2"])
  })

  test("a provider with neither models nor a whitelist declares no model, and one that is not listed is not there", () => {
    const declared = declaredModels({ provider: { delta: { options: { baseURL: "http://delta.test" } }, eps: {} } })
    expect(declared.get("delta")?.size).toBe(0)
    expect(declared.get("eps")?.size).toBe(0)
    expect(declared.has("zeta")).toBe(false)
    expect(declaredModels({}).size).toBe(0)
    expect(declaredModels({ provider: {} }).size).toBe(0)
  })

  test("names only what is written: nothing a plain object has of its own, and nothing of another provider", () => {
    const declared = declaredModels({ provider: { alpha: { models: { a1: {} } }, beta: { whitelist: [] } } })
    expect(declared.get("alpha")?.has("a1")).toBe(true)
    expect(declared.get("alpha")?.has("constructor")).toBe(false)
    expect(declared.get("alpha")?.has("toString")).toBe(false)
    expect(declared.get("beta")?.has("a1")).toBe(false)
    expect(declared.get("beta")?.size).toBe(0)
  })
})

describe("sortModelOptions", () => {
  test("orders provider-scoped model choices by newest release first", () => {
    const sorted = sortModelOptions(
      [
        { title: "GPT 5.2", releaseDate: "2025-12-11" },
        { title: "GPT 5.4", releaseDate: "2026-03-05" },
        { title: "GPT 5.1", releaseDate: "2025-11-13" },
      ],
      true,
    )

    expect(sorted.map((model) => model.title)).toEqual(["GPT 5.4", "GPT 5.2", "GPT 5.1"])
  })

  test("orders regular model choices free-first and then newest-first", () => {
    const sorted = sortModelOptions(
      [
        { title: "GLM 5", releaseDate: "2025-07-28" },
        { title: "GLM 5.1", releaseDate: "2025-12-09" },
        { title: "GLM 5.2", releaseDate: "2026-02-16" },
        { title: "Free old", releaseDate: "2024-01-01", footer: "Free" },
        { title: "Free new", releaseDate: "2025-01-01", footer: "Free" },
      ],
      false,
    )

    expect(sorted.map((model) => model.title)).toEqual(["Free new", "Free old", "GLM 5.2", "GLM 5.1", "GLM 5"])
  })
})
