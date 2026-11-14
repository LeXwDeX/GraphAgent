// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { Effect } from "effect"
import { DagValidation } from "@/dag/validation"
import { DagWorkflows } from "@/dag/workflows"
import { WorkflowAuthoring } from "@/dag/authoring"
import type { Tool } from "../tool"
import { WORKFLOW_RECOVERY, blockedMetadata, validationOutput } from "./render"
import { entryContent, loadSpecFile, readDraftSpec, searchedScopes, writeDraftSpec } from "./files"
import type { DraftGraphType, Metadata } from "./schema"

type Authoring = ReturnType<typeof WorkflowAuthoring.make>

/** Fields shared by every spec action; the calling session owns the project
 * and directory a relative spec path resolves against. */
export interface SessionContext {
  readonly projectID: string
  readonly directory: string
  readonly model: { readonly id: string; readonly providerID: string } | undefined
}

export const portableEntryCheck = (authoring: Authoring, entry: DagWorkflows.Entry) =>
  Effect.gen(function* () {
    const content = yield* Effect.promise(() => entryContent(entry))
    if (content === undefined) {
      return { valid: false, summary: "[schema.invalid] spec content is unreadable" }
    }
    const result = yield* authoring.prepare({
      action: "start",
      source: { kind: "yaml", source: entry.path, content },
      profile: "portable",
    })
    const summary = result.valid
      ? ""
      : result.errors
          .slice(0, 3)
          .map((d) => `[${d.code}] ${d.path}: ${d.message}`)
          .join("; ")
    return { valid: result.valid, summary }
  })

export const listSpecs = (authoring: Authoring, directory: string): Effect.Effect<Tool.ExecuteResult> =>
  Effect.gen(function* () {
    const entries = yield* DagWorkflows.list(directory)
    if (entries.length === 0) {
      return {
        title: "No saved workflows",
        output: `The workflow library is empty. Searched ${searchedScopes(directory)}. Save a spec as <name>.yaml in one of those directories to start it later by name.`,
        metadata: {},
      }
    }
    const rows: string[] = []
    for (const entry of entries) {
      const check = yield* portableEntryCheck(authoring, entry)
      rows.push(
        [
          `${entry.name} [${entry.scope}]${check.valid ? "" : " [invalid — not startable]"}`,
          entry.title ? ` — ${entry.title}` : "",
          entry.nodes !== undefined
            ? ` (${entry.nodes} nodes)`
            : entry.blocks !== undefined
              ? ` (${entry.blocks} blocks)`
              : "",
          entry.objective ? `\n  objective: ${entry.objective}` : "",
          `\n  path: ${entry.path}`,
          check.valid ? "" : `\n  ${check.summary}`,
        ].join(""),
      )
    }
    return {
      title: `${entries.length} saved workflow${entries.length > 1 ? "s" : ""}`,
      output: rows.join("\n"),
      metadata: {},
    }
  })

export const readSpec = (
  authoring: Authoring,
  specPath: string,
  session: SessionContext,
  ctx: Tool.Context,
): Effect.Effect<Tool.ExecuteResult> =>
  Effect.gen(function* () {
    const specFile = yield* loadSpecFile(specPath, session.directory, session.projectID, ctx).pipe(Effect.orDie)
    const validation = yield* authoring.prepare({
      action: "start",
      source: { kind: "yaml", source: specFile.path, content: specFile.content },
      profile: "portable",
    })
    return {
      title: `Workflow spec: ${specPath}`,
      output: JSON.stringify(
        {
          spec: validation.document,
          validation: {
            valid: validation.valid,
            errors: validation.errors,
            warnings: validation.warnings,
          },
        },
        null,
        2,
      ),
      metadata: {},
    }
  })

export const validateSpec = (
  authoring: Authoring,
  specPath: string,
  requestedProfile: DagValidation.Profile | undefined,
  session: SessionContext,
  ctx: Tool.Context,
): Effect.Effect<Tool.ExecuteResult> =>
  Effect.gen(function* () {
    const loaded = yield* loadSpecFile(specPath, session.directory, session.projectID, ctx).pipe(
      Effect.map((file) => ({
        path: file.path,
        source: { kind: "yaml" as const, source: file.path, content: file.content },
      })),
      Effect.catch((error: unknown) =>
        Effect.succeed({
          path: specPath,
          loadError: error instanceof Error ? error.message : String(error),
        }),
      ),
    )
    const profile = requestedProfile ?? (DagWorkflows.isBuiltinPath(loaded.path) ? "portable" : "environment")
    const result =
      "loadError" in loaded
        ? {
            source: loaded.path,
            profile,
            valid: false,
            errors: [
              DagValidation.diagnostic({
                code: DagValidation.DIAGNOSTIC_CODES.schemaInvalid,
                path: loaded.path,
                message: loaded.loadError,
                hint: "Verify the workflow name or YAML file path",
              }),
            ],
            warnings: [],
            nodes: [],
          }
        : yield* authoring.prepare({
            action: "start",
            source: loaded.source,
            profile,
            environment: { directory: session.directory, parent: session.model },
          })
    return {
      title: `Workflow validation ${result.valid ? "passed" : "failed"}: ${loaded.path} (${profile})`,
      output: JSON.stringify(validationOutput(result), null, 2),
      metadata: result.valid ? {} : blockedMetadata(result.errors),
    }
  })

export const draftSpec = (
  authoring: Authoring,
  config: DraftGraphType,
  title: string | undefined,
  session: SessionContext,
  ctx: Tool.Context,
): Effect.Effect<Tool.ExecuteResult> =>
  Effect.gen(function* () {
    const written = yield* writeDraftSpec(config, title, session.projectID, session.directory, ctx).pipe(Effect.result)
    if (written._tag === "Failure")
      return {
        title: `Workflow draft not written: ${config.name}`,
        output: written.failure.message,
        hookFailure: written.failure.message,
        metadata: { blocked: true },
      }
    const specPath = written.success
    const result = yield* authoring.prepare({
      action: "start",
      source: { kind: "yaml", source: specPath, content: yield* readDraftSpec(specPath).pipe(Effect.orDie) },
      profile: "portable",
    })
    if (!result.valid) {
      return {
        title: `Workflow draft written with validation errors: ${config.name}`,
        output: [
          `spec_path: ${specPath}`,
          "The file is on disk. Edit it to fix the errors, then validate it; draft will not overwrite it. Diagnostics:",
          ...result.errors.map((d) => `- [${d.code}] ${d.path}: ${d.message}${d.hint ? ` (${d.hint})` : ""}`),
          WORKFLOW_RECOVERY.instruction,
        ].join("\n"),
        metadata: blockedMetadata(result.errors),
      }
    }
    return {
      title: `Workflow draft valid: ${config.name}`,
      output: [
        `spec_path: ${specPath}`,
        `nodes: ${result.nodes.length}`,
        "This draft is a start document only — an extend or control(replan) mutation needs its own file envelope (extend: top-level { objective, blocks } or { nodes }; replan: fragment).",
        'Next: workflow({params:{action:"run",operation:"start",spec_path}}) — or edit the file first for low-level fields, then start.',
      ].join("\n"),
      metadata: {},
    }
  })
