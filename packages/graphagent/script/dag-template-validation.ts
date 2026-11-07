import path from "node:path"
import { Effect } from "effect"
import { WorkflowAuthoring } from "../src/dag/authoring"
import { discoverDagTemplateFiles, readRuntimeCompat } from "./dag-template-files"

/** One directory-to-validation-result boundary shared by CI and generation. */
export async function validateDagTemplateDirectory(directory: string) {
  const compat = await readRuntimeCompat(directory).then(
    (value) => ({ value, error: undefined }),
    (error: unknown) => ({
      value: undefined,
      error: error instanceof Error ? error.message : String(error),
    }),
  )
  const discovery = await discoverDagTemplateFiles(directory).then(
    (files) => ({ files, error: undefined }),
    (error: unknown) => ({
      files: [],
      error: error instanceof Error ? error.message : String(error),
    }),
  )
  const authoring = WorkflowAuthoring.make()
  const results = await Promise.all(
    discovery.files.map(async (file) => {
      const content = await Bun.file(path.join(directory, file)).text()
      const result = await Effect.runPromise(
        authoring.prepare({
          action: "start",
          source: { kind: "yaml", source: file, content },
          profile: "portable",
        }),
      )
      return { name: file, content, valid: result.valid, errors: result.errors, warnings: result.warnings }
    }),
  )
  return {
    compat: compat.value,
    compat_error: compat.error,
    discovery_error: discovery.error,
    results,
  }
}

export function dagTemplateDirectoryFailure(result: Awaited<ReturnType<typeof validateDagTemplateDirectory>>) {
  if (result.compat_error) return result.compat_error
  if (result.discovery_error) return result.discovery_error
  const invalid = result.results.filter((entry) => !entry.valid)
  if (invalid.length > 0) {
    return `DAG template validation failed:\n${invalid
      .flatMap((entry) =>
        entry.errors.map(
          (diagnostic) =>
            `- ${entry.name} [${diagnostic.code}] ${diagnostic.path}: ${diagnostic.message}`,
        ),
      )
      .join("\n")}`
  }
  if (result.results.length === 0) return "no templates found in directory"
  return undefined
}
