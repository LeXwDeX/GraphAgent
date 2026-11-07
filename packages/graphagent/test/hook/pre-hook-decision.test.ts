import { describe, expect, test } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import { applyPreHookDecision, classifyPermissionAsk } from "@/hook/pre-hook-decision"
import type { TriggerResult } from "@/hook/settings"
import { Permission } from "@/permission"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"

// Unit tests for the pure PreToolUse decision helper introduced by the
// hook-trigger-result-consumption change. The helper centralizes the three
// previously-dead TriggerResult fields (updatedInput, preventContinuation,
// permissionDecision:"ask" passthrough) plus the existing deny/blocked path.
// Integration of these decisions into the four tool-execution paths is verified
// separately; these tests pin the decision logic deterministically.

const base: TriggerResult = { additionalContexts: [], systemMessages: [] }

describe("applyPreHookDecision — no-op / passthrough", () => {
  test("undefined preResult returns args unchanged (same reference)", () => {
    const args = { command: "echo hi" }
    const out = applyPreHookDecision(args, undefined)
    expect(out.effectiveArgs).toBe(args)
    expect(out.deniedReason).toBeUndefined()
    expect(out.stopReason).toBeUndefined()
  })

  test("preResult with no relevant fields returns args unchanged", () => {
    const args = { command: "echo hi" }
    const out = applyPreHookDecision(args, { ...base })
    expect(out.effectiveArgs).toBe(args)
    expect(out.deniedReason).toBeUndefined()
    expect(out.stopReason).toBeUndefined()
  })

  test("permissionDecision:'ask' is a passthrough — helper does NOT decide it", () => {
    // ask requires the effectful permission dialog and stays at the call site.
    const args = { command: "echo hi" }
    const out = applyPreHookDecision(args, { ...base, permissionDecision: "ask", permissionDecisionReason: "confirm?" })
    expect(out.effectiveArgs).toBe(args)
    expect(out.deniedReason).toBeUndefined()
    expect(out.stopReason).toBeUndefined()
  })
})

describe("applyPreHookDecision — deny / blocked", () => {
  test("permissionDecision:'deny' yields deniedReason from permissionDecisionReason", () => {
    const out = applyPreHookDecision(
      { command: "x" },
      { ...base, permissionDecision: "deny", permissionDecisionReason: "policy" },
    )
    expect(out.deniedReason).toBe("policy")
    expect(out.stopReason).toBeUndefined()
  })

  test("permissionDecision:'deny' without reason falls back to default message", () => {
    const out = applyPreHookDecision({ command: "x" }, { ...base, permissionDecision: "deny" })
    expect(out.deniedReason).toBe("Denied by PreToolUse hook")
  })

  test("blocked yields deniedReason from blocked.reason", () => {
    const out = applyPreHookDecision({ command: "x" }, { ...base, blocked: { reason: "regex no-match", command: "x" } })
    expect(out.deniedReason).toBe("regex no-match")
  })

  test("blocked without reason falls back to default message", () => {
    const malformed = { ...base, blocked: { reason: "placeholder", command: "x" } }
    Reflect.set(malformed.blocked, "reason", undefined)
    const out = applyPreHookDecision({ command: "x" }, malformed)
    expect(out.deniedReason).toBe("Denied by PreToolUse hook")
  })

  test("deny reason takes precedence over blocked reason", () => {
    const out = applyPreHookDecision(
      { command: "x" },
      {
        ...base,
        permissionDecision: "deny",
        permissionDecisionReason: "deny-wins",
        blocked: { reason: "blocked-loses", command: "x" },
      },
    )
    expect(out.deniedReason).toBe("deny-wins")
  })

  test("stop suppresses deny and updatedInput", () => {
    // A global stop outranks the tool-specific verdict and cannot replace input.
    const args = { command: "x" }
    const out = applyPreHookDecision(args, {
      ...base,
      permissionDecision: "deny",
      permissionDecisionReason: "no",
      updatedInput: { command: "rewritten" },
      preventContinuation: true,
    })
    expect(out.deniedReason).toBeUndefined()
    expect(out.stopReason).toBe("Hook requested stop")
    expect(out.effectiveArgs).toBe(args)
  })
})

describe("applyPreHookDecision — preventContinuation (continue:false)", () => {
  test("preventContinuation yields stopReason from stopReason field", () => {
    const out = applyPreHookDecision(
      { command: "x" },
      { ...base, preventContinuation: true, stopReason: "Policy violation" },
    )
    expect(out.stopReason).toBe("Policy violation")
    expect(out.deniedReason).toBeUndefined()
  })

  test("preventContinuation without stopReason falls back to default message", () => {
    const out = applyPreHookDecision({ command: "x" }, { ...base, preventContinuation: true })
    expect(out.stopReason).toBe("Hook requested stop")
  })

  test("preventContinuation suppresses updatedInput", () => {
    const args = { command: "x" }
    const out = applyPreHookDecision(args, {
      ...base,
      preventContinuation: true,
      updatedInput: { command: "rewritten" },
    })
    expect(out.stopReason).toBe("Hook requested stop")
    expect(out.effectiveArgs).toBe(args)
  })
})

