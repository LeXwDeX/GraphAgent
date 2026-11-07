#!/usr/bin/env bun
import { fileURLToPath } from "url"

const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)

import { $ } from "bun"
import path from "path"
import os from "os"
import { copyFile, mkdir, mkdtemp, readdir, rm } from "fs/promises"

import { createClient } from "@hey-api/openapi-ts"

const graphagent = path.resolve(dir, "../../graphagent")

// The generated spec and the raw codegen output are per-run artifacts:
// overlapping builds in one checkout never share their lifecycle, and a run
// removes only its own mkdtemp directory (forced, so an already-gone own
// artifact is not an error). Publishing into the committed src/v2/gen goes
// through a deterministic mirror (copy-over + prune of entries the new
// generation dropped, preserving clean semantics) instead of hey-api's
// tree delete: `clean: true` on the shared path deletes the tree another
// concurrent run is reading. No locking is wanted here.
const openapiTmpDir = await mkdtemp(path.join(os.tmpdir(), "opencode-sdk-openapi-"))
const openapiPath = path.join(openapiTmpDir, "openapi.json")
const genDir = path.join(openapiTmpDir, "gen")

await $`bun dev generate > ${openapiPath}`.cwd(graphagent)

await createClient({
  input: openapiPath,
  output: {
    path: genDir,
    tsConfigPath: path.join(dir, "tsconfig.json"),
    clean: true,
  },
  plugins: [
    {
      name: "@hey-api/typescript",
      exportFromIndex: false,
    },
    {
      name: "@hey-api/sdk",
      instance: "OpencodeClient",
      exportFromIndex: false,
      auth: false,
      paramsStructure: "flat",
    },
    {
      name: "@hey-api/client-fetch",
      exportFromIndex: false,
      baseUrl: "http://localhost:4096",
    },
  ],
})

await mirrorDir(genDir, path.join(dir, "src/v2/gen"))

// Patch a @hey-api/openapi-ts codegen bug: SseFn incorrectly passes the
// endpoint's TError into the second generic of ServerSentEventsResult, which
// is the AsyncGenerator's TReturn slot. Iterator return values have nothing
// to do with HTTP errors, and any consumer that calls `.return()` or returns
// from a mock generator gets type-checked against the wrong shape. Drop the
// arg so TReturn defaults to void. Fixed upstream in 0.97.x, which emits the
// corrected signature directly — patch only when the bugged form is present.
const sseTypesPath = "./src/v2/gen/client/types.gen.ts"
const sseTypesFile = Bun.file(sseTypesPath)
const sseTypesSource = await sseTypesFile.text()
const buggedSseSig = "=> Promise<ServerSentEventsResult<TData, TError>>"
const fixedSseSig = "=> Promise<ServerSentEventsResult<TData>>"
const sseTypesPatched = sseTypesSource.replace(buggedSseSig, fixedSseSig)
if (sseTypesPatched === sseTypesSource && !sseTypesSource.includes(fixedSseSig)) {
  throw new Error(`SseFn signature found in neither bugged nor fixed form; @hey-api/openapi-ts output may have changed (${sseTypesPath})`)
}
if (sseTypesPatched !== sseTypesSource) {
  await Bun.write(sseTypesPath, sseTypesPatched)
}

await $`bun prettier --write src/gen`
await $`bun prettier --write src/v2`
await $`rm -rf dist`
await $`bun tsc`
await $`rm -rf ${openapiTmpDir}`

async function mirrorDir(source: string, target: string) {
  await mkdir(target, { recursive: true })
  const entries = await readdir(source, { withFileTypes: true })
  for (const entry of entries) {
    const sourcePath = path.join(source, entry.name)
    const targetPath = path.join(target, entry.name)
    if (entry.isDirectory()) {
      await mirrorDir(sourcePath, targetPath)
    } else {
      await copyFile(sourcePath, targetPath)
    }
  }
  const kept = new Set(entries.map((entry) => entry.name))
  for (const existing of await readdir(target)) {
    if (!kept.has(existing)) {
      await rm(path.join(target, existing), { recursive: true, force: true })
    }
  }
}
