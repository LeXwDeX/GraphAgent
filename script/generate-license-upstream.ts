// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * Regenerates LICENSE-UPSTREAM.txt, the authoritative list of files inherited
 * from the upstream opencode project that stay under the MIT license.
 *
 * The list is derived from Git history and must only be regenerated from a
 * full-history checkout of this repository:
 *
 *   bun script/generate-license-upstream.ts            # rewrite the list
 *   bun script/generate-license-upstream.ts --check    # compare without writing
 *
 * A file is upstream when it existed at BASE_COMMIT and still exists today,
 * either at the same path or through a rename recorded in history. Files added
 * after BASE_COMMIT by upstream authors are listed in UPSTREAM_CHERRY_PICKS.
 * Files that copy upstream code and are not detected by rename history are
 * listed in MANUAL_UPSTREAM after a provenance review.
 *
 * Never depend on this script from CI: shallow clones do not have the history
 * it needs. CI validates LICENSE-UPSTREAM.txt instead (script/check-license.ts).
 *
 * Excluded paths (patches/, LICENSE* texts, bun.lock, *.patch, and files with
 * third-party copyright headers) are not governed by the upstream/Apache
 * file-header rules. When such a file existed at BASE_COMMIT it still belongs
 * to this list because the list tracks origin, not headers. Vendored
 * third_party/ trees are not upstream opencode and are never listed.
 */
import { $ } from "bun"
import path from "node:path"

const BASE_COMMIT = "7c0e1b431"

/**
 * Files added after BASE_COMMIT by upstream authors (cherry-picked from
 * upstream). Paths are the current repository paths; keep them sorted.
 */
export const UPSTREAM_CHERRY_PICKS = [
  "packages/graphagent/test/provider/error.test.ts",
  "packages/llm/src/protocols/utils/tool-schema.ts",
  "packages/llm/test/prepare.test.ts",
  "packages/llm/test/response.test.ts",
  "packages/llm/test/tool-schema-projection.test.ts",
] as const

/**
 * New fork files that copy upstream code but are not detected as renames.
 * Add a path here only after a provenance review shows the file is derived
 * from upstream. Keep the list sorted.
 */
export const MANUAL_UPSTREAM: readonly string[] = []

/**
 * Vendored third-party trees are not upstream opencode. Rename detection can
 * pair a deleted upstream text file with a vendored license that merely has
 * the same license body, so destinations under these prefixes are never
 * treated as upstream lineage.
 */
const NON_UPSTREAM_PREFIXES = ["third_party/"] as const

export type UpstreamGeneration = {
  files: string[]
  /** Files tracked today that the list does not classify as upstream. */
  forkFiles: string[]
}

export async function generateUpstreamList(root: string): Promise<UpstreamGeneration> {
  const baseFiles = new Set(await lines(root, ["git", "ls-tree", "-r", "--name-only", BASE_COMMIT]))
  const trackedFiles = new Set(await lines(root, ["git", "ls-files", "-z"], "\0"))

  // Rename edges from every non-merge commit in the range. The final tree diff
  // cannot see moves whose content changed a lot (a package.json rewrite, for
  // example), so lineage has to come from history.
  const renameEdges = new Map<string, string>()
  for (const line of await lines(root, [
    "git",
    "log",
    "--format=@@%H",
    "--name-status",
    "-M",
    "--diff-filter=R",
    "-l0",
    `${BASE_COMMIT}..HEAD`,
  ])) {
    if (!line.startsWith("R")) continue
    const [status, from, to] = line.split("\t")
    if (!status || !from || !to) continue
    renameEdges.set(from, to)
  }

  const diff = await lines(root, [
    "git",
    "-c",
    "diff.renameLimit=100000",
    "diff",
    "--name-status",
    "-M",
    BASE_COMMIT,
    "HEAD",
  ])
  const deleted = new Set<string>()
  const diffRenames = new Map<string, string>()
  for (const line of diff) {
    const [status, from, to] = line.split("\t")
    if (!status) continue
    if (status.startsWith("R") && from && to) {
      diffRenames.set(from, to)
    } else if (status === "D" && from) {
      deleted.add(from)
    }
  }

  const files = new Set<string>()
  for (const basePath of baseFiles) {
    if (trackedFiles.has(basePath) && !deleted.has(basePath)) {
      files.add(basePath)
      continue
    }
    const direct = diffRenames.get(basePath)
    if (direct && trackedFiles.has(direct) && isUpstreamPath(direct)) {
      files.add(direct)
      continue
    }
    const resolved = resolveRename(basePath, renameEdges)
    if (resolved !== basePath && trackedFiles.has(resolved) && isUpstreamPath(resolved)) files.add(resolved)
  }

  for (const file of [...UPSTREAM_CHERRY_PICKS, ...MANUAL_UPSTREAM]) {
    if (!trackedFiles.has(file)) throw new Error(`Upstream list entry is not a tracked file: ${file}`)
    files.add(file)
  }

  const sorted = [...files].sort(comparePaths)
  return {
    files: sorted,
    forkFiles: [...trackedFiles].filter((file) => !files.has(file)).sort(comparePaths),
  }
}

export function formatUpstreamList(files: readonly string[]) {
  return `${files.join("\n")}\n`
}

export function comparePaths(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0
}

function resolveRename(file: string, edges: Map<string, string>) {
  const seen = new Set<string>()
  let current = file
  while (edges.has(current) && !seen.has(current)) {
    seen.add(current)
    current = edges.get(current)!
  }
  return current
}

function isUpstreamPath(file: string) {
  return !NON_UPSTREAM_PREFIXES.some((prefix) => file.startsWith(prefix))
}

async function lines(root: string, cmd: string[], separator = "\n") {
  const result = await $`${cmd}`.cwd(root).quiet().nothrow()
  if (result.exitCode !== 0) {
    throw new Error(`Command failed (${result.exitCode}): ${cmd.join(" ")}\n${result.stderr.toString()}`)
  }
  return result
    .text()
    .split(separator)
    .filter((line) => line.length > 0)
}

if (import.meta.main) {
  const root = path.join(import.meta.dir, "..")
  const generation = await generateUpstreamList(root)
  const target = path.join(root, "LICENSE-UPSTREAM.txt")
  const content = formatUpstreamList(generation.files)
  const current = await Bun.file(target)
    .text()
    .catch(() => "")
  const check = process.argv.includes("--check")

  if (generation.files.length === 0) throw new Error("Refusing to write an empty upstream list")
  if (check) {
    if (current !== content) {
      console.error(`LICENSE-UPSTREAM.txt is stale: ${generation.files.length} upstream files expected`)
      process.exit(1)
    }
    console.log(`LICENSE-UPSTREAM.txt is current (${generation.files.length} entries)`)
  } else {
    await Bun.write(target, content)
    console.log(
      `Wrote LICENSE-UPSTREAM.txt (${generation.files.length} entries, ${generation.forkFiles.length} fork files)`,
    )
  }
}
