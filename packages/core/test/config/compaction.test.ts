import { describe, expect, test } from "bun:test"
import { ConfigCompaction } from "@opencode-ai/core/config/compaction"

describe("ConfigCompaction.resolveDynamic", () => {
  test.each([
    {
      name: "defaults off when both fields are missing",
      input: {},
      expected: {
        configured: false,
        enabled: false,
        source: "default",
        deprecatedPrune: false,
        skipped: "disabled",
      },
    },
    {
      name: "uses explicit dynamic true",
      input: { dynamic: true },
      expected: { configured: true, enabled: true, source: "dynamic", deprecatedPrune: false },
    },
    {
      name: "uses explicit dynamic false",
      input: { dynamic: false },
      expected: { configured: false, enabled: false, source: "dynamic", deprecatedPrune: false, skipped: "disabled" },
    },
    {
      name: "ignores deprecated prune true",
      input: { prune: true },
      expected: { configured: false, enabled: false, source: "prune", deprecatedPrune: true, skipped: "disabled" },
    },
    {
      name: "ignores deprecated prune false",
      input: { prune: false },
      expected: { configured: false, enabled: false, source: "prune", deprecatedPrune: true, skipped: "disabled" },
    },
    {
      name: "dynamic true wins a conflicting prune false",
      input: { dynamic: true, prune: false },
      expected: { configured: true, enabled: true, source: "dynamic", deprecatedPrune: false },
    },
    {
      name: "dynamic false wins a conflicting prune true",
      input: { dynamic: false, prune: true },
      expected: { configured: false, enabled: false, source: "dynamic", deprecatedPrune: false, skipped: "disabled" },
    },
    {
      name: "treats explicit undefined as missing intent",
      input: { dynamic: undefined, prune: undefined },
      expected: {
        configured: false,
        enabled: false,
        source: "default",
        deprecatedPrune: false,
        skipped: "disabled",
      },
    },
  ])("$name", ({ input, expected }) => {
    expect(
      ConfigCompaction.resolveDynamic({
        disabledByEnvironment: false,
        knownExternalDcp: "unknown",
        ...input,
      }),
    ).toMatchObject({ ...expected, externalDcp: "unknown" })
  })

  test("environment disable has highest priority", () => {
    expect(
      ConfigCompaction.resolveDynamic({
        disabledByEnvironment: true,
        dynamic: true,
        prune: true,
        knownExternalDcp: "unknown",
      }),
    ).toEqual({
      configured: false,
      enabled: false,
      source: "environment",
      deprecatedPrune: false,
      externalDcp: "unknown",
      skipped: "disabled",
    })
  })

  test("positively identified external DCP makes the builtin policy retreat", () => {
    expect(
      ConfigCompaction.resolveDynamic({
        disabledByEnvironment: false,
        dynamic: true,
        knownExternalDcp: "loaded",
      }),
    ).toEqual({
      configured: true,
      enabled: false,
      source: "dynamic",
      deprecatedPrune: false,
      externalDcp: "loaded",
      skipped: "external-dcp",
    })
  })

  test("an unknown external plugin state does not pretend a DCP was detected", () => {
    expect(
      ConfigCompaction.resolveDynamic({
        disabledByEnvironment: false,
        knownExternalDcp: "unknown",
      }),
    ).toEqual({
      configured: false,
      enabled: false,
      source: "default",
      deprecatedPrune: false,
      externalDcp: "unknown",
      skipped: "disabled",
    })
  })
})
