// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { ModelV2 } from "@graphagent/core/model"
import { ProviderV2 } from "@graphagent/core/provider"
import { SessionCompactionModel } from "@/session/compaction-model"
import type { Provider } from "@/provider/provider"
import { ProviderTest } from "../fake/provider"

type Cost = Provider.Model["cost"]

function price(input: number, output: number, read = 0, write = 0): Cost {
  return { input, output, cache: { read, write } }
}

function model(id: string, cost: Cost, providerID = "test") {
  return ProviderTest.model({
    id: ModelV2.ID.make(id),
    providerID: ProviderV2.ID.make(providerID),
    cost,
  })
}

function clean(...entries: Array<[string, Cost, SessionCompactionModel.CleanKind]>) {
  return entries.map(([id, cost, kind]) => ({ model: model(id, cost), kind }))
}

function kinds(plan: ReadonlyArray<{ kind: SessionCompactionModel.PlanKind }>) {
  return plan.map((entry) => entry.kind)
}

describe("SessionCompactionModel.estimateCompactionCost", () => {
  test("charges prompt and default output tokens at the base price", () => {
    const target = model("base", price(2, 3))
    expect(SessionCompactionModel.estimateCompactionCost({ model: target, promptTokens: 1_000_000 })).toBeCloseTo(
      2.006,
      10,
    )
    expect(
      SessionCompactionModel.estimateCompactionCost({ model: target, promptTokens: 1_000_000, outputTokens: 0 }),
    ).toBeCloseTo(2, 10)
  })

  test("applies a context tier only when the prompt is strictly larger than its size", () => {
    const target = model("tiered", {
      ...price(10, 100),
      tiers: [{ ...price(2, 100), tier: { type: "context", size: 100_000 } }],
    })
    expect(
      SessionCompactionModel.estimateCompactionCost({ model: target, promptTokens: 100_000, outputTokens: 0 }),
    ).toBeCloseTo(1, 10)
    expect(
      SessionCompactionModel.estimateCompactionCost({ model: target, promptTokens: 100_001, outputTokens: 0 }),
    ).toBeCloseTo((2 * 100_001) / 1_000_000, 10)
  })

  test("uses the largest matching context tier", () => {
    const target = model("tiered", {
      ...price(10, 100),
      tiers: [
        { ...price(6, 100), tier: { type: "context", size: 50_000 } },
        { ...price(2, 100), tier: { type: "context", size: 100_000 } },
      ],
    })
    expect(
      SessionCompactionModel.estimateCompactionCost({ model: target, promptTokens: 150_000, outputTokens: 0 }),
    ).toBeCloseTo((2 * 150_000) / 1_000_000, 10)
  })

  test("falls back to the over-200K price only above 200K tokens", () => {
    const target = model("over", { ...price(10, 100), experimentalOver200K: price(20, 100) })
    expect(
      SessionCompactionModel.estimateCompactionCost({ model: target, promptTokens: 200_000, outputTokens: 0 }),
    ).toBeCloseTo(2, 10)
    expect(
      SessionCompactionModel.estimateCompactionCost({ model: target, promptTokens: 200_001, outputTokens: 0 }),
    ).toBeCloseTo((20 * 200_001) / 1_000_000, 10)
  })

  test("bills cached tokens at the cache read price", () => {
    const target = model("cached", price(10, 0, 1))
    expect(
      SessionCompactionModel.estimateCompactionCost({
        model: target,
        promptTokens: 1_000,
        outputTokens: 0,
        cachedTokens: 400,
      }),
    ).toBeCloseTo(0.0064, 10)
  })
})

