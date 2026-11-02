// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: AGPL-3.0-or-later

import path from "node:path"
import { Effect } from "effect"
import type { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Permission } from "@/permission"
import type { ManagedOutputFileRef } from "./output-ref"
import type { Session } from "@/session/session"
import type { Agent } from "@/agent/agent"
import { SessionID } from "@/session/schema"
import { DagLocation } from "../location"

export function artifactPermissionBase(directory: string, worktree: string, executionDirectory = directory) {
  if (DagLocation.canonicalDirectory(executionDirectory) !== DagLocation.canonicalDirectory(directory)) {
    return { worktree: executionDirectory, boundary: executionDirectory }
  }
  return { worktree, boundary: worktree === "/" ? directory : worktree }
}

function directoryGlob(directory: string) {
  return process.platform === "win32"
    ? FSUtil.normalizePathPattern(path.join(directory, "*"))
    : path.join(directory, "*").replaceAll("\\", "/")
}

/** Wildcard.match has no literal escape: a directory containing `*` or `?`
 * cannot be represented as a permission pattern without widening its scope. */
function hasPermissionWildcard(directory: string) {
  return directory.includes("*") || directory.includes("?")
}

function permissionPath(filepath: string) {
  if (process.platform !== "win32") return filepath
  // Match ReadTool's canonical paths, including 8.3 directory aliases. The
  // source file may already be deleted when granting a committed input.
  return FSUtil.normalizePath(path.join(FSUtil.normalizePath(path.dirname(filepath)), path.basename(filepath)))
}

/** Permit only verified input objects. Preserve source read restrictions when
 * copying to content.txt, and never override an explicit external deny. */
export function artifactReadPermissions(
  refs: readonly ManagedOutputFileRef[],
  worktree: string,
  ...rulesets: PermissionV1.Ruleset[]
): PermissionV1.Ruleset {
  return refs.flatMap((ref): PermissionV1.Ruleset => {
    const target = permissionPath(ref.path)
    const source = permissionPath(ref.source_path)
    const directory = path.dirname(target)
    const glob = directoryGlob(directory)
    // A wildcard in a path segment is literal for the filesystem but active in
    // Permission patterns. Fail closed instead of granting a sibling.
    const literalDirectory = !hasPermissionWildcard(directory)
    const literalTarget = !hasPermissionWildcard(target)
    const denied =
      !literalDirectory ||
      rulesets
        .flat()
        .some(
          (rule) =>
            rule.action === "deny" &&
            [target, source, glob, directoryGlob(path.dirname(source))].some(
              (candidate) => Permission.evaluate("external_directory", candidate, [rule]).action === "deny",
            ),
        )
    const sourceRead = Permission.evaluate("read", path.relative(worktree, source), ...rulesets)
    const targetRead = Permission.evaluate("read", path.relative(worktree, target), ...rulesets)
    const readAction: PermissionV1.Rule["action"] =
      !literalTarget || !literalDirectory || sourceRead.action === "deny" || targetRead.action === "deny"
        ? "deny"
        : sourceRead.action
    return [
      { permission: "external_directory", pattern: glob, action: denied ? "deny" : "allow" },
      ...(readAction !== "allow"
        ? [
            {
              permission: "read",
              pattern: path.relative(worktree, target),
              action: readAction,
            } satisfies PermissionV1.Rule,
          ]
        : []),
      { permission: "edit", pattern: path.join(path.relative(worktree, directory), "*"), action: "deny" },
    ]
  })
}

/** Runtime capture is a read too. Use the current child session restrictions,
 * in the same agent-then-session order as tool execution, before copying bytes. */
export function makeArtifactSourceAuthorizer(
  sessions: Session.Interface,
  agents: Agent.Interface,
  worktree: string,
  permissions?: Permission.Interface,
  boundary = worktree,
) {
  return (childSessionID: string, source: string, workerType?: string): Effect.Effect<void, Error> =>
    Effect.gen(function* () {
      const child = yield* sessions.get(SessionID.make(childSessionID))
      const agent = yield* agents.get(child.agent ?? workerType ?? "build")
      if (!agent) return yield* Effect.fail(new Error("DAG artifact source permission could not be resolved"))
      const rules = [agent.permission, child.permission ?? []]
      const target = permissionPath(source)
      // An approval for a wildcard-bearing path would widen to siblings when
      // persisted as an "always" rule. Refuse instead. Check the basename too:
      // the read rule keeps it and Wildcard treats it as a pattern.
      if (hasPermissionWildcard(target)) {
        return yield* Effect.fail(new Error(`DAG artifact source has a non-literal directory: ${source}`))
      }
      const requests = [
        ...(!FSUtil.contains(boundary, target)
          ? [{ permission: "external_directory", pattern: directoryGlob(path.dirname(target)) }]
          : []),
        { permission: "read", pattern: path.relative(worktree, target) },
      ]
      for (const request of requests) {
        const action = Permission.evaluate(request.permission, request.pattern, ...rules).action
        if (action === "deny")
          return yield* Effect.fail(new Error(`DAG artifact source ${request.permission} denied: ${source}`))
        if (action === "allow") continue
        if (!permissions)
          return yield* Effect.fail(new Error(`DAG artifact source requires ${request.permission} approval: ${source}`))
        yield* permissions.ask({
          sessionID: SessionID.make(childSessionID),
          permission: request.permission,
          patterns: [request.pattern],
          always: [request.pattern],
          metadata: { filepath: source, operation: "artifact_capture" },
          ruleset: Permission.merge(...rules),
        })
      }
    })
}
