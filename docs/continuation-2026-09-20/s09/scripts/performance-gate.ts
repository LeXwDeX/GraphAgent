// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

type JsonObject = Record<string, unknown>

const path = process.argv[2]
if (!path) {
  console.error("usage: bun performance-gate.ts /absolute/performance-result.json")
  process.exit(2)
}

const errors: string[] = []
const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const isNonEmptyString = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0
const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value)
const isInteger = (value: unknown): value is number => isFiniteNumber(value) && Number.isInteger(value)

let parsed: unknown
try {
  parsed = await Bun.file(path).json()
} catch (error) {
  console.log(
    JSON.stringify(
      {
        schemaVersion: 1,
        ok: false,
        errors: [`input is not readable JSON: ${error instanceof Error ? error.message : "unknown error"}`],
      },
      null,
      2,
    ),
  )
  process.exit(1)
}

if (!isObject(parsed)) errors.push("root must be a JSON object")
const input: JsonObject = isObject(parsed) ? parsed : {}

if (input.schemaVersion !== 1) errors.push("schemaVersion must be exactly 1")
if (typeof input.candidateSha !== "string" || !/^[0-9a-f]{40}$/.test(input.candidateSha))
  errors.push("candidateSha must be a 40-character lowercase hex SHA")
if (typeof input.rawSamplesSha256 !== "string" || !/^[0-9a-f]{64}$/.test(input.rawSamplesSha256))
  errors.push("rawSamplesSha256 must be a 64-character lowercase hex SHA256")

if (!isObject(input.runtime)) {
  errors.push("runtime must be an object")
} else {
  if (!isNonEmptyString(input.runtime.bun)) errors.push("runtime.bun must be a non-empty string")
  if (!isNonEmptyString(input.runtime.platform)) errors.push("runtime.platform must be a non-empty string")
  if (!isNonEmptyString(input.runtime.cpu)) errors.push("runtime.cpu must be a non-empty string")
  if (!isInteger(input.runtime.ramMiB) || input.runtime.ramMiB <= 0)
    errors.push("runtime.ramMiB must be a positive finite integer")
}

const methodKeys = [
  "pairedPerRepetition",
  "rssUsesFreshProcessBaseline",
  "coversBudgetScanCompareCopyFingerprintVerify",
] as const
if (!isObject(input.method)) {
  errors.push("method must be an object")
} else {
  for (const key of methodKeys) {
    if (input.method[key] !== true) errors.push(`method.${key} must be exactly boolean true`)
  }
}

const sizeClasses = ["1MiB", "8MiB"] as const
type SizeClass = (typeof sizeClasses)[number]
const limits = {
  "1MiB": { minBytes: 900_000, maxBytes: 1_300_000, p95Ms: 25, rssMiB: 64, minWarmup: 5, minRepetitions: 20 },
  "8MiB": { minBytes: 7_500_000, maxBytes: 9_000_000, p95Ms: 250, rssMiB: 256, minWarmup: 3, minRepetitions: 10 },
} as const

const rows: JsonObject[] = []
if (!Array.isArray(input.rows)) {
  errors.push("rows must be an array")
} else {
  if (input.rows.length !== 2) errors.push(`rows must contain exactly two entries, found ${input.rows.length}`)
  input.rows.forEach((row, index) => {
    if (!isObject(row)) errors.push(`rows[${index}] must be an object`)
    else rows.push(row)
  })
}

