import { describe, expect, test } from "bun:test"
import { MAX_STOP_CONTINUATIONS, stopHookBlockCap } from "@/hook/settings"

describe("Stop hook continuation cap", () => {
  test("defaults to 8 and accepts only positive integers", () => {
    expect(stopHookBlockCap({})).toBe(MAX_STOP_CONTINUATIONS)
    expect(stopHookBlockCap({ CLAUDE_CODE_STOP_HOOK_BLOCK_CAP: "12" })).toBe(12)
    for (const raw of ["", "0", "-1", "2.5", "abc"])
      expect(stopHookBlockCap({ CLAUDE_CODE_STOP_HOOK_BLOCK_CAP: raw })).toBe(MAX_STOP_CONTINUATIONS)
  })
})
