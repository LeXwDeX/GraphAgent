// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { RuntimeAsset } from "@graphagent/core/runtime-asset"
import { RipgrepAsset } from "@graphagent/core/runtime-asset/catalog/ripgrep"

// Build artifacts are named `<artifactPrefix>-<os>-<arch>[-<variant>]`; the
// prefix comes from the brand constant so the prefetch never hardcodes it.
export function distDirectories(names: string[], prefix: string, only?: string): string[] {
  const artifact = `${prefix}-`
  return names.filter((name) => name.startsWith(artifact)).filter((name) => !only || name === only)
}

export function derivePlatform(directory: string): RuntimeAsset.Platform | undefined {
  const parts = directory.split("-")
  const os = parts[1] === "windows" ? "win32" : parts[1]
  const arch = parts[2]
  if (os !== "darwin" && os !== "linux" && os !== "win32") return undefined
  if (!arch || !RipgrepAsset.descriptor.targets.some((target) => target.os === os && target.arch === arch)) {
    return undefined
  }
  return { os, arch }
}
