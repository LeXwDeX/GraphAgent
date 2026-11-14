#!/usr/bin/env bun
// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import fs from "fs"
import path from "path"
import { Effect } from "effect"
import { RuntimeAsset } from "@graphagent/core/runtime-asset"
import { RipgrepAsset } from "@graphagent/core/runtime-asset/catalog/ripgrep"
import { Script } from "@graphagent/script"
import { derivePlatform, distDirectories } from "./prefetch-ripgrep-lib"

const packageDirectory = path.resolve(import.meta.dir, "..")
const arguments_ = process.argv.slice(2)
const versionIndex = arguments_.indexOf("--version")
const requestedVersion = versionIndex === -1 ? undefined : arguments_[versionIndex + 1]
if (requestedVersion && requestedVersion !== RipgrepAsset.version) {
  throw new Error(`ripgrep version is pinned to ${RipgrepAsset.version}; requested ${requestedVersion}`)
}
const onlyIndex = arguments_.indexOf("--only")
const only = onlyIndex === -1 ? undefined : arguments_[onlyIndex + 1]
if (onlyIndex !== -1 && !only) throw new Error("--only requires a dist directory name")

const distDirectory = path.join(packageDirectory, "dist")
if (!fs.existsSync(distDirectory)) {
  console.error(`[prefetch-ripgrep] no dist/ directory at ${distDirectory}; build first.`)
  process.exit(2)
}

const prefix = Script.artifactPrefix
const names = fs
  .readdirSync(distDirectory, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
const directories = distDirectories(names, prefix, only)
if (!directories.length) {
  console.error(`[prefetch-ripgrep] no ${prefix}-* directories under ${distDirectory}.`)
  process.exit(2)
}

const cacheDirectory = path.join(distDirectory, ".rg-cache")
const runtimes = new Map<string, RuntimeAsset.Interface>()
const sources: RuntimeAsset.Source[] = process.env.GRAPHAGENT_RUNTIME_ASSET_MIRROR
  ? ["cache", "mirror", "public"]
  : ["cache", "public"]
const results = await Promise.all(
  directories.map(async (directory) => {
    const platform = derivePlatform(directory)
    if (!platform) return { directory, status: "skipped" as const }
    const key = `${platform.os}-${platform.arch}`
    const runtime =
      runtimes.get(key) ??
      RuntimeAsset.managed({
        platform,
        cacheDirectory,
        mirrorBaseURL: process.env.GRAPHAGENT_RUNTIME_ASSET_MIRROR,
      })
    runtimes.set(key, runtime)
    console.log(`[prefetch-ripgrep] ${directory} -> ${key}`)

    const resolved = await Effect.runPromise(runtime.resolve(RipgrepAsset.descriptor, { sources }))
    if (resolved._tag !== "Available") throw new Error(`ripgrep unavailable for ${key}: ${resolved.reason}`)
    const bin = path.join(distDirectory, directory, "bin")
    const target = path.join(bin, path.basename(resolved.path))
    fs.mkdirSync(bin, { recursive: true })
    fs.copyFileSync(resolved.path, target)
    if (platform.os !== "win32") fs.chmodSync(target, 0o755)
    console.log(`[prefetch-ripgrep]   wrote ${path.relative(packageDirectory, target)} from ${resolved.source}`)
    return { directory, status: "injected" as const }
  }),
)

const injected = results.filter((result) => result.status === "injected")
const skipped = results.filter((result) => result.status === "skipped")
console.log(`[prefetch-ripgrep] done: ${injected.length} directory(ies) injected, ${skipped.length} skipped.`)
skipped.forEach((result) => console.log(`  - skip ${result.directory} (unsupported platform)`))
