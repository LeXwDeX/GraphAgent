export * as InstructionContext from "./instruction-context"

import { createHash } from "node:crypto"
import { SessionHookContext } from "./session/hook-context"
import { SessionSourceHooks } from "./session/source-hooks"
import { Array, Effect, Layer, Schema, Option, Scope } from "effect"
import { isAbsolute, join, relative, sep } from "path"
import { FSUtil } from "./fs-util"
import { Flag } from "./flag/flag"
import { Global } from "./global"
import { Location } from "./location"
import { AbsolutePath } from "./schema"
import { SystemContext } from "./system-context/index"
import { SystemContextRegistry } from "./system-context/registry"

class File extends Schema.Class<File>("InstructionContext.File")({
  path: AbsolutePath,
  content: Schema.String,
}) {}

const Files = Schema.Array(File)
const key = SystemContext.Key.make("core/instructions")

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const location = yield* Location.Service
    const registry = yield* SystemContextRegistry.Service
    // InstructionsLoaded is background observation (the official event is asynchronous), so dispatch is bound to
    // this layer's scope, which the Location/registry owner releases, rather than to one context load.
    const scope = yield* Scope.Scope

    const source = (value: ReadonlyArray<File> | SystemContext.Unavailable) =>
      SystemContext.make({
        key,
        codec: Schema.toCodecJson(Files),
        load: Effect.succeed(value),
        baseline: render,
        update: (_previous, current) =>
          `These instructions replace all previously loaded ambient instructions.\n\n${render(current)}`,
        removed: () => "Previously loaded instructions no longer apply.",
      })

    const admitted = new Map<string, Map<string, string>>()

    const observe = Effect.fn("InstructionContext.observe")(function* () {
      const start = FSUtil.resolve(location.directory)
      const stop = FSUtil.resolve(location.project.directory)
      const fromProject = relative(stop, start)
      const insideProject =
        fromProject === "" || (fromProject !== ".." && !fromProject.startsWith(`..${sep}`) && !isAbsolute(fromProject))
      const discovered = new Set(
        (Flag.OPENCODE_DISABLE_PROJECT_CONFIG || !insideProject
          ? []
          : yield* fs.up({
              targets: ["AGENTS.md"],
              start,
              stop,
            })
        ).map(FSUtil.resolve),
      )
      const paths = Array.dedupe([FSUtil.resolve(join(global.config, "AGENTS.md")), ...discovered])
      const files = yield* Effect.forEach(
        paths,
        (path) =>
          fs
            .readFileStringSafe(path)
            .pipe(
              Effect.map((content) =>
                content === undefined ? undefined : new File({ path: AbsolutePath.make(path), content }),
              ),
            ),
        { concurrency: "unbounded" },
      )
      if (files.some((file, index) => file === undefined && discovered.has(paths[index])))
        return SystemContext.unavailable
      const loaded = files.filter((file): file is File => file !== undefined)
      const session = Option.getOrUndefined(yield* Effect.serviceOption(SessionHookContext.Service))
      const hooks = Option.getOrUndefined(yield* Effect.serviceOption(SessionSourceHooks.Service))
      if (session && hooks) {
        let versions = admitted.get(session.sessionID)
        if (!versions) admitted.set(session.sessionID, (versions = new Map()))
        const reason = session.loadReason ?? "session_start"
        const pending: Array<Omit<Parameters<typeof hooks.instructionsLoaded>[0], "sessionID">> = []
        for (const file of loaded) {
          const version = createHash("sha256").update(file.content).digest("hex")
          const key =
            reason + ":" + (reason === "compact" ? (session.loadBatch ?? "compact") : "initial") + ":" + file.path
          if (versions.get(key) === version) continue
          versions.set(key, version)
          pending.push({
            filePath: file.path,
            memoryType: file.path === FSUtil.resolve(join(global.config, "AGENTS.md")) ? "User" : "Project",
            loadReason: reason,
          })
        }
        if (pending.length > 0)
          yield* Effect.forEach(
            pending,
            (item) => hooks.instructionsLoaded({ sessionID: session.sessionID, ...item }).pipe(Effect.ignore),
            { discard: true },
          ).pipe(
            Effect.catchDefect(() => Effect.void),
            Effect.forkIn(scope),
          )
      }
      return loaded
    })

    yield* registry.register({
      key,
      load: observe().pipe(
        Effect.map((files) =>
          files === SystemContext.unavailable
            ? source(files)
            : files.length === 0
              ? SystemContext.empty
              : source(files),
        ),
        Effect.catch(() => Effect.succeed(source(SystemContext.unavailable))),
        Effect.catchDefect(() => Effect.succeed(source(SystemContext.unavailable))),
      ),
    })
  }),
)

function render(files: ReadonlyArray<File>) {
  return files.map((file) => `Instructions from: ${file.path}\n${file.content}`).join("\n\n")
}
