// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import path from "node:path"
import { Effect } from "effect"
import { WorkflowAuthoring } from "../src/dag/authoring"
import { DagTemplateInputs } from "../src/dag/template-inputs"
import { DagValidation } from "../src/dag/validation"
import { discoverDagTemplateFiles, readRuntimeCompat } from "./dag-template-files"

/** The inputs declared by a template's YAML, or none when it does not parse
 * (the authoring result already reports that). */
function declaredInputs(content: string) {
  try {
    return DagTemplateInputs.declarationsOf(Bun.YAML.parse(content))
  } catch {
    return []
  }
}

type Authoring = ReturnType<typeof WorkflowAuthoring.make>

/** One template judged under one review gate: "authored" leaves the template's
 * own declaration in force, "strict" is the gate DAG mode applies to every
 * start (the caller override of `run.start`). */
async function judgeTemplate(
  authoring: Authoring,
  source: { kind: "yaml"; source: string; content: string },
  declares: boolean,
  gate: "authored" | "strict",
) {
  const override = gate === "strict" ? { review_gate: "strict" as const } : {}
  // A template is judged on its own: required inputs stand in as samples.
  const result = await Effect.runPromise(
    authoring.prepare({ action: "start", source, profile: "portable", template: { kind: "sample" }, ...override }),
  )
  // #1073: a template that declares inputs must start from `objective`
  // alone, the way `run.start { spec_path, inputs: { objective } }` does.
  const objectiveOnly =
    result.valid && declares
      ? await Effect.runPromise(
          authoring.prepare({
            action: "start",
            source,
            profile: "portable",
            template: { kind: "values", values: { objective: "Template validation request" } },
            ...override,
          }),
        )
      : undefined
  return { result, errors: [...result.errors, ...(objectiveOnly?.errors ?? [])] }
}

const errorKey = (diagnostic: DagValidation.Diagnostic) =>
  `${diagnostic.code}\0${diagnostic.path}\0${diagnostic.message}`

/** One directory-to-validation-result boundary shared by CI and generation.
 * #1560: DAG mode makes every start strict, so each template is judged twice,
 * as authored and under the strict gate, and fails when either fails. */
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
      const source = { kind: "yaml" as const, source: file, content }
      const declares = declaredInputs(content).length > 0
      const authored = await judgeTemplate(authoring, source, declares, "authored")
      const strict = await judgeTemplate(authoring, source, declares, "strict")
      // What the strict pass adds to the authored one: the same finding under
      // both gates is reported once, and the rest says which gate raised it.
      const known = new Set(authored.errors.map(errorKey))
      const strictOnly = strict.errors
        .filter((diagnostic) => !known.has(errorKey(diagnostic)))
        .map((diagnostic) => ({
          ...diagnostic,
          message: `${diagnostic.message} [strict review gate: DAG mode applies it to every start]`,
        }))
      const result = authored.result
      const errors = [...authored.errors, ...strictOnly]
      // Without inputs a template cannot start from run.start; the curated set is
      // moving to declared inputs, so this is a note, not a failure.
      const noInputs =
        result.valid && !declares
          ? [
              DagValidation.diagnostic({
                severity: "warning",
                code: DagValidation.DIAGNOSTIC_CODES.templateInputs,
                path: "inputs",
                message: "template declares no inputs, so it can only start as written",
                hint: "Declare inputs (at least objective) and refer to them as {{name}}",
              }),
            ]
          : []
      return {
        name: file,
        content,
        valid: errors.length === 0,
        errors,
        warnings: [...result.warnings, ...noInputs],
      }
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
