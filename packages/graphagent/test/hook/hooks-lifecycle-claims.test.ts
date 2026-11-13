// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { expect } from "bun:test"
import { Effect } from "effect"
import { HookLifecycle } from "@/hook/lifecycle"
import { testEffect } from "../lib/effect"
const it = testEffect(HookLifecycle.layer)
it.instance("child attempts reject duplicate starts and stale completion or recovery replay", () =>
  Effect.gen(function* () {
    const life = yield* HookLifecycle.Service
    expect(yield* life.claimChildStart("child", "a")).toBe(true)
    expect(yield* life.claimChildStart("child", "a")).toBe(false)
    expect(yield* life.claimChildStart("child", "b")).toBe(true)
    expect(yield* life.claimChildStop("child", "a")).toBe(false)
    expect(yield* life.claimChildStop("child", "b")).toBe(true)
    expect(yield* life.claimChildStop("child", "b")).toBe(false)
    expect(yield* life.claimChildStart("child", "a")).toBe(false)
  }),
)
it.instance("ending only applies to an attached local session and is claimed once", () =>
  Effect.gen(function* () {
    const life = yield* HookLifecycle.Service
    expect(yield* life.claimEnd("unattached")).toBe(false)
    yield* life.attach("local")
    expect(yield* life.claimEnd("local")).toBe(true)
    expect(yield* life.claimEnd("local")).toBe(false)
    yield* life.attach("local")
    expect(yield* life.claimEnd("local")).toBe(true)
  }),
)

it.instance("child attempt claims stay one-shot per attempt", () =>
  Effect.gen(function* () {
    const life = yield* HookLifecycle.Service
    expect(yield* life.claimChildStart("live", "a")).toBe(true)
    expect(yield* life.claimChildStart("live", "a")).toBe(false)
    expect(yield* life.claimChildStop("live", "a")).toBe(true)
    expect(yield* life.claimChildStop("live", "a")).toBe(false)
    expect(yield* life.claimChildStop("recovered", "historical")).toBe(false)
  }),
)
