// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { contextShare, estimateMark, type ContextShare } from "../../src/util/context-window"

// The share of its window the context uses, for the top bar, the prompt's usage line and the drawer. A model that
// declares no window is measured against the default one and says so; a model the store does not know says nothing.

type Model = NonNullable<Parameters<typeof contextShare>[1]>

describe("contextShare", () => {
  const cases: ReadonlyArray<{
    name: string
    tokens: number
    model: Model | undefined
    expected: ContextShare | undefined
  }> = [
    { name: "no model", tokens: 1_000, model: undefined, expected: undefined },
    {
      name: "a model without a profile that declares a window",
      tokens: 850,
      model: { limit: { context: 1_000 } },
      expected: { window: 1_000, percent: 85, estimated: false },
    },
    {
      name: "a model without a profile and without a window",
      tokens: 850,
      model: { limit: { context: 0 } },
      expected: undefined,
    },
    {
      name: "a model without a profile whose window is not a number",
      tokens: 850,
      model: { limit: { context: Number.NaN } },
      expected: undefined,
    },
    {
      name: "a model without a profile whose window is negative",
      tokens: 850,
      model: { limit: { context: -1 } },
      expected: undefined,
    },
    {
      name: "a profile that declares a window",
      tokens: 50_000,
      model: { limit: { context: 200_000 }, profile: { context: 200_000, sources: { context: "catalog" } } },
      expected: { window: 200_000, percent: 25, estimated: false },
    },
    {
      name: "a profile that declares none",
      tokens: 1_010,
      model: { limit: { context: 0 }, profile: { sources: {} } },
      expected: { window: 128_000, percent: 1, estimated: true },
    },
    {
      name: "an effective window below the declared one",
      tokens: 50_000,
      model: {
        limit: { context: 200_000 },
        profile: { context: 200_000, effectiveContext: 100_000, sources: { context: "catalog" } },
      },
      expected: { window: 100_000, percent: 50, estimated: false },
    },
    {
      name: "an effective window above the declared one",
      tokens: 50_000,
      model: {
        limit: { context: 200_000 },
        profile: { context: 200_000, effectiveContext: 300_000, sources: { context: "catalog" } },
      },
      expected: { window: 200_000, percent: 25, estimated: false },
    },
    {
      name: "an effective window and no declared window",
      tokens: 50_000,
      model: { limit: { context: 0 }, profile: { effectiveContext: 100_000, sources: {} } },
      expected: { window: 100_000, percent: 50, estimated: false },
    },
    {
      name: "an effective window above the default window",
      tokens: 64_000,
      model: { limit: { context: 0 }, profile: { effectiveContext: 300_000, sources: {} } },
      expected: { window: 128_000, percent: 50, estimated: true },
    },
    {
      name: "tokens past the window",
      tokens: 200_000,
      model: { limit: { context: 0 }, profile: { sources: {} } },
      expected: { window: 128_000, percent: 156, estimated: true },
    },
    {
      name: "no tokens yet",
      tokens: 0,
      model: { limit: { context: 0 }, profile: { sources: {} } },
      expected: { window: 128_000, percent: 0, estimated: true },
    },
  ]

  for (const item of cases) {
    test(`reads ${item.name}`, () => {
      expect(contextShare(item.tokens, item.model)).toEqual(item.expected)
    })
  }
})

describe("estimateMark", () => {
  test("marks a share only when it rests on the assumed window", () => {
    expect(estimateMark({ estimated: true })).toBe("~")
    expect(estimateMark({ estimated: false })).toBe("")
    expect(estimateMark({})).toBe("")
  })
})
