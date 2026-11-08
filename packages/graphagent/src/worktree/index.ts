import { createHash } from "node:crypto"
import { rmdir } from "node:fs/promises"
import { LayerNode } from "@graphagent/core/effect/layer-node"
import { path } from "@graphagent/core/effect/layer-node-platform"
import { KeyedMutex } from "@graphagent/core/effect/keyed-mutex"
import { Global } from "@graphagent/core/global"
import { InstanceLayer } from "@/project/instance-layer"
import { InstanceStore } from "@/project/instance-store"
import { Project } from "@/project/project"
import { Database } from "@graphagent/core/database/database"
import { eq } from "drizzle-orm"
import { ProjectTable } from "@graphagent/core/project/sql"
import type { ProjectV2 } from "@graphagent/core/project"
import { Slug } from "@graphagent/core/util/slug"
import { errorMessage } from "../util/error"
import { GlobalBus } from "@/bus/global"
import { Git } from "@/git"
import { Context, Cause, Effect, FiberMap, Layer, Path, Schema } from "effect"
import { ChildProcess } from "effect/process"
import { NodePath } from "@effect/platform-node"
import { FSUtil } from "@graphagent/core/fs-util"
import { AppProcess } from "@graphagent/core/process"
import { InstanceState } from "@/effect/instance-state"
import { WorktreeEvent } from "@graphagent/schema/worktree-event"
import { SettingsHook } from "@/hook"
import { assertProjectRootWritable } from "@/project/project-root"
import { ensureLocalExcludes } from "@/project/git-exclude"
import { MemoryPaths } from "@/memory/paths"
import { PROJECT_DIR } from "@graphagent/core/brand"
import * as Option from "effect/Option"

export const Event = WorktreeEvent

export const Info = Schema.Struct({
  name: Schema.String,
  branch: Schema.optional(Schema.String),
  directory: Schema.String,
}).annotate({ identifier: "Worktree" })
export type Info = Schema.Schema.Type<typeof Info>

export const CreateInput = Schema.Struct({
  name: Schema.optional(Schema.String),
  startCommand: Schema.optional(
    Schema.String.annotate({ description: "Additional startup script to run after the project's start command" }),
  ),
}).annotate({ identifier: "WorktreeCreateInput" })
export type CreateInput = Schema.Schema.Type<typeof CreateInput>

export const RemoveInput = Schema.Struct({
  directory: Schema.String,
}).annotate({ identifier: "WorktreeRemoveInput" })
export type RemoveInput = Schema.Schema.Type<typeof RemoveInput>

export const ResetInput = Schema.Struct({
  directory: Schema.String,
}).annotate({ identifier: "WorktreeResetInput" })
export type ResetInput = Schema.Schema.Type<typeof ResetInput>

export class NotGitError extends Schema.TaggedError<NotGitError>()("WorktreeNotGitError", {
  message: Schema.String,
}) {}

export class NameGenerationFailedError extends Schema.TaggedError<NameGenerationFailedError>()(
  "WorktreeNameGenerationFailedError",
  {
    message: Schema.String,
  },
) {}

export class CreateFailedError extends Schema.TaggedError<CreateFailedError>()("WorktreeCreateFailedError", {
  message: Schema.String,
}) {}

export class StartCommandFailedError extends Schema.TaggedError<StartCommandFailedError>()(
  "WorktreeStartCommandFailedError",
  {
    message: Schema.String,
  },
) {}

export class RemoveFailedError extends Schema.TaggedError<RemoveFailedError>()("WorktreeRemoveFailedError", {
  message: Schema.String,
}) {}

export class ResetFailedError extends Schema.TaggedError<ResetFailedError>()("WorktreeResetFailedError", {
  message: Schema.String,
}) {}

export class ListFailedError extends Schema.TaggedError<ListFailedError>()("WorktreeListFailedError", {
  message: Schema.String,
}) {}

export type Error =
  | NotGitError
  | NameGenerationFailedError
  | CreateFailedError
  | StartCommandFailedError
  | RemoveFailedError
  | ResetFailedError
  | ListFailedError

function slugify(input: string) {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
}

