// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { Effect, Schema } from "effect"
import { FSUtil } from "@graphagent/core/fs-util"
import { stringify as yamlStringify } from "yaml"
import path from "node:path"
import fs from "node:fs/promises"
import { DagWorkflows } from "@/dag/workflows"
import { InstanceRef } from "@/effect/instance-ref"
import { workflowArtifactsRoot, workflowDraftsArea } from "@/dag/runtime/output-ref"
import { assertExternalDirectoryEffect } from "../external-directory"
import { Tool } from "../tool"

const id = "workflow"
export const MAX_WORKFLOW_SPEC_BYTES = 1_000_000

const DRAFT_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9-_]*$/

export class DraftWriteError extends Schema.TaggedError<DraftWriteError>()("WorkflowDraftWriteError", {
  path: Schema.String,
  detail: Schema.String,
}) {
  override get message() {
    return `Failed to write workflow draft ${this.path}: ${this.detail}`
  }
}

export interface DraftSpecInput {
  readonly name: string
}

export function writeDraftSpec(
  config: DraftSpecInput,
  title: string | undefined,
  projectID: string,
  directory: string,
  ctx: Tool.Context,
): Effect.Effect<string, DraftWriteError> {
  return Effect.gen(function* () {
    if (!DRAFT_NAME_PATTERN.test(config.name)) {
      return yield* Effect.die(
        new Tool.InvalidArgumentsError({
          tool: id,
          detail: `Workflow name must match ${DRAFT_NAME_PATTERN.source} (it becomes the spec filename): ${config.name}`,
        }),
      )
    }
    const dir = workflowDraftsArea(projectID)
    const specPath = path.join(dir, `${config.name}.yaml`)
    const content = yamlStringify({ ...(title ? { title } : {}), config })
    const instance = yield* InstanceRef
    yield* ctx.ask({
      permission: "edit",
      patterns: [path.relative(instance?.worktree ?? directory, specPath)],
      always: ["*"],
      metadata: { filepath: specPath, content },
    })
    const writeError = (error: unknown) =>
      new DraftWriteError({
        path: specPath,
        detail:
          error instanceof Error && "code" in error && error.code === "EEXIST"
            ? "The file already exists. Edit that file or choose a different workflow name; it was not overwritten."
            : String(error),
      })
    yield* Effect.acquireUseRelease(
      // Acquisition cannot be interrupted between mkdtemp creating the
      // directory and its path being registered for cleanup. Use stays
      // interruptible, including a write already in progress.
      Effect.tryPromise({
        try: async () => {
          await fs.mkdir(dir, { recursive: true })
          return fs.mkdtemp(path.join(dir, ".draft-"))
        },
        catch: writeError,
      }),
      (staging) =>
        Effect.tryPromise({
          try: async (signal) => {
            const temporary = path.join(staging, "spec.yaml")
            await fs.writeFile(temporary, content, { flag: "wx", signal })
            signal.throwIfAborted()
            // A same-filesystem hard link publishes only the complete file and
            // refuses an existing destination atomically, unlike rename-overwrite.
            await fs.link(temporary, specPath)
          },
          catch: writeError,
        }),
      (staging) =>
        Effect.tryPromise({
          try: () => fs.rm(staging, { recursive: true, force: true }),
          catch: writeError,
        }).pipe(Effect.catch((error) => Effect.logWarning("Workflow draft staging cleanup failed", { error }))),
    )
    return specPath
  })
}

export function readDraftSpec(specPath: string) {
  return Effect.tryPromise({
    try: () => Bun.file(specPath).text(),
    catch: (error) => new Error(`Failed to read draft spec ${specPath}: ${String(error)}`),
  })
}

