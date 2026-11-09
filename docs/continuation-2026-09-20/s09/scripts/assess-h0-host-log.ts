// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

const args = process.argv.slice(2)
const value = (name: string) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

const logPath = value("--log")
const expectedTargetRaw = value("--expected-target")
const expectedTarget = Number(expectedTargetRaw)

if (!logPath || !expectedTargetRaw || !Number.isSafeInteger(expectedTarget) || expectedTarget <= 0) {
  console.error("usage: bun assess-h0-host-log.ts --log /absolute/private.log --expected-target N")
  process.exit(2)
}

const raw = await Bun.file(logPath).text()
const lines = raw.split(/\r?\n/).filter(Boolean)

const field = (line: string, name: string) => {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const match = line.match(new RegExp(`(?:^|\\s)${escaped}=(?:"([^"]*)"|([^\\s]+))`))
  return match?.[1] ?? match?.[2]
}

const bool = (input: string | undefined) => (input === "true" ? true : input === "false" ? false : undefined)
const number = (input: string | undefined) => {
  if (input === undefined || input === "unknown") return undefined
  const parsed = Number(input)
  return Number.isFinite(parsed) ? parsed : undefined
}

const diagnosticLines = lines.filter((line) => line.includes('message="context folding"'))
const diagnostics = diagnosticLines.map((line) => ({
  run: field(line, "run"),
  runtime: field(line, "runtime"),
  requestPurpose: field(line, "requestPurpose"),
  enabledSource: field(line, "enabledSource"),
  configured: bool(field(line, "configured")),
  enabled: bool(field(line, "enabled")),
  applied: bool(field(line, "applied")),
  externalDcp: field(line, "externalDcp"),
  foldedOutputs: number(field(line, "foldedOutputs")),
  estimatedBefore: number(field(line, "estimatedBefore")),
  estimatedAfter: number(field(line, "estimatedAfter")),
  targetTokens: number(field(line, "targetTokens")),
  overBudget: bool(field(line, "overBudget")),
  skipReason: field(line, "skipReason"),
}))
const conversation = diagnostics.filter((entry) => entry.requestPurpose === "conversation")
const enabled = conversation.filter((entry) => entry.enabled === true)
const disabled = conversation.filter((entry) => entry.enabled === false)
const sessionIDs = new Set(
  lines.map((line) => field(line, "session.id")).filter((entry): entry is string => entry !== undefined),
)
const runIDs = new Set(diagnostics.map((entry) => entry.run).filter((entry): entry is string => entry !== undefined))
const errors: string[] = []

if (runIDs.size !== 1) errors.push(`expected one diagnostic run id, found ${runIDs.size}`)
if (diagnostics.some((entry) => entry.run === undefined)) errors.push("diagnostic without run id")
if (sessionIDs.size !== 2) errors.push(`expected two H0 arm sessions, found ${sessionIDs.size}`)
if (diagnostics.length !== 14) errors.push(`expected only 14 folding diagnostics, found ${diagnostics.length}`)
if (conversation.length !== 14) errors.push(`expected 14 conversation diagnostics, found ${conversation.length}`)
if (enabled.length !== 7) errors.push(`expected 7 enabled diagnostics, found ${enabled.length}`)
if (disabled.length !== 7) errors.push(`expected 7 disabled diagnostics, found ${disabled.length}`)
if (
  conversation.slice(0, 7).some((entry) => entry.enabled !== true) ||
  conversation.slice(7).some((entry) => entry.enabled !== false)
)
  errors.push("diagnostics are not ordered as seven enabled then seven disabled requests")
if (conversation.some((entry) => entry.runtime !== "opencode-ai-sdk")) errors.push("unexpected folding runtime")
if (conversation.some((entry) => entry.externalDcp === "loaded" || entry.externalDcp === "active"))
  errors.push("external DCP was active")
if (enabled.some((entry) => entry.targetTokens !== expectedTarget))
  errors.push(`enabled targetTokens mismatch; expected ${expectedTarget}`)
if (enabled.some((entry) => entry.configured !== true || entry.enabledSource !== "dynamic"))
  errors.push("enabled diagnostics were not resolved from dynamic configuration")
if (enabled.some((entry) => entry.applied !== true && entry.applied !== false))
  errors.push("enabled diagnostics contain an invalid applied flag")
if (!enabled.some((entry) => entry.skipReason === "below-target" && entry.applied === false))
  errors.push("enabled diagnostics lack a below-target control")
if (!enabled.some((entry) => entry.skipReason === "all-sources-protected" && entry.applied === false))
  errors.push("enabled diagnostics lack an all-sources-protected control")
const finalEnabled = enabled.at(-1)
if (
  !finalEnabled ||
  finalEnabled.applied !== true ||
  finalEnabled.foldedOutputs !== 3 ||
  finalEnabled.estimatedBefore === undefined ||
  finalEnabled.estimatedAfter === undefined ||
  finalEnabled.estimatedAfter >= finalEnabled.estimatedBefore ||
  finalEnabled.targetTokens !== expectedTarget ||
  finalEnabled.skipReason !== "none"
)
  errors.push("final enabled diagnostic is not the expected applied fold")
if (
  disabled.some(
    (entry) =>
      entry.configured !== false ||
      entry.enabledSource !== "environment" ||
      entry.applied !== false ||
      entry.foldedOutputs !== 0 ||
      entry.targetTokens !== undefined ||
      entry.skipReason !== "disabled",
  )
)
  errors.push("disabled diagnostics do not all fail closed")
if (!lines.some((line) => line.includes("(pass) HttpApi SDK > proves S09 H0 folding")))
  errors.push("H0 test pass marker is missing")
if (!lines.some((line) => /\b1 pass\b/.test(line)) || !lines.some((line) => /\b0 fail\b/.test(line)))
  errors.push("H0 test summary is not 1 pass / 0 fail")

const summary = {
  schemaVersion: 1,
  ok: errors.length === 0,
  errors,
  host: {
    serverPath: "raw",
    diagnosticRunCount: runIDs.size,
    sessionCount: sessionIDs.size,
    testPass: errors.every((error) => !error.startsWith("H0 test")),
  },
  diagnostics: {
    conversation: conversation.length,
    enabled: enabled.length,
    disabled: disabled.length,
    observedTargetTokens: [...new Set(enabled.map((entry) => entry.targetTokens))],
    appliedEnabled: enabled.filter((entry) => entry.applied === true).length,
    finalEnabled: finalEnabled
      ? {
          applied: finalEnabled.applied,
          foldedOutputs: finalEnabled.foldedOutputs,
          estimatedBefore: finalEnabled.estimatedBefore,
          estimatedAfter: finalEnabled.estimatedAfter,
          targetTokens: finalEnabled.targetTokens,
          overBudget: finalEnabled.overBudget,
          skipReason: finalEnabled.skipReason,
        }
      : null,
    enabledSkipReasons: [...new Set(enabled.map((entry) => entry.skipReason).filter(Boolean))].sort((a, b) =>
      String(a).localeCompare(String(b)),
    ),
    disabledSkipReasons: [...new Set(disabled.map((entry) => entry.skipReason).filter(Boolean))].sort((a, b) =>
      String(a).localeCompare(String(b)),
    ),
  },
  limitation:
    "Diagnostics have a run id but no session id. This evaluator relies on the isolated H0 test's declared enabled-then-disabled arm order; outbound and stored-history integrity are asserted separately by the test.",
}

console.log(JSON.stringify(summary, null, 2))
process.exit(summary.ok ? 0 : 1)