function failedRemoves(...chunks: string[]) {
  return chunks.filter(Boolean).flatMap((chunk) =>
    chunk
      .split("\n")
      .map((line) => line.trim())
      .flatMap((line) => {
        const match = line.match(/^warning:\s+failed to remove\s+(.+):\s+/i)
        if (!match) return []
        const value = match[1]?.trim().replace(/^['"]|['"]$/g, "")
        if (!value) return []
        return [value]
      }),
  )
}

// ---------------------------------------------------------------------------
// Effect service
// ---------------------------------------------------------------------------

export interface Interface {
  readonly makeWorktreeInfo: (options?: { name?: string; detached?: boolean }) => Effect.Effect<Info, Error>
  readonly createFromInfo: (info: Info, startCommand?: string) => Effect.Effect<void, Error>
  readonly create: (input?: CreateInput) => Effect.Effect<Info, Error>
  readonly list: () => Effect.Effect<(Omit<Info, "branch"> & { branch?: string })[], Error>
  readonly remove: (input: RemoveInput) => Effect.Effect<boolean, Error>
  readonly reset: (input: ResetInput) => Effect.Effect<boolean, Error>
}

export class Service extends Context.Service<Service, Interface>()("@graphagent/Worktree") {}

type GitResult = { code: number; text: string; stderr: string }

export const layer: Layer.Layer<
  Service,
  never,
  | FSUtil.Service
  | Path.Path
  | AppProcess.Service
  | Git.Service
  | Project.Service
  | InstanceStore.Service
  | Database.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bootFibers = yield* FiberMap.make<string, void, never>()
    const lifecycle = KeyedMutex.makeUnsafe<string>()
    const fs = yield* FSUtil.Service
    const pathSvc = yield* Path.Path
    const appProcess = yield* AppProcess.Service
    const { db } = yield* Database.Service
    const gitSvc = yield* Git.Service
    const project = yield* Project.Service
    const store = yield* InstanceStore.Service
    const settingsHook = Option.getOrUndefined(yield* Effect.serviceOption(SettingsHook.Service))

    const git = Effect.fnUntraced(
      function* (args: string[], opts?: { cwd?: string }) {
        const result = yield* appProcess.run(
          ChildProcess.make("git", args, { cwd: opts?.cwd, extendEnv: true, stdin: "ignore" }),
        )
        return {
          code: result.exitCode,
          text: result.stdout.toString("utf8"),
          stderr: result.stderr.toString("utf8"),
        } satisfies GitResult
      },
      Effect.catch((e) =>
        Effect.succeed({
          code: 1,
          text: "",
          stderr: e instanceof Error ? e.message : String(e),
        } satisfies GitResult),
      ),
    )

    const MAX_NAME_ATTEMPTS = 26
    const candidate = Effect.fn("Worktree.candidate")(function* (input: {
      root: string
      name?: string
      detached?: boolean
    }) {
      const ctx = yield* InstanceState.context
      for (const attempt of Array.from({ length: MAX_NAME_ATTEMPTS }, (_, i) => i)) {
        const name = input.name ? (attempt === 0 ? input.name : `${input.name}-${Slug.create()}`) : Slug.create()
        const branch = input.detached ? undefined : `opencode/${name}`
        const directory = pathSvc.join(input.root, name)

        if (yield* fs.exists(directory).pipe(Effect.orDie)) continue

        if (branch) {
          const ref = `refs/heads/${branch}`
          const branchCheck = yield* git(["show-ref", "--verify", "--quiet", ref], { cwd: ctx.worktree })
          if (branchCheck.code === 0) continue
        }

        return { name, directory, ...(branch ? { branch } : {}) }
      }
      return yield* new NameGenerationFailedError({ message: "Failed to generate a unique worktree name" })
    })

    const findMainCheckout = Effect.fnUntraced(function* (cwd: string) {
      const result = yield* git(["worktree", "list", "--porcelain"], { cwd })
      if (result.code !== 0) return undefined
      const primary = parseWorktreeList(result.text).find((entry) => entry.path && !entry.bare)
      return primary?.path ? yield* canonical(primary.path) : undefined
    })

    const mainCheckout = Effect.fn("Worktree.mainCheckout")(function* () {
      const ctx = yield* InstanceState.context
      // The main checkout is the first non-bare entry, not the project row's
      // recorded worktree: that row may have been created from a linked worktree.
      const found = yield* findMainCheckout(ctx.worktree)
      if (!found)
        return yield* new CreateFailedError({
          message: "Cannot create a worktree because the repository has no non-bare checkout",
        })
      return found
    })

    const makeWorktreeInfo = Effect.fn("Worktree.makeWorktreeInfo")(function* (input?: {
      name?: string
      detached?: boolean
    }) {
      const ctx = yield* InstanceState.context
      if (ctx.project.vcs !== "git") {
        return yield* new NotGitError({ message: "Worktrees are only supported for git projects" })
      }
      assertProjectRootWritable(ctx.root, Global.Path.home)

      // Worktrees live inside the main checkout's project root, flat under
      // `.agents/worktree/`, regardless of which linked worktree creates them.
      const main = yield* mainCheckout()
      const projectRoot = pathSvc.join(main, pathSvc.relative(ctx.worktree, ctx.root))
      const root = pathSvc.join(projectRoot, PROJECT_DIR, "worktree")
      yield* fs.makeDirectory(root, { recursive: true }).pipe(Effect.orDie)
      yield* Effect.promise(() => ensureLocalExcludes({ root: ctx.root, directory: ctx.worktree })).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.failCause(cause)
            : Effect.logWarning("failed to ensure worktree git excludes", { root: ctx.root, cause }),
        ),
      )

      return yield* candidate({ root, name: input?.name ? slugify(input.name) : "", detached: input?.detached })
    })

    const setup = Effect.fnUntraced(function* (info: Info) {
      const ctx = yield* InstanceState.context
      const workspaceID = yield* InstanceState.workspaceID
      const created = yield* git(
        info.branch
          ? ["worktree", "add", "--no-checkout", "-b", info.branch, info.directory]
          : ["worktree", "add", "--no-checkout", "--detach", info.directory, "HEAD"],
        { cwd: ctx.worktree },
      )
      if (created.code !== 0) {
        yield* new CreateFailedError({
          message: created.stderr || created.text || "Failed to create git worktree",
        })
      }

      yield* project.addSandbox(ctx.project.id, info.directory).pipe(Effect.catch(() => Effect.void))

      // Populate the worktree while the lifecycle lock is still held. If this
      // Git mutation lived in the interruptible bootstrap fiber, remove/reset
      // could kill it while it owned the branch ref lock and then race branch
      // cleanup against the stale lock file.
      const populated = yield* git(["reset", "--hard"], { cwd: info.directory })
      if (populated.code !== 0) {
        const message = populated.stderr || populated.text || "Failed to populate worktree"
        yield* Effect.logError("worktree checkout failed", { directory: info.directory, message })
        GlobalBus.emit("event", {
          directory: info.directory,
          project: ctx.project.id,
          workspace: workspaceID,
          payload: { type: Event.Failed.type, properties: { message } },
        })
        return false
      }
      return true
    })

    const boot = Effect.fnUntraced(function* (info: Info, startCommand?: string) {
      const ctx = yield* InstanceState.context
      const workspaceID = yield* InstanceState.workspaceID
      const projectID = ctx.project.id
      const extra = startCommand?.trim()

      const booted = yield* store.load({ directory: info.directory }).pipe(
        Effect.as(true),
        Effect.catch((error) =>
          Effect.gen(function* () {
            const message = errorMessage(error)
            yield* Effect.logError("worktree bootstrap failed", { directory: info.directory, message })
            GlobalBus.emit("event", {
              directory: info.directory,
              project: ctx.project.id,
              workspace: workspaceID,
              payload: { type: Event.Failed.type, properties: { message } },
            })
            return false
          }),
        ),
      )
      if (!booted) return

      GlobalBus.emit("event", {
        directory: info.directory,
        project: ctx.project.id,
        workspace: workspaceID,
        payload: {
          type: Event.Ready.type,
          properties: { name: info.name, ...(info.branch ? { branch: info.branch } : {}) },
        },
      })

      yield* runStartScripts(info.directory, { projectID, extra })
    })

    const createFromInfo = Effect.fn("Worktree.createFromInfo")(function* (info: Info, startCommand?: string) {
      const directory = yield* canonical(info.directory)
      yield* lifecycle.withLock(directory)(
        Effect.gen(function* () {
          if (!(yield* setup(info))) return
          yield* FiberMap.run(
            bootFibers,
            directory,
            boot(info, startCommand).pipe(
              Effect.catchCause((cause) => Effect.logError("worktree bootstrap failed", { cause })),
            ),
          )
        }),
      )
    })

    const ownershipFile = (directory: string) =>
      pathSvc.join(
        Global.Path.data,
        "hooks",
        "worktrees",
        createHash("sha256").update(directory).digest("hex") + ".json",
      )
    const hookOwned = Effect.fn("Worktree.hookOwned")(function* (directory: string, projectID: string) {
      const file = ownershipFile(directory)
      if (
        !(yield* fs
          .exists(file)
          .pipe(Effect.mapError(() => new RemoveFailedError({ message: "Cannot verify hook worktree ownership" }))))
      )
        return false
      const data = yield* fs
        .readJson(file)
        .pipe(Effect.mapError(() => new RemoveFailedError({ message: "Cannot read hook worktree ownership" })))
      if (
        !data ||
        typeof data !== "object" ||
        !("version" in data) ||
        data.version !== 1 ||
        !("projectID" in data) ||
        !("directory" in data) ||
        data.projectID !== projectID ||
        data.directory !== directory
      )
        return yield* new RemoveFailedError({
          message: "Hook worktree ownership does not match the current project identity",
        })
      return true
    })
    const validateHookDirectory = Effect.fn("Worktree.validateHookDirectory")(function* (output: string) {
      const ctx = yield* InstanceState.context
      if (pathSvc.isAbsolute(output) && output.split(/[\\/]+/).some((part) => part === "." || part === ".."))
        return yield* new CreateFailedError({
          message: "WorktreeCreate hook returned an absolute path containing dot segments",
        })
      const resolved = pathSvc.resolve(ctx.directory, output)
      const root = yield* canonical(ctx.worktree)
      const components = resolved.slice(pathSvc.parse(resolved).root.length).split(pathSvc.sep).filter(Boolean)
      let current = pathSvc.parse(resolved).root
      let inside = false
      for (const component of components) {
        current = pathSvc.join(current, component)
        if (
          inside &&
          (yield* fs.readLink(current).pipe(
            Effect.as(true),
            Effect.catch(() => Effect.succeed(false)),
          ))
        )
          return yield* new CreateFailedError({
            message: `WorktreeCreate hook path traverses a symlink below the repository: ${current}`,
          })
        if (!inside) inside = (yield* fs.realPath(current).pipe(Effect.catch(() => Effect.succeed("")))) === root
      }
      return yield* canonical(resolved)
    })
    const create = Effect.fn("Worktree.create")(function* (input?: CreateInput) {
      const configured = settingsHook && (yield* settingsHook.list()).some((hook) => hook.event === "WorktreeCreate")
      const ctx = yield* InstanceState.context
      const name = input?.name ? slugify(input.name) : Slug.create()
      const info = configured
        ? { name, directory: pathSvc.join(Global.Path.data, "worktree", ctx.project.id, name) }
        : yield* makeWorktreeInfo({ name: input?.name })
      if (configured && settingsHook) {
        // A configured creation hook owns the operation. Failure never falls back to git.
        const result = yield* settingsHook.trigger(
          { event: "WorktreeCreate", name: info.name, path: info.directory, branch: info.name },
          { sessionID: "", transcriptPath: "" },
        )
        const output = result.worktreePath?.trim()
        if (result.blocked || !output)
          return yield* new CreateFailedError({
            message: result.blocked?.reason ?? "WorktreeCreate hook must return an existing directory",
          })
        const directory = yield* validateHookDirectory(output)
        if (!(yield* fs.isDir(directory).pipe(Effect.catch(() => Effect.succeed(false)))))
          return yield* new CreateFailedError({ message: "WorktreeCreate hook returned a missing directory" })
        const ctx = yield* InstanceState.context
        const sessionDirectory = yield* canonical(ctx.directory)
        const relativeSession = pathSvc.relative(directory, sessionDirectory)
        if (
          directory === (yield* canonical(ctx.worktree)) ||
          !relativeSession ||
          (!relativeSession.startsWith("..") && !pathSvc.isAbsolute(relativeSession))
        )
          return yield* new CreateFailedError({
            message: "WorktreeCreate hook returned the current project directory or one of its ancestors",
          })
        const created = { ...info, directory }
        yield* lifecycle.withLock(directory)(
          Effect.gen(function* () {
            const marker = ownershipFile(directory)
            yield* fs
              .makeDirectory(pathSvc.dirname(marker), { recursive: true, mode: 0o700 })
              .pipe(
                Effect.mapError(() => new CreateFailedError({ message: "Failed to persist hook worktree ownership" })),
              )
            yield* fs
              .writeJson(marker, { version: 1, projectID: ctx.project.id, directory }, 0o600)
              .pipe(
                Effect.mapError(() => new CreateFailedError({ message: "Failed to persist hook worktree ownership" })),
              )
            yield* project.addSandbox(ctx.project.id, directory)
            yield* FiberMap.run(
              bootFibers,
              directory,
              boot(created, input?.startCommand).pipe(
                Effect.catchCause((cause) => Effect.logError("worktree bootstrap failed", { cause })),
              ),
            )
          }),
        )
        return created
      }
      yield* createFromInfo(info, input?.startCommand)
      return info
    })

    const canonical = Effect.fnUntraced(function* (input: string) {
      const abs = pathSvc.resolve(input)
      const real = yield* fs.realPath(abs).pipe(
        Effect.catch(() =>
          fs.realPath(pathSvc.dirname(abs)).pipe(
            Effect.map((parent) => pathSvc.join(parent, pathSvc.basename(abs))),
            Effect.catch(() => Effect.succeed(abs)),
          ),
        ),
      )
      const normalized = pathSvc.normalize(real)
      return process.platform === "win32" ? normalized.toLowerCase() : normalized
    })

    const registeredSandbox = Effect.fnUntraced(function* (sandboxes: string[], directory: string) {
      const key = yield* canonical(directory)
      return (yield* Effect.forEach(sandboxes, (sandbox) =>
        canonical(sandbox).pipe(Effect.map((candidate) => ({ candidate, sandbox }))),
      )).find((sandbox) => sandbox.candidate === key)?.sandbox
    })

    // All registrations canonically equal to `directory` — symlinked paths
    // (/var vs /private/var) can register the same worktree twice; cleanup must
    // drop every equivalent entry, not just the first match.
    const registeredSandboxes = Effect.fnUntraced(function* (sandboxes: string[], directory: string) {
      const key = yield* canonical(directory)
      const matches: string[] = []
      for (const sandbox of sandboxes) {
        if ((yield* canonical(sandbox)) === key) matches.push(sandbox)
      }
      return matches
    })

    function parseWorktreeList(text: string) {
      return text
        .split("\n")
        .map((line) => line.trim())
        .reduce<{ path?: string; branch?: string; prunable?: boolean; bare?: boolean }[]>((acc, line) => {
          if (!line) return acc
          if (line.startsWith("worktree ")) {
            acc.push({ path: line.slice("worktree ".length).trim() })
            return acc
          }
          const current = acc[acc.length - 1]
          if (!current) return acc
          if (line.startsWith("branch ")) {
            current.branch = line.slice("branch ".length).trim()
          }
          if (line.startsWith("prunable ")) current.prunable = true
          if (line === "bare") current.bare = true
          return acc
        }, [])
    }

    const locateWorktree = Effect.fnUntraced(function* (
      entries: { path?: string; branch?: string; prunable?: boolean }[],
      directory: string,
    ) {
      for (const item of entries) {
        if (!item.path) continue
        const key = yield* canonical(item.path)
        if (key === directory) return item
      }
      return undefined
    })

    const list = Effect.fn("Worktree.list")(function* () {
      const ctx = yield* InstanceState.context
      if (ctx.project.vcs !== "git") {
        return []
      }

      const result = yield* git(["worktree", "list", "--porcelain"], { cwd: ctx.worktree })
      if (result.code !== 0) {
        return yield* new ListFailedError({ message: result.stderr || result.text || "Failed to read git worktrees" })
      }

      const entries = parseWorktreeList(result.text)
      // list() is an observation path: it must never prune or deregister.
      // "prunable" does not prove a worktree is gone — git also marks merely
      // inaccessible directories (unmounted volume, locked parent) and broken
      // gitdir links whose directories still exist. Pruning there destroys git
      // admin data and live registrations. Cleanup belongs to remove/reset,
      // which can prove each case.
      const primaryEntry = entries.find((entry) => entry.path && !entry.bare)
      const primary = primaryEntry?.path ? yield* canonical(primaryEntry.path) : undefined
      const primaryName = pathSvc.basename(primary ?? ctx.project.worktree).toLowerCase()
      return yield* Effect.forEach(entries, (entry) =>
        Effect.gen(function* () {
          if (!entry.path || entry.prunable) return undefined
          const directory = yield* canonical(entry.path)
          if (directory === primary) return undefined
          const name = pathSvc.basename(directory).toLowerCase()
          return {
            name: name === primaryName ? pathSvc.basename(pathSvc.dirname(directory)) : name,
            directory,
            ...(entry.branch ? { branch: entry.branch.replace(/^refs\/heads\//, "") } : {}),
          }
        }),
      ).pipe(Effect.map((items) => items.filter((item) => item !== undefined)))
    })

    function stopFsmonitor(target: string) {
      return fs.exists(target).pipe(
        Effect.orDie,
        Effect.flatMap((exists) => (exists ? git(["fsmonitor--daemon", "stop"], { cwd: target }) : Effect.void)),
      )
    }

    function cleanDirectory(target: string) {
      return Effect.tryPromise({
        try: async () => {
          const fsp = await import("fs/promises")
          const attempts = process.platform === "win32" ? 50 : 5
          for (const attempt of Array.from({ length: attempts }, (_, i) => i)) {
            try {
              await fsp.rm(target, { recursive: true, force: true })
              return
            } catch (error) {
              if (attempt === attempts - 1) throw error
              await new Promise((resolve) => setTimeout(resolve, 100))
            }
          }
        },
        catch: (error) =>
          new RemoveFailedError({ message: errorMessage(error) || "Failed to remove git worktree directory" }),
      })
    }

    /** Remove the now-empty worktree directory and its `.agents/worktree/` parent.
     * Worktrees live under the main checkout, so resolve the same container
     * `makeWorktreeInfo` uses. A non-empty directory or one outside the
     * container is left alone, and `.agents/` itself is never removed. */
    const cleanupWorktreeParents = Effect.fnUntraced(function* (directory: string) {
      const ctx = yield* InstanceState.context
      const main = yield* findMainCheckout(ctx.worktree)
      if (!main) return
      const projectRoot = pathSvc.join(main, pathSvc.relative(ctx.worktree, ctx.root))
      const base = pathSvc.join(projectRoot, PROJECT_DIR, "worktree")
      const relative = pathSvc.relative(base, directory)
      if (
        relative === "" ||
        relative.startsWith("..") ||
        pathSvc.isAbsolute(relative) ||
        relative.includes(pathSvc.sep)
      )
        return
      yield* Effect.tryPromise(() => rmdir(directory)).pipe(Effect.ignore)
      yield* Effect.tryPromise(() => rmdir(base)).pipe(Effect.ignore)
    })

    const removeLocked = Effect.fnUntraced(function* (input: RemoveInput, directory: string) {
      const ctx = yield* InstanceState.context
      const owned = yield* hookOwned(directory, ctx.project.id)
      if (ctx.project.vcs !== "git" && !owned) {
        return yield* new NotGitError({
          message: "Worktrees are only supported for git projects without a creation hook",
        })
      }
      if (owned)
        yield* validateHookDirectory(input.directory).pipe(
          Effect.mapError((error) => new RemoveFailedError({ message: error.message })),
        )

      const primary = yield* findMainCheckout(ctx.worktree)
      if (!primary)
        return yield* new RemoveFailedError({
          message: "Cannot remove a worktree because the repository has no non-bare checkout",
        })
      const current = yield* canonical(ctx.worktree)
      const sessionDirectory = yield* canonical(ctx.directory)
      const relativeSession = pathSvc.relative(directory, sessionDirectory)
      if (
        directory === primary ||
        directory === current ||
        !relativeSession ||
        (!relativeSession.startsWith("..") && !pathSvc.isAbsolute(relativeSession))
      ) {
        return yield* new RemoveFailedError({ message: "Cannot remove the primary or current worktree" })
      }

      // Fail closed if the identity row is gone (retired by an upgrade): never
      // reconcile, prune, or drop registrations under a stale instance identity.
      const currentProject = yield* project.get(ctx.project.id)
      if (!currentProject) {
        return yield* new RemoveFailedError({
          message: "Project identity is no longer registered; reload the project before removing worktrees",
        })
      }
      const matches = yield* registeredSandboxes(currentProject.sandboxes, directory)
      if (matches.length === 0) {
        return yield* new RemoveFailedError({ message: "Worktree is not registered with this Project" })
      }
      const dropRegistrations = Effect.forEach(matches, (match) => project.removeSandbox(ctx.project.id, match), {
        concurrency: 1,
        discard: true,
      })

      const removeHook =
        owned && settingsHook && (yield* settingsHook.list()).some((hook) => hook.event === "WorktreeRemove")
      if (removeHook && settingsHook) {
        yield* FiberMap.remove(bootFibers, directory)
        const result = yield* settingsHook.trigger(
          { event: "WorktreeRemove", path: directory },
          { sessionID: "", transcriptPath: "" },
        )
        if (result.worktreeRemoveFailed && (yield* fs.exists(directory).pipe(Effect.orDie)))
          return yield* new RemoveFailedError({
            message: result.blocked?.reason ?? "WorktreeRemove hook failed while the directory still exists",
          })
        yield* store.disposeDirectory(directory)
        yield* dropRegistrations
        yield* fs.remove(ownershipFile(directory)).pipe(Effect.ignore)
        return true
      }

      if (owned && ctx.project.vcs !== "git")
        return yield* new RemoveFailedError({
          message: "Hook-created worktree needs a WorktreeRemove hook for cleanup",
        })

      const list = yield* git(["worktree", "list", "--porcelain"], { cwd: ctx.worktree })
      if (list.code !== 0) {
        return yield* new RemoveFailedError({ message: list.stderr || list.text || "Failed to read git worktrees" })
      }

      const entries = parseWorktreeList(list.text)
      const entry = yield* locateWorktree(entries, directory)
      if (!entry?.path) {
        if (owned && (yield* fs.exists(directory).pipe(Effect.orDie)))
          return yield* new RemoveFailedError({
            message: "Hook-created worktree is not recognized by git; configure WorktreeRemove to clean it up",
          })
        // Registered, but git has no record of the worktree (admin data lost or
        // the git side was already removed). Recover deterministically instead
        // of failing with a false "not registered"; the stale registration is
        // dropped. The directory itself is never deleted here.
        yield* FiberMap.remove(bootFibers, directory)

        yield* store.disposeDirectory(directory)
        yield* dropRegistrations
        if (owned) yield* fs.remove(ownershipFile(directory)).pipe(Effect.ignore)
        return true
      }

      // The WorktreeRemove hook may run user scripts; fire it before this
      // process stops supervising the directory.
      yield* FiberMap.remove(bootFibers, directory)

      if (entry.prunable) {
        // git already considers this worktree gone (directory deleted, or a
        // broken gitdir link). The destructive cleanup belongs on this action
        // path — never on list(): prune the admin data, remove the directory if
        // it still exists, then drop the registration(s).
        yield* store.disposeDirectory(entry.path)
        // `git worktree prune` is repo-global: it would also destroy the admin
        // data of any OTHER merely-prunable worktree (e.g. an unmounted volume
        // or locked parent — prunable does not mean gone). Only prune when this
        // entry is the sole prunable one; otherwise leave the stale admin data
        // for an explicit later cleanup.
        if (entries.every((item) => !item.prunable || item === entry)) {
          yield* git(["worktree", "prune"], { cwd: ctx.worktree })
        }
        if (yield* fs.existsSafe(entry.path)) yield* cleanDirectory(entry.path)
        const prunedBranch = entry.branch?.replace(/^refs\/heads\//, "")
        if (prunedBranch) {
          const deleted = yield* git(["branch", "-D", prunedBranch], { cwd: ctx.worktree })
          if (deleted.code !== 0) {
            const restored = yield* git(["worktree", "add", entry.path, prunedBranch], { cwd: ctx.worktree })
            if (restored.code !== 0) yield* dropRegistrations
            const recovery =
              restored.code === 0
                ? "the worktree registration was restored"
                : `the worktree could not be restored and its Project registration was removed: ${restored.stderr || restored.text}`
            return yield* new RemoveFailedError({
              message: `Failed to delete worktree branch: ${deleted.stderr || deleted.text}; ${recovery}`,
            })
          }
        }
        yield* dropRegistrations
        yield* cleanupWorktreeParents(directory)
        return true
      }

      // Git may return the original casing when a caller supplied a normalized Windows path.
      yield* store.disposeDirectory(entry.path)
      yield* stopFsmonitor(entry.path)
      const removed = yield* git(["worktree", "remove", "--force", entry.path], { cwd: ctx.worktree })
      if (removed.code !== 0) {
        const next = yield* git(["worktree", "list", "--porcelain"], { cwd: ctx.worktree })
        if (next.code !== 0) {
          return yield* new RemoveFailedError({
            message: removed.stderr || removed.text || next.stderr || next.text || "Failed to remove git worktree",
          })
        }

        const stale = yield* locateWorktree(parseWorktreeList(next.text), directory)
        if (stale?.path) {
          return yield* new RemoveFailedError({
            message: removed.stderr || removed.text || "Failed to remove git worktree",
          })
        }
      }

      yield* cleanDirectory(entry.path)

      const branch = entry.branch?.replace(/^refs\/heads\//, "")
      if (branch && !owned) {
        const deleted = yield* git(["branch", "-D", branch], { cwd: ctx.worktree })
        if (deleted.code !== 0) {
          const restored = yield* git(["worktree", "add", entry.path, branch], { cwd: ctx.worktree })
          if (restored.code !== 0) yield* dropRegistrations
          const recovery =
            restored.code === 0
              ? "the worktree registration was restored"
              : `the worktree could not be restored and its Project registration was removed: ${restored.stderr || restored.text}`
          return yield* new RemoveFailedError({
            message: `Failed to delete worktree branch: ${deleted.stderr || deleted.text}; ${recovery}`,
          })
        }
      }

      yield* dropRegistrations
      if (owned) yield* fs.remove(ownershipFile(directory)).pipe(Effect.ignore)
      if (!owned) yield* cleanupWorktreeParents(directory)
      return true
    })

    const remove = Effect.fn("Worktree.remove")(function* (input: RemoveInput) {
      const directory = yield* canonical(input.directory)
      return yield* lifecycle.withLock(directory)(removeLocked(input, directory))
    })

    const gitExpect = Effect.fnUntraced(function* (
      args: string[],
      opts: { cwd: string },
      error: (r: GitResult) => Error,
    ) {
      const result = yield* git(args, opts)
      if (result.code !== 0) return yield* error(result)
      return result
    })

    const runStartCommand = Effect.fnUntraced(
      function* (directory: string, cmd: string) {
        const [shell, args] = process.platform === "win32" ? ["cmd", ["/c", cmd]] : ["bash", ["-lc", cmd]]
        const result = yield* appProcess.run(
          ChildProcess.make(shell, args, { cwd: directory, extendEnv: true, stdin: "ignore" }),
        )
        return { code: result.exitCode, stderr: result.stderr.toString("utf8") }
      },
      Effect.catch(() => Effect.succeed({ code: 1, stderr: "" })),
    )

    const runStartScript = Effect.fnUntraced(function* (directory: string, cmd: string, kind: string) {
      const text = cmd.trim()
      if (!text) return true
      const result = yield* runStartCommand(directory, text)
      if (result.code === 0) return true
      yield* Effect.logError("worktree start command failed", { kind, directory, message: result.stderr })
      return false
    })

    const runStartScripts = Effect.fnUntraced(function* (
      directory: string,
      input: { projectID: ProjectV2.ID; extra?: string },
    ) {
      const row = yield* db
        .select()
        .from(ProjectTable)
        .where(eq(ProjectTable.id, input.projectID))
        .get()
        .pipe(Effect.orDie)
      const project = row ? Project.fromRow(row) : undefined
      const startup = project?.commands?.start?.trim() ?? ""
      const ok = yield* runStartScript(directory, startup, "project")
      if (!ok) return false
      yield* runStartScript(directory, input.extra ?? "", "worktree")
      return true
    })

    const prune = Effect.fnUntraced(function* (root: string, entries: string[]) {
      const base = yield* canonical(root)
      yield* Effect.forEach(
        entries,
        (entry) =>
          Effect.gen(function* () {
            const target = yield* canonical(pathSvc.resolve(root, entry))
            if (target === base) return
            if (!target.startsWith(`${base}${pathSvc.sep}`)) return
            yield* fs.remove(target, { recursive: true }).pipe(Effect.ignore)
          }),
        { concurrency: "unbounded" },
      )
    })

    const sweep = Effect.fnUntraced(function* (root: string, preserved: string[] = []) {
      const args = [
        "clean",
        "-ffdx",
        ...MemoryPaths.LOCAL_PATHS.flatMap((relative) => ["-e", relative]),
        ...preserved.flatMap((relative) => ["-e", relative]),
      ]
      const first = yield* git(args, { cwd: root })
      if (first.code === 0) return first

      const entries = failedRemoves(first.stderr, first.text)
      if (!entries.length) return first

      yield* prune(root, entries)
      return yield* git(args, { cwd: root })
    })

    const resetLocked = Effect.fnUntraced(function* (input: ResetInput, directory: string) {
      const ctx = yield* InstanceState.context
      if (ctx.project.vcs !== "git") {
        return yield* new NotGitError({ message: "Worktrees are only supported for git projects" })
      }

      const primary = yield* findMainCheckout(ctx.worktree)
      if (!primary)
        return yield* new ResetFailedError({
          message: "Cannot reset a worktree because the repository has no non-bare checkout",
        })
      const current = yield* canonical(ctx.worktree)
      const sessionDirectory = yield* canonical(ctx.directory)
      const relativeSession = pathSvc.relative(directory, sessionDirectory)
      if (
        directory === primary ||
        directory === current ||
        !relativeSession ||
        (!relativeSession.startsWith("..") && !pathSvc.isAbsolute(relativeSession))
      ) {
        return yield* new ResetFailedError({ message: "Cannot reset the primary or current worktree" })
      }

      // Fail closed if the identity row is gone (retired by an upgrade): never
      // reconcile or mutate under a stale instance identity.
      const currentProject = yield* project.get(ctx.project.id)
      if (!currentProject) {
        return yield* new ResetFailedError({
          message: "Project identity is no longer registered; reload the project before resetting worktrees",
        })
      }
      if (!(yield* registeredSandbox(currentProject.sandboxes, directory))) {
        return yield* new ResetFailedError({ message: "Worktree is not registered with this Project" })
      }
      yield* FiberMap.remove(bootFibers, directory)

      const list = yield* git(["worktree", "list", "--porcelain"], { cwd: ctx.worktree })
      if (list.code !== 0) {
        return yield* new ResetFailedError({ message: list.stderr || list.text || "Failed to read git worktrees" })
      }

      const entry = yield* locateWorktree(parseWorktreeList(list.text), directory)
      if (!entry?.path) {
        return yield* new ResetFailedError({ message: "Worktree not found" })
      }

      const worktreePath = entry.path

      const base = yield* gitSvc.defaultBranch(ctx.worktree)
      if (!base) {
        return yield* new ResetFailedError({ message: "Default branch not found" })
      }

      const sep = base.ref.indexOf("/")
      if (base.ref !== base.name && sep > 0) {
        const remote = base.ref.slice(0, sep)
        const branch = base.ref.slice(sep + 1)
        yield* gitExpect(
          ["fetch", remote, branch],
          { cwd: ctx.worktree },
          (r) => new ResetFailedError({ message: r.stderr || r.text || `Failed to fetch ${base.ref}` }),
        )
      }

      yield* gitExpect(
        ["reset", "--hard", base.ref],
        { cwd: worktreePath },
        (r) => new ResetFailedError({ message: r.stderr || r.text || "Failed to reset worktree to target" }),
      )

      const projectPrefix = pathSvc.relative(ctx.worktree, ctx.root)
      const cleanResult = yield* sweep(worktreePath, [
        `${pathSvc.join(projectPrefix, PROJECT_DIR)}${pathSvc.sep}`,
        `${pathSvc.join(projectPrefix, PROJECT_DIR, "worktree")}${pathSvc.sep}`,
      ])
      if (cleanResult.code !== 0) {
        return yield* new ResetFailedError({
          message: cleanResult.stderr || cleanResult.text || "Failed to clean worktree",
        })
      }

      yield* gitExpect(
        ["submodule", "update", "--init", "--recursive", "--force"],
        { cwd: worktreePath },
        (r) => new ResetFailedError({ message: r.stderr || r.text || "Failed to update submodules" }),
      )

      yield* gitExpect(
        ["submodule", "foreach", "--recursive", "git", "reset", "--hard"],
        { cwd: worktreePath },
        (r) => new ResetFailedError({ message: r.stderr || r.text || "Failed to reset submodules" }),
      )

      yield* gitExpect(
        ["submodule", "foreach", "--recursive", "git", "clean", "-fdx"],
        { cwd: worktreePath },
        (r) => new ResetFailedError({ message: r.stderr || r.text || "Failed to clean submodules" }),
      )

      // `.agents/` is the project layer and is preserved by the sweep above;
      // its untracked files must not make the reset look dirty. Tracked
      // modifications under it still surface below.
      const agentsPath = pathSvc.join(projectPrefix, PROJECT_DIR).split(pathSvc.sep).join("/")
      const status = yield* git(["-c", "core.fsmonitor=false", "status", "--porcelain=v1", "--untracked-files=all"], {
        cwd: worktreePath,
      })
      if (status.code !== 0) {
        return yield* new ResetFailedError({ message: status.stderr || status.text || "Failed to read git status" })
      }

      const dirty = status.text
        .split("\n")
        .filter(Boolean)
        .filter(
          (line) =>
            !line.startsWith("?? ") || (line.slice(3) !== agentsPath && !line.slice(3).startsWith(`${agentsPath}/`)),
        )
      if (dirty.length > 0) {
        return yield* new ResetFailedError({ message: `Worktree reset left local changes:\n${dirty.join("\n")}` })
      }

      yield* FiberMap.run(
        bootFibers,
        directory,
        runStartScripts(worktreePath, { projectID: ctx.project.id }).pipe(
          Effect.catchCause((cause) => Effect.logError("worktree start task failed", { cause })),
        ),
      )

      return true
    })

    const reset = Effect.fn("Worktree.reset")(function* (input: ResetInput) {
      const directory = yield* canonical(input.directory)
      return yield* lifecycle.withLock(directory)(resetLocked(input, directory))
    })

    return Service.of({ makeWorktreeInfo, createFromInfo, create, list, remove, reset })
  }),
)

export const appLayer = layer.pipe(
  Layer.provide(Git.defaultLayer),
  Layer.provide(AppProcess.defaultLayer),
  Layer.provide(Project.defaultLayer),
  Layer.provide(Database.defaultLayer),
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(NodePath.layer),
)

export const defaultLayer = appLayer.pipe(Layer.provide(InstanceLayer.layer))

export const node = LayerNode.make(layer, [
  FSUtil.node,
  path,
  AppProcess.node,
  Git.node,
  Project.node,
  InstanceStore.node,
  Database.node,
  SettingsHook.node,
])

export * as Worktree from "."
