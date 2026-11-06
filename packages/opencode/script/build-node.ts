#!/usr/bin/env bun

import { Script } from "@opencode-ai/script"
import path from "path"
import { fileURLToPath } from "url"
import { buildNodeSchemaWorker, NODE_SCHEMA_WORKER_DEFINES } from "./schema-worker-build"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")

process.chdir(dir)

const generated = await import("./generate.ts")

// The backend is subsequently rebundled by Electron. Keep the worker as a
// self-contained asset, resolved beside that final module rather than the cwd.
await buildNodeSchemaWorker("./dist/node")

await Bun.build({
  target: "node",
  entrypoints: ["./src/node.ts"],
  outdir: "./dist/node",
  format: "esm",
  sourcemap: "linked",
  external: ["jsonc-parser"],
  define: {
    OPENCODE_MODELS_DEV: generated.modelsData,
    OPENCODE_CHANNEL: `'${Script.channel}'`,
    ...NODE_SCHEMA_WORKER_DEFINES,
  },
})

console.log("Build complete")