describe("SessionCompactionModel.chooseCompactionModel", () => {
  test("small keeps the legacy order and ignores the shared prefix", () => {
    const sharedModel = model("shared", price(0, 0))
    const plan = SessionCompactionModel.chooseCompactionModel({
      mode: "small",
      clean: clean(["small", price(100, 100), "small"], ["agent", price(1, 1), "agent"]),
      shared: { model: sharedModel, prefixTokens: 10_000 },
      promptTokens: 50_000,
      warm: true,
    })
    expect(kinds(plan)).toEqual(["small", "agent"])
  })

  test("shared puts the shared attempt first without price ordering", () => {
    const plan = SessionCompactionModel.chooseCompactionModel({
      mode: "shared",
      clean: clean(["small", price(1, 0), "small"], ["agent", price(2, 0), "agent"]),
      shared: { model: model("shared", price(100, 0, 1)), prefixTokens: 90_000 },
      promptTokens: 100_000,
      outputTokens: 0,
      warm: true,
    })
    expect(kinds(plan)).toEqual(["shared", "small", "agent"])
  })

  test("auto orders the ladder by cost", () => {
    const plan = SessionCompactionModel.chooseCompactionModel({
      mode: "auto",
      clean: clean(
        ["small", price(1, 1), "small"],
        ["agent", price(5, 5), "agent"],
        ["conversation", price(10, 10), "conversation"],
      ),
      shared: { model: model("shared", price(2, 2, 1)), prefixTokens: 50_000 },
      promptTokens: 100_000,
      warm: true,
    })
    // clean small 0.102, shared 0.154, agent 0.51, conversation 1.02
    expect(kinds(plan)).toEqual(["small", "shared", "agent", "conversation"])
  })

  test("auto keeps the legacy order when every price is zero", () => {
    const plan = SessionCompactionModel.chooseCompactionModel({
      mode: "auto",
      clean: clean(
        ["small", price(0, 0), "small"],
        ["agent", price(0, 0), "agent"],
        ["conversation", price(0, 0), "conversation"],
      ),
      shared: { model: model("shared", price(0, 0, 0)), prefixTokens: 10_000 },
      promptTokens: 50_000,
      warm: true,
    })
    expect(kinds(plan)).toEqual(["small", "shared", "agent", "conversation"])
  })

  test("a warm prefix discounts the shared attempt", () => {
    const input = {
      mode: "auto" as const,
      clean: clean(["small", price(10, 10), "small"]),
      shared: { model: model("shared", price(10, 10, 1)), prefixTokens: 90_000 },
      promptTokens: 100_000,
      outputTokens: 0,
    }
    // warm: 90k * 1 + 10k * 10 = 0.19; cold: 100k * 10 = 1.0, tied with clean small.
    expect(kinds(SessionCompactionModel.chooseCompactionModel({ ...input, warm: true }))).toEqual(["shared", "small"])
    expect(kinds(SessionCompactionModel.chooseCompactionModel({ ...input, warm: false }))).toEqual(["small", "shared"])
  })

  test("a free cache read is not a discount", () => {
    const sharedModel = model("same", price(10, 10, 0))
    const plan = SessionCompactionModel.chooseCompactionModel({
      mode: "auto",
      clean: [{ model: sharedModel, kind: "small" }],
      shared: { model: sharedModel, prefixTokens: 90_000 },
      promptTokens: 100_000,
      outputTokens: 0,
      warm: true,
    })
    expect(kinds(plan)).toEqual(["small", "shared"])
    expect(plan[0].estimatedCost).toBe(plan[1].estimatedCost)
  })

  test("deduplicates clean candidates by model, keeping the earliest role", () => {
    const plan = SessionCompactionModel.chooseCompactionModel({
      mode: "small",
      clean: clean(["same", price(1, 1), "small"], ["same", price(1, 1), "agent"]),
      promptTokens: 10_000,
      warm: false,
    })
    expect(plan).toHaveLength(1)
    expect(plan[0].kind).toBe("small")
  })

  test("breaks equal-cost ties by rank and model identity, deterministically", () => {
    const input = {
      mode: "auto" as const,
      clean: clean(["b", price(0, 0), "small"], ["a", price(0, 0), "small"]),
      promptTokens: 10_000,
      warm: false,
    }
    const first = SessionCompactionModel.chooseCompactionModel(input)
    const second = SessionCompactionModel.chooseCompactionModel(input)
    expect(first.map((entry) => entry.model.id)).toEqual([ModelV2.ID.make("a"), ModelV2.ID.make("b")])
    expect(second.map((entry) => entry.model.id)).toEqual([ModelV2.ID.make("a"), ModelV2.ID.make("b")])
  })

  test("honors an output token override when pricing candidates", () => {
    const input = {
      mode: "auto" as const,
      clean: clean(["output-only", price(0, 100), "small"], ["input-only", price(1, 0), "agent"]),
      promptTokens: 1_000,
      warm: false,
    }
    expect(SessionCompactionModel.chooseCompactionModel(input).map((entry) => entry.model.id)).toEqual([
      ModelV2.ID.make("input-only"),
      ModelV2.ID.make("output-only"),
    ])
    expect(
      SessionCompactionModel.chooseCompactionModel({ ...input, outputTokens: 0 }).map((entry) => entry.model.id),
    ).toEqual([ModelV2.ID.make("output-only"), ModelV2.ID.make("input-only")])
  })
})
