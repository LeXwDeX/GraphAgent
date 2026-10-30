import { describe, expect, test } from "bun:test"
import { ConfigCompaction } from "@opencode-ai/core/config/compaction"
import { contextFoldingDiagnostic, type FoldPlan } from "../../src/session/context-folding"

describe("context folding diagnostics", () => {
  test("reports disabled without configuration so the request log says why nothing folded", () => {
    const diagnostic = contextFoldingDiagnostic({
      runtime: "core-runner",
      requestPurpose: "conversation",
      resolution: ConfigCompaction.resolveDynamic({
        disabledByEnvironment: false,
        knownExternalDcp: "unknown",
      }),
    })

    expect(diagnostic).toMatchObject({
      configured: false,
      enabled: false,
      enabledSource: "default",
      skipReason: "disabled",
    })
  })

  test("emits only allow-listed aggregate fields and preserves unknown estimates", () => {
    const duplicatePlan: FoldPlan = {
      replacements: [
        {
          source: { messageID: "secret-message", partID: "secret-part", callID: "secret-call" },
          witness: { messageID: "witness-message", partID: "witness-part", callID: "witness-call" },
        },
      ],
      protectedStepIDs: ["secret-step"],
      exclusions: [
        {
          ref: { messageID: "excluded-message", partID: "excluded-part", callID: "excluded-call" },
          reason: "unknown-content",
        },
      ],
      skipReason: undefined,
    }
    const diagnostic = contextFoldingDiagnostic({
      runtime: "core-runner",
      requestPurpose: "conversation",
      resolution: {
        configured: true,
        enabled: true,
        source: "default",
        deprecatedPrune: false,
        externalDcp: "unknown",
      },
      duplicatePlan,
    })

    expect(diagnostic).toEqual({
      policyVersion: "strict-duplicate-v2",
      runtime: "core-runner",
      requestPurpose: "conversation",
      enabledSource: "default",
      configured: true,
      enabled: true,
      externalDcp: "unknown",
      applied: false,
      duplicateGroups: 1,
      foldedOutputs: 0,
      excludedOutputs: 1,
      excludedByReason: {
        attachments: 0,
        "incomplete-content": 0,
        "instruction-content": 0,
        "invalid-provenance": 0,
        "normalization-failed": 0,
        "provider-executed": 0,
        "unknown-content": 1,
        "unknown-read-target": 0,
        "unsafe-error-payload": 0,
        unsuccessful: 0,
        "unsupported-tool": 0,
        "untrusted-source": 0,
      },
      protectedSteps: 1,
      estimatedBefore: "unknown",
      estimatedAfter: "unknown",
      estimatedSavings: "unknown",
      targetTokens: "unknown",
      overBudget: "unknown",
      skipReason: "not-evaluated",
    })
    const serialized = JSON.stringify(diagnostic)
    for (const forbidden of ["secret", "witness-message", "excluded-message", "fingerprint", "filePath", "args"]) {
      expect(serialized).not.toContain(forbidden)
    }
  })

  test("reports explicit disablement without manufacturing zero token estimates", () => {
    expect(
      contextFoldingDiagnostic({
        runtime: "opencode-ai-sdk",
        requestPurpose: "conversation",
        resolution: {
          configured: true,
          enabled: false,
          source: "dynamic",
          deprecatedPrune: false,
          externalDcp: "loaded",
          skipped: "external-dcp",
        },
      }),
    ).toMatchObject({
      enabled: false,
      externalDcp: "loaded",
      estimatedBefore: "unknown",
      estimatedAfter: "unknown",
      estimatedSavings: "unknown",
      excludedByReason: "unknown",
      protectedSteps: "unknown",
      skipReason: "external-dcp",
    })
  })
})