export function loadSpecFile(specPath: string, directory: string, projectID: string, ctx: Tool.Context) {
  return Effect.gen(function* () {
    const filepath = yield* resolveSpecPath(specPath, directory, projectID, ctx)

    // Builtin templates are compiled into the binary (no backing file).
    if (DagWorkflows.isBuiltinPath(filepath)) {
      const content = DagWorkflows.builtinTemplates()[DagWorkflows.builtinName(filepath)]
      if (content === undefined) {
        return yield* Effect.fail(new Error(`Workflow spec not found: ${filepath}`))
      }
      return { path: filepath, content }
    }

    const file = Bun.file(filepath)
    if (!(yield* Effect.promise(() => file.exists()))) {
      return yield* Effect.fail(new Error(`Workflow spec not found: ${filepath}`))
    }
    if (file.size > MAX_WORKFLOW_SPEC_BYTES) {
      return yield* Effect.fail(
        new Error(`Workflow spec is too large: ${file.size} bytes exceeds ${MAX_WORKFLOW_SPEC_BYTES}`),
      )
    }
    const content = yield* Effect.tryPromise({
      try: () => file.text(),
      catch: (error) => new Error(`Failed to read workflow spec ${filepath}: ${String(error)}`),
    })
    return { path: filepath, content }
  })
}

export function loadAuthoringSource(
  specPath: string,
  directory: string,
  projectID: string,
  ctx: Tool.Context,
): Effect.Effect<{ kind: "yaml"; source: string; content: string }, Error> {
  return loadSpecFile(specPath, directory, projectID, ctx).pipe(
    Effect.map((file) => ({ kind: "yaml" as const, source: file.path, content: file.content })),
  )
}

/** Directories (and the builtin fallback, when the release ships templates) a
 * bare workflow name may resolve from — for "not found" / empty-library hints. */
export function searchedScopes(directory: string) {
  const scopes = DagWorkflows.searchPaths(directory)
  if (Object.keys(DagWorkflows.builtinTemplates()).length > 0) scopes.push("the release's builtin templates")
  return scopes.join(" and ")
}

function resolveSpecPath(specPath: string, directory: string, projectID: string, ctx: Tool.Context) {
  return Effect.gen(function* () {
    // A bare name addresses the workflow library. The synthetic
    // `builtin://name` marker list output advertises must round-trip the same
    // way: strip the scheme and resolve by name instead of letting the path
    // branch reject it with a cwd-joined extension error. Its project/global
    // scopes are curated assets the user placed under `.agents/` or the
    // config dir — the same trust level as DAG settings — so a resolved name
    // needs no external-directory prompt even when the global scope lands
    // outside the session directory. Arbitrary paths below keep the prompt.
    const name = DagWorkflows.isBuiltinPath(specPath) ? DagWorkflows.builtinName(specPath) : specPath
    if (DagWorkflows.isName(name)) {
      const entry = yield* DagWorkflows.resolve(name, directory)
      if (entry) return entry.path
      return yield* Effect.fail(savedWorkflowNotFound(name, directory))
    }
    const filepath = path.isAbsolute(specPath) ? path.normalize(specPath) : path.resolve(directory, specPath)
    if (![".yaml", ".yml"].includes(path.extname(filepath).toLowerCase())) {
      return yield* Effect.fail(new Error(`Workflow spec must be a .yaml or .yml file: ${filepath}`))
    }
    // The project's runtime artifacts (drafts, reports, `.dag-specs`) live
    // under the user data directory, outside the worktree. They are written by
    // this project's own workflows, so reading one back needs no external
    // directory prompt; any other path outside the session directory still does.
    if (!FSUtil.contains(directory, filepath) && !FSUtil.contains(workflowArtifactsRoot(projectID), filepath)) {
      yield* assertExternalDirectoryEffect(ctx, filepath, {
        bypass: Boolean(ctx.extra?.["bypassCwdCheck"]),
      })
    }
    // An arbitrary path is a file read like any other: read/validate echo the
    // parsed document and start/extend/replan consume it, so it must honor
    // `read` permission rules (same worktree-relative pattern as the read tool).
    const instance = yield* InstanceRef
    yield* ctx.ask({
      permission: "read",
      patterns: [path.relative(instance?.worktree ?? directory, filepath)],
      always: ["*"],
      metadata: {},
    })
    return filepath
  })
}

function savedWorkflowNotFound(name: string, directory: string) {
  return new Error(
    `Saved workflow not found: "${name}". Searched ${searchedScopes(directory)}. Run workflow(action: "list") to see what is available, or pass a path to a .yaml spec file.`,
  )
}

export async function entryContent(entry: DagWorkflows.Entry): Promise<string | undefined> {
  if (entry.content !== undefined) return entry.content
  return Bun.file(entry.path)
    .text()
    .catch(() => undefined)
}
