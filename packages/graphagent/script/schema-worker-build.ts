// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { fileURLToPath } from "node:url"

export const NODE_SCHEMA_WORKER_NAME = "schema-validation-worker.mjs"
export const NODE_SCHEMA_WORKER_DEFINES = {
  GRAPHAGENT_SCHEMA_VALIDATION_WORKER_PATH: `./${NODE_SCHEMA_WORKER_NAME}`,
  GRAPHAGENT_SCHEMA_VALIDATION_WORKER_RELATIVE: "true",
}

/** Self-contained so Electron can copy it beside its rolled-up backend chunk. */
export async function buildNodeSchemaWorker(outdir: string) {
  const result = await Bun.build({
    target: "node",
    entrypoints: [fileURLToPath(new URL("../src/dag/runtime/schema-validation-worker.ts", import.meta.url))],
    outdir,
    naming: NODE_SCHEMA_WORKER_NAME,
    format: "esm",
  })
  if (!result.success) throw new AggregateError(result.logs, "Schema validation worker build failed")
}