describe("applyPreHookDecision — updatedInput", () => {
  test("updatedInput replaces the complete input object", () => {
    const args = { command: "echo ORIGINAL", cwd: "/tmp" }
    const out = applyPreHookDecision(args, { ...base, updatedInput: { command: "echo REWRITTEN" } })
    expect(out.effectiveArgs).toEqual({ command: "echo REWRITTEN" })
  })

  test("updatedInput absent returns the same args reference (no clone)", () => {
    const args = { command: "echo hi" }
    const out = applyPreHookDecision(args, { ...base })
    expect(out.effectiveArgs).toBe(args)
  })

  test("updatedInput can add new keys not present in original args", () => {
    const out = applyPreHookDecision({ command: "x" }, { ...base, updatedInput: { extra: "field", command: "y" } })
    expect(out.effectiveArgs).toEqual({ command: "y", extra: "field" })
  })

  test("updatedInput does not deep-merge nested objects (last hook wins, CC behavior)", () => {
    const args = { opts: { a: 1, b: 2 } }
    const out = applyPreHookDecision(args, { ...base, updatedInput: { opts: { a: 9 } } })
    // Shallow merge: the whole `opts` object is replaced, not patched.
    expect(out.effectiveArgs).toEqual({ opts: { a: 9 } })
  })
})

describe("applyPreHookDecision — decision precedence", () => {
  test("preventContinuation > deny > updatedInput ordering", () => {
    const args = { command: "x" }
    // All three present → the global stop wins.
    expect(
      applyPreHookDecision(args, {
        ...base,
        permissionDecision: "deny",
        permissionDecisionReason: "d",
        preventContinuation: true,
        stopReason: "s",
        updatedInput: { command: "u" },
      }).stopReason,
    ).toBe("s")

    // No deny → preventContinuation wins over updatedInput.
    expect(
      applyPreHookDecision(args, {
        ...base,
        preventContinuation: true,
        stopReason: "s",
        updatedInput: { command: "u" },
      }).stopReason,
    ).toBe("s")

    // No deny, no stop → updatedInput applies.
    expect(applyPreHookDecision(args, { ...base, updatedInput: { command: "u" } }).effectiveArgs).toEqual({
      command: "u",
    })
  })
})

// ── classifyPermissionAsk ───────────────────────────────────────────────
//
// Guards the "ask" confirmation path against the bug where Exit.isFailure
// masks a session abort (interrupt) or an internal bug (defect) as a denial.
// Only a typed permission rejection may become "denied"; interrupts/defects
// must propagate.

describe("classifyPermissionAsk — pure cause discrimination", () => {
  test("success → approved", () => {
    expect(classifyPermissionAsk(Exit.succeed(undefined))).toBe("approved")
  })

  test("typed rejection (RejectedError) → denied", () => {
    const exit = Exit.fail(new PermissionV1.RejectedError({}))
    expect(classifyPermissionAsk(exit)).toBe("denied")
  })

  test("typed rejection (DeniedError) → denied", () => {
    const exit = Exit.fail(new PermissionV1.DeniedError({ ruleset: [] }))
    expect(classifyPermissionAsk(exit)).toBe("denied")
  })

  test("defect → propagate (NOT denied)", () => {
    const exit = Exit.failCause(Cause.die(new Error("internal bug")))
    const out = classifyPermissionAsk(exit)
    expect(out).not.toBe("approved")
    expect(out).not.toBe("denied")
  })

  test("interrupt → propagate (NOT denied)", () => {
    const exit = Exit.failCause(Cause.interrupt(0))
    const out = classifyPermissionAsk(exit)
    expect(out).not.toBe("approved")
    expect(out).not.toBe("denied")
  })
})

describe("classifyPermissionAsk — wired through a mocked Permission service", () => {
  // Drives the real permission.ask → Effect.exit → classify path with a
  // Layer.mock'd Permission.Service so approve/deny are deterministic (the
  // interactive dialog can't run under `bun test`). This is the regression
  // guard the "ask" path otherwise lacks.
  const run = (layer: Layer.Layer<Permission.Service>) =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service
      const exit = yield* permission.ask({} as PermissionV1.AskInput).pipe(Effect.exit)
      return classifyPermissionAsk(exit)
    }).pipe(Effect.provide(layer), Effect.runPromise)

  test("ask auto-approves → approved", async () => {
    const approve = Layer.mock(Permission.Service, { ask: () => Effect.void })
    expect(await run(approve)).toBe("approved")
  })

  test("ask auto-rejects (RejectedError) → denied", async () => {
    const reject = Layer.mock(Permission.Service, { ask: () => Effect.fail(new PermissionV1.RejectedError({})) })
    expect(await run(reject)).toBe("denied")
  })

  test("ask auto-denies (DeniedError) → denied", async () => {
    const deny = Layer.mock(Permission.Service, {
      ask: () => Effect.fail(new PermissionV1.DeniedError({ ruleset: [] })),
    })
    expect(await run(deny)).toBe("denied")
  })

  test("ask dies (defect) → propagate, not denied", async () => {
    const boom = Layer.mock(Permission.Service, { ask: () => Effect.die(new Error("boom")) })
    const out = await run(boom)
    expect(out).not.toBe("approved")
    expect(out).not.toBe("denied")
  })
})

test("continue:false wins over defer and never replaces the input", () => {
  const original = { command: "original" }
  expect(
    applyPreHookDecision(original, {
      ...base,
      permissionDecision: "defer",
      preventContinuation: true,
      stopReason: "stop",
      updatedInput: { command: "changed" },
    }),
  ).toEqual({ effectiveArgs: original, stopReason: "stop" })
})
