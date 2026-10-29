/**
 * Release packaging gate (change repair-workflow-authoring-validation, §6).
 *
 * One executable shape for the release pipeline's package_templates job: validate
 * (fail closed) → copy validated root YAML plus provenance/license files →
 * tar.gz → manifest JSON on
 * stdout. .azure-pipelines/release.yml and the packaging smoke test invoke this same
 * script, so CI and the test can never drift apart on the copy/tar contract.
 *
 * Usage: bun run script/package-dag-templates.ts <templates-dir> <out-archive>
 */

import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Schema } from "effect"

const templatesDir = process.argv[2]
const outArchive = process.argv[3]
if (!templatesDir || !outArchive) {
  console.error("usage: package-dag-templates.ts <templates-dir> <out-archive>")
  process.exit(2)
}

const resolvedDir = path.resolve(templatesDir)
const resolvedArchive = path.resolve(outArchive)
const distributionFiles = [
  "THIRD_PARTY_NOTICES.md",
  "third_party/mattpocock-skills/LICENSE",
  "third_party/mattpocock-skills/SOURCE.md",
] as const

const PackagingReport = Schema.Struct({
  results: Schema.Array(Schema.Struct({ name: Schema.String, valid: Schema.Boolean })),
  runtime_commit: Schema.optional(Schema.String),
  template_commit: Schema.optional(Schema.String),
  compat_runtime_sha: Schema.optional(Schema.String),
})

const validation = Bun.spawnSync({
  cmd: ["bun", path.join(import.meta.dir, "validate-dag-templates.ts"), resolvedDir],
  cwd: path.resolve(import.meta.dir, ".."),
  stdout: "pipe",
  stderr: "pipe",
})
process.stderr.write(validation.stderr.toString())
if (validation.exitCode !== 0) {
  console.error("Packaging aborted: template validation failed (nothing was archived).")
  process.exit(validation.exitCode === 0 ? 1 : validation.exitCode)
}

const report = Schema.decodeUnknownSync(PackagingReport)(JSON.parse(validation.stdout.toString()))
const files = report.results
  .filter((entry) => entry.valid)
  .map((entry) => entry.name)
  .sort()
if (files.length === 0) {
  console.error("Packaging aborted: no valid templates to archive.")
  process.exit(1)
}

const staging = await fs.mkdtemp(path.join(os.tmpdir(), "dag-template-dist-"))
try {
  for (const name of files) {
    await fs.copyFile(path.join(resolvedDir, name), path.join(staging, name))
  }
  await fs.copyFile(path.join(resolvedDir, "runtime-compat.json"), path.join(staging, "runtime-compat.json"))
  for (const name of distributionFiles) {
    await fs.mkdir(path.dirname(path.join(staging, name)), { recursive: true })
    await fs.copyFile(path.join(resolvedDir, name), path.join(staging, name))
  }
  const tar = Bun.spawnSync({
    cmd: ["tar", "-czf", resolvedArchive, "-C", staging, "."],
    stdout: "pipe",
    stderr: "pipe",
  })
  if (tar.exitCode !== 0) {
    process.stderr.write(tar.stderr.toString())
    console.error("Packaging aborted: tar failed.")
    process.exit(1)
  }
} finally {
  await fs.rm(staging, { recursive: true, force: true })
}

console.log(
  JSON.stringify(
    {
      packager: "opencode dag-template-packager v1",
      archive: resolvedArchive,
      files: [...files, "runtime-compat.json", ...distributionFiles].sort(),
      template_files: files,
      file_count: files.length + distributionFiles.length + 1,
      template_count: files.length,
      runtime_commit: report.runtime_commit,
      template_commit: report.template_commit,
      compat_runtime_sha: report.compat_runtime_sha,
    },
    null,
    2,
  ),
)
console.error(`Templates packaged: ${files.length} files (all validated) → ${resolvedArchive}`)
