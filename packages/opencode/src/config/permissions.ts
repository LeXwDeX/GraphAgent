import path from "node:path"
import { Effect } from "effect"
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser"
import z from "zod"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import type { PermissionUpdate } from "@/hook/trigger-result"
import { updateSessionPolicy } from "@/permission/session-policy"

const action = z.enum(["allow", "deny", "ask"])
export const documentSchema = z
  .object({
    permissions: z.array(z.object({ action: z.string(), resource: z.string(), effect: action })).optional(),
    permission: z.record(z.string(), z.union([action, z.record(z.string(), action)])).optional(),
    hookPermissions: z
      .object({
        mode: z.enum(["default", "manual", "acceptEdits", "dontAsk", "plan"]).optional(),
        directories: z.array(z.string()).optional(),
      })
      .optional(),
  })
  .passthrough()
export type PermissionDocument = z.infer<typeof documentSchema>
/** Canonical ordered rules supersede the legacy map within one document. */
export function orderedRules(document: PermissionDocument): NonNullable<PermissionDocument["permissions"]> {
  if (document.permissions !== undefined) return document.permissions
  return Object.entries(document.permission ?? {}).flatMap(([permission, value]) =>
    typeof value === "string"
      ? [{ action: permission, resource: "*", effect: value }]
      : Object.entries(value).map(([resource, effect]) => ({ action: permission, resource, effect })),
  )
}

export function localFile(directory: string) {
  return path.join(directory, ".opencode", "permissions.local.json")
}

export function validateUpdates(updates: readonly PermissionUpdate[]) {
  for (const entry of updates) {
    if (!["session", "localSettings", "projectSettings", "userSettings"].includes(entry.destination))
      throw new Error("Unsupported permission update destination")
    if (
      entry.type === "setMode" &&
      !["default", "manual", "acceptEdits", "dontAsk", "plan", "bypassPermissions"].includes(entry.mode)
    )
      throw new Error("Unavailable permission mode: a hook cannot enable classifier or bypass permissions")
  }
}

export function applyUpdates(
  before: PermissionDocument,
  updates: readonly PermissionUpdate[],
  directory: string,
): PermissionDocument {
  validateUpdates(updates)
  const rules = orderedRules(before).map((rule) => ({
    permission: rule.action,
    pattern: rule.resource,
    action: rule.effect,
  }))
  const next = updateSessionPolicy(
    { rules, mode: before.hookPermissions?.mode, directories: before.hookPermissions?.directories ?? [] },
    updates.map((entry) => ({ ...entry, destination: "session" })),
    directory,
  )
  const changesPolicy =
    before.hookPermissions !== undefined ||
    updates.some(
      (entry) => entry.type === "setMode" || entry.type === "addDirectories" || entry.type === "removeDirectories",
    )
  return {
    ...before,
    permissions: next.rules.map((rule) => ({ action: rule.permission, resource: rule.pattern, effect: rule.action })),
    ...(changesPolicy
      ? {
          hookPermissions: {
            ...(next.mode !== undefined && next.mode !== "bypassPermissions" ? { mode: next.mode } : {}),
            ...(before.hookPermissions?.directories !== undefined ||
            updates.some((entry) => entry.type === "addDirectories" || entry.type === "removeDirectories")
              ? { directories: next.directories }
              : {}),
          },
        }
      : {}),
  }
}

export const read = Effect.fn("HookPermissions.read")(function* (file: string) {
  const fs = yield* FSUtil.Service
  if (!(yield* fs.existsSafe(file))) return {} as PermissionDocument
  const text = yield* fs.readFileString(file)
  const errors: ParseError[] = []
  const parsed = parse(text, errors, { allowTrailingComma: true })
  if (errors.length) return yield* Effect.die(new Error("Invalid permission settings JSON"))
  return yield* Effect.sync(() => documentSchema.parse(parsed))
})

export const update = Effect.fn("HookPermissions.update")(function* (
  file: string,
  updates: readonly PermissionUpdate[],
  directory: string,
) {
  const fs = yield* FSUtil.Service
  const flock = yield* EffectFlock.Service
  return yield* flock.withLock(
    Effect.gen(function* () {
      const before = (yield* fs.existsSafe(file)) ? yield* fs.readFileString(file) : "{}"
      const doc = yield* read(file)
      const next = applyUpdates(doc, updates, directory)
      let text = before
      for (const key of ["permissions", "hookPermissions"] as const) {
        if (next[key] === undefined) continue
        text = applyEdits(
          text,
          modify(text, [key], next[key], { formattingOptions: { insertSpaces: true, tabSize: 2 } }),
        )
      }
      yield* fs.writeWithDirs(file, text + (text.endsWith("\n") ? "" : "\n"))
      if (file === localFile(directory)) {
        const ignore = path.join(directory, ".opencode", ".gitignore")
        const existing = (yield* fs.existsSafe(ignore)) ? yield* fs.readFileString(ignore) : ""
        if (!existing.split(/\r?\n/).includes("permissions.local.json"))
          yield* fs.writeWithDirs(
            ignore,
            existing + (existing && !existing.endsWith("\n") ? "\n" : "") + "permissions.local.json\n",
          )
      }
      return next
    }),
    file,
  )
})
export * as HookPermissions from "./permissions"
