// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { test, expect } from "bun:test"
import { Schema } from "effect"
import { DagEvent } from "../src/dag-event"

// llama.cpp's OpenAI-compatible server rejects tool JSON Schemas whose `pattern`
// is not anchored at both ends ("Pattern must start with '^' and end with '$'").
// DagID flows into the workflow tool's workflow_id parameters, so every pattern
// it serializes must carry both anchors while keeping starts-with("dag") semantics.
const BOTH_ANCHORS = /^\^.*\$$/

function patternsOf(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(patternsOf)
  if (typeof node !== "object" || node === null) return []
  const record = node as Record<string, unknown>
  const own = typeof record.pattern === "string" ? [record.pattern] : []
  return [...own, ...Object.values(record).flatMap(patternsOf)]
}

test("DagID serializes to fully anchored JSON Schema patterns", () => {
  const patterns = patternsOf(Schema.toJsonSchemaDocument(DagEvent.DagID))
  expect(patterns.length).toBeGreaterThan(0)
  for (const pattern of patterns) expect(pattern).toMatch(BOTH_ANCHORS)
})

test("DagID keeps starts-with validation semantics", () => {
  const isDagID = Schema.is(DagEvent.DagID)
  expect(isDagID("dag_000ffffffffffffff0000")).toBe(true)
  expect(isDagID("dag_anything")).toBe(true)
  expect(isDagID("ses_abc123")).toBe(false)
  expect(isDagID("")).toBe(false)
})
