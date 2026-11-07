// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: AGPL-3.0-or-later

import { parentPort } from "node:worker_threads"
import { validateAgainstSchema } from "./schema-validator.ts"

const port = parentPort
if (!port) throw new Error("schema validation worker requires a parent port")

port.on("message", (input: { schema: Record<string, unknown>; payload: unknown }) => {
  const { schema } = input
  let payload = input.payload
  let result = validateAgainstSchema(payload, schema)
  // Some providers stringify the JSON payload. Preserve the tool's existing
  // repair, within the same resource budget as the first validation.
  if (!result.ok && typeof payload === "string") {
    let parsed = false
    try {
      payload = JSON.parse(payload)
      parsed = true
    } catch {
      // Malformed JSON leaves the original validation failure intact.
    }
    if (parsed) result = validateAgainstSchema(payload, schema)
  }
  port.postMessage({ ...result, payload })
})
