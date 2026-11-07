// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Worker } from "node:worker_threads"
import type { SchemaValidationFix } from "./schema-validator"

declare const GRAPHAGENT_SCHEMA_VALIDATION_WORKER_PATH: string | URL
declare const GRAPHAGENT_SCHEMA_VALIDATION_WORKER_RELATIVE: boolean

// Host resource budget, including worker startup and both provider spellings.
// This is independent of the workflow's model deadline.
export const SCHEMA_VALIDATION_BUDGET_MS = 250

export type Validation = { ok: true; payload: unknown } | { ok: false; error: string; fix?: SchemaValidationFix }

export function validateInWorker(
  schema: Record<string, unknown>,
  payload: unknown,
  signal: AbortSignal,
  budgetMS = SCHEMA_VALIDATION_BUDGET_MS,
  workerTarget?: string | URL,
): Promise<Validation> {
  return new Promise((resolve) => {
    let worker: Worker | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let settled = false
    const finish = (result: Validation) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      signal.removeEventListener("abort", cancel)
      void worker?.terminate()
      resolve(result)
    }
    const cancel = () => finish({ ok: false, error: "schema validation cancelled" })
    if (signal.aborted) return cancel()
    signal.addEventListener("abort", cancel, { once: true })
    timer = setTimeout(
      () => finish({ ok: false, error: `schema validation exceeded its ${budgetMS} ms host resource budget` }),
      budgetMS,
    )
    try {
      const configured =
        typeof GRAPHAGENT_SCHEMA_VALIDATION_WORKER_PATH !== "undefined"
          ? GRAPHAGENT_SCHEMA_VALIDATION_WORKER_PATH
          : new URL("./schema-validation-worker.ts", import.meta.url)
      const target =
        typeof GRAPHAGENT_SCHEMA_VALIDATION_WORKER_RELATIVE !== "undefined" && GRAPHAGENT_SCHEMA_VALIDATION_WORKER_RELATIVE
          ? new URL(configured, import.meta.url)
          : configured
      worker = new Worker(workerTarget ?? target, { execArgv: [] })
      worker.on("message", (result: Validation) => finish(result))
      worker.on("error", (error: Error) =>
        finish({ ok: false, error: `schema validation worker failed: ${error.message}` }),
      )
      worker.on("messageerror", () =>
        finish({ ok: false, error: "schema validation worker response could not be read" }),
      )
      worker.on("exit", (code) =>
        finish({ ok: false, error: `schema validation worker exited before returning a result (${code})` }),
      )
      worker.postMessage({ schema, payload })
    } catch (error) {
      finish({ ok: false, error: `schema validation worker failed: ${String(error)}` })
    }
  })
}