const validateRow = (row: JsonObject, label: SizeClass) => {
  const limit = limits[label]
  const prefix = label

  if (!isInteger(row.serializedInputBytes)) {
    errors.push(`${prefix}: serializedInputBytes must be a finite integer`)
  } else if (row.serializedInputBytes < limit.minBytes || row.serializedInputBytes > limit.maxBytes) {
    errors.push(
      `${prefix}: serializedInputBytes ${row.serializedInputBytes} outside [${limit.minBytes}, ${limit.maxBytes}]`,
    )
  }

  if (!isInteger(row.projectedOutputBytes) || row.projectedOutputBytes <= 0) {
    errors.push(`${prefix}: projectedOutputBytes must be a positive finite integer`)
  } else if (isInteger(row.serializedInputBytes) && row.projectedOutputBytes >= row.serializedInputBytes) {
    errors.push(`${prefix}: projectedOutputBytes must be smaller than serializedInputBytes`)
  }

  if (!isInteger(row.warmup)) errors.push(`${prefix}: warmup must be a finite integer`)
  else if (row.warmup < limit.minWarmup) errors.push(`${prefix}: warmup ${row.warmup} below ${limit.minWarmup}`)

  if (!isInteger(row.repetitions)) errors.push(`${prefix}: repetitions must be a finite integer`)
  else if (row.repetitions < limit.minRepetitions)
    errors.push(`${prefix}: repetitions ${row.repetitions} below ${limit.minRepetitions}`)

  if (!isFiniteNumber(row.p95IncrementalMs) || row.p95IncrementalMs < 0) {
    errors.push(`${prefix}: p95IncrementalMs must be a finite non-negative number`)
  } else if (row.p95IncrementalMs > limit.p95Ms) {
    errors.push(`${prefix}: p95 incremental ${row.p95IncrementalMs} ms exceeds ${limit.p95Ms} ms`)
  }

  if (!isFiniteNumber(row.rssDeltaPeakMiB) || row.rssDeltaPeakMiB < 0) {
    errors.push(`${prefix}: rssDeltaPeakMiB must be a finite non-negative number`)
  } else if (row.rssDeltaPeakMiB > limit.rssMiB) {
    errors.push(`${prefix}: RSS delta ${row.rssDeltaPeakMiB} MiB exceeds ${limit.rssMiB} MiB`)
  }

  if (row.originalIntact !== true) errors.push(`${prefix}: originalIntact must be exactly boolean true`)
  if (row.witnessIntact !== true) errors.push(`${prefix}: witnessIntact must be exactly boolean true`)
  if (row.applied !== true) errors.push(`${prefix}: applied must be exactly boolean true`)
  if (!isInteger(row.foldedOutputs) || row.foldedOutputs <= 0)
    errors.push(`${prefix}: foldedOutputs must be a positive finite integer`)
}

for (const label of sizeClasses) {
  const matching = rows.filter((row) => row.class === label)
  if (matching.length !== 1) errors.push(`${label}: expected exactly one row, found ${matching.length}`)
  else validateRow(matching[0]!, label)
}
for (const row of rows) {
  if (row.class !== "1MiB" && row.class !== "8MiB") errors.push(`unknown row class: ${String(row.class)}`)
}

const requiredControls: Record<string, string | undefined> = {
  "all-unique": "no-eligible-duplicates",
  "all-protected": "all-sources-protected",
  "below-target": "below-target",
  "work-limit": "work-limit",
  "budget-exhausted": "work-limit",
}

const controls: JsonObject[] = []
if (!Array.isArray(input.controls)) {
  errors.push("controls must be an array")
} else {
  const expectedCount = Object.keys(requiredControls).length
  if (input.controls.length !== expectedCount)
    errors.push(`controls must contain exactly ${expectedCount} entries, found ${input.controls.length}`)
  input.controls.forEach((control, index) => {
    if (!isObject(control)) errors.push(`controls[${index}] must be an object`)
    else controls.push(control)
  })
}

for (const [name, expectedReason] of Object.entries(requiredControls)) {
  const matching = controls.filter((control) => control.name === name)
  if (matching.length !== 1) {
    errors.push(`${name}: expected exactly one control, found ${matching.length}`)
    continue
  }
  const control = matching[0]!
  if (control.passed !== true) errors.push(`${name}: passed must be exactly boolean true`)
  if (control.originalIntact !== true) errors.push(`${name}: originalIntact must be exactly boolean true`)
  if (control.requestUnchanged !== true) errors.push(`${name}: requestUnchanged must be exactly boolean true`)
  if (control.applied !== false) errors.push(`${name}: applied must be exactly boolean false`)
  if (control.foldedOutputs !== 0) errors.push(`${name}: foldedOutputs must be exactly numeric zero`)
  if (!isNonEmptyString(control.skipReason) || control.skipReason === "REPLACE_WITH_FIXED_ENUM")
    errors.push(`${name}: fixed skipReason is missing`)
  if (expectedReason !== undefined && control.skipReason !== expectedReason)
    errors.push(`${name}: skipReason ${String(control.skipReason)} does not equal ${expectedReason}`)
}
for (const control of controls) {
  if (!isNonEmptyString(control.name) || !(control.name in requiredControls))
    errors.push(`unknown control name: ${String(control.name)}`)
}

const summary = {
  schemaVersion: 1,
  ok: errors.length === 0,
  errors,
  candidateSha: typeof input.candidateSha === "string" ? input.candidateSha : null,
  rows: rows.map((row) => ({
    class: row.class,
    serializedInputBytes: row.serializedInputBytes,
    projectedOutputBytes: row.projectedOutputBytes,
    p95IncrementalMs: row.p95IncrementalMs,
    rssDeltaPeakMiB: row.rssDeltaPeakMiB,
    applied: row.applied,
    foldedOutputs: row.foldedOutputs,
  })),
  rawSamplesSha256: typeof input.rawSamplesSha256 === "string" ? input.rawSamplesSha256 : null,
}

console.log(JSON.stringify(summary, null, 2))
process.exit(summary.ok ? 0 : 1)
