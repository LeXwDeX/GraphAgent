/**
 * Directory-level template validator (change repair-workflow-authoring-validation, §4.3).
 *
 * Reuses the runtime source-to-graph authority (WorkflowAuthoring) so
 * config-repo CI and release packaging enforce the same portable contract. Emits machine-readable diagnostics plus the runtime,
 * template, and compatibility commit identifiers, and exits non-zero when any
 * template is invalid.
 *
 * Usage: bun run script/validate-dag-templates.ts <templates-dir>
 */

import path from "node:path"
import { dagTemplateDirectoryFailure, validateDagTemplateDirectory } from "./dag-template-validation"

const templatesDir = process.argv[2]
if (!templatesDir) {
  console.error("usage: validate-dag-templates.ts <templates-dir>")
  process.exit(2)
}

const resolvedDir = path.resolve(templatesDir)

async function gitHead(cwd: string): Promise<string | undefined> {
  try {
    const result = await Bun.$`git rev-parse HEAD`.cwd(cwd).quiet()
    return result.text().trim() || undefined
  } catch {
    return undefined
  }
}

const validation = await validateDagTemplateDirectory(resolvedDir)
const invalid = validation.results.filter((entry) => !entry.valid)
const report = {
  validator: "opencode WorkflowAuthoring.portable v1",
  templates_dir: resolvedDir,
  runtime_commit: await gitHead(path.resolve(import.meta.dir, "..", "..", "..")),
  template_commit: await gitHead(resolvedDir),
  compat_runtime_sha: validation.compat?.runtime_commit,
  compat_error: validation.compat_error,
  discovery_error: validation.discovery_error,
  template_count: validation.results.length,
  valid_count: validation.results.length - invalid.length,
  invalid_count: invalid.length,
  results: validation.results.map((entry) => ({
    name: entry.name,
    valid: entry.valid,
    errors: entry.errors,
    warnings: entry.warnings,
  })),
}

// Machine-readable report goes to stdout; human summaries go to stderr so
// callers can `JSON.parse(stdout)` without stripping trailers.
console.log(JSON.stringify(report, null, 2))
const failure = dagTemplateDirectoryFailure(validation)
if (failure) {
  console.error(`Template validation failed: ${failure}`)
  process.exit(1)
}
console.error(
  `Template validation passed: ${validation.results.length} of ${validation.results.length} templates valid`,
)
