import { createHash } from "node:crypto"
import { HookTranscript } from "@/hook/transcript"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/layer-node-platform"
import path from "path"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect, Layer, Context, Option, Scope } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { Config } from "@/config/config"
import { SettingsHook } from "@/hook/settings"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Flag } from "@opencode-ai/core/flag/flag"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { withTransientReadRetry } from "@/util/effect-http-client"
import { Global } from "@opencode-ai/core/global"
import type { MessageID } from "./schema"

function extract(messages: SessionV1.WithParts[]) {
  const paths = new Set<string>()
  for (const msg of messages) {
    for (const part of msg.parts) {
      if (part.type === "tool" && part.tool === "read" && part.state.status === "completed") {
        if (part.state.time.compacted) continue
        const loaded = part.state.metadata?.loaded
        if (!loaded || !Array.isArray(loaded)) continue
        for (const p of loaded) {
          if (typeof p === "string") paths.add(p)
        }
      }
    }
  }
  return paths
}

export interface Interface {
  readonly clear: (messageID: MessageID) => Effect.Effect<void>
  /** A committed compaction: the next system prompt reloads instruction files and announces them as "compact". */
  readonly markCompacted: (sessionID: string) => Effect.Effect<void>
  readonly systemPaths: () => Effect.Effect<Set<string>, FSUtil.Error>
  readonly system: (input?: { sessionID: string; transcriptPath?: string }) => Effect.Effect<string[], FSUtil.Error>
  readonly find: (dir: string) => Effect.Effect<string | undefined, FSUtil.Error>
  readonly resolve: (
    messages: SessionV1.WithParts[],
    filepath: string,
    messageID: MessageID,
  ) => Effect.Effect<{ filepath: string; content: string }[], FSUtil.Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Instruction") {}

export const layer: Layer.Layer<
  Service,
  never,
  FSUtil.Service | Config.Service | Global.Service | HttpClient.HttpClient | RuntimeFlags.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const cfg = yield* Config.Service
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const flags = yield* RuntimeFlags.Service
    const settingsHook = Option.getOrUndefined(yield* Effect.serviceOption(SettingsHook.Service))
    const http = HttpClient.filterStatusOk(withTransientReadRetry(yield* HttpClient.HttpClient))
    const globalFiles = [
      path.join(global.config, "AGENTS.md"),
      ...(!flags.disableClaudeCodePrompt ? [path.join(global.home, ".claude", "CLAUDE.md")] : []),
    ]
    const instructionFiles = [
      "AGENTS.md",
      ...(!flags.disableClaudeCodePrompt ? ["CLAUDE.md"] : []),
      "CONTEXT.md", // deprecated
    ]

    const state = yield* InstanceState.make(
      Effect.fn("Instruction.state")(function* () {
        // InstructionsLoaded is background observation; it lives and dies with this directory instance.
        const scope = yield* Scope.Scope
        return {
          // Track which instruction files have already been attached for a given assistant message.
          claims: new Map<MessageID, Set<string>>(),
          // Instruction files already announced via the InstructionsLoaded hook (once per instance).
          announced: new Set<string>(),
          compactions: 0,
          compacted: new Set<string>(),
          scope,
        }
      }),
    )

    const userRoots = [global.config, path.join(global.home, ".claude")].map((item) => path.resolve(item))
    // User scope: the global instruction files and anything under the user's config or ~/.claude. Everything
    // else, including nested and config-listed project files, is project scope. Managed/Local are never guessed.
    const memoryType = (file: string): "User" | "Project" => {
      const target = path.resolve(file)
      return userRoots.some((root) => {
        const relative = path.relative(root, target)
        return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
      })
        ? "User"
        : "Project"
    }

    const relative = Effect.fnUntraced(function* (instruction: string) {
      const ctx = yield* InstanceState.context
      if (!Flag.OPENCODE_DISABLE_PROJECT_CONFIG) {
        return yield* fs
          .globUp(instruction, ctx.directory, ctx.worktree)
          .pipe(Effect.catch(() => Effect.succeed([] as string[])))
      }
      return yield* fs
        .globUp(instruction, global.config, global.config)
        .pipe(Effect.catch(() => Effect.succeed([] as string[])))
    })

    const read = Effect.fnUntraced(function* (filepath: string) {
      return yield* fs.readFileString(filepath).pipe(Effect.catch(() => Effect.succeed("")))
    })

    const fetch = Effect.fnUntraced(function* (url: string) {
      const res = yield* http.execute(HttpClientRequest.get(url)).pipe(
        Effect.timeout(5000),
        Effect.catch(() => Effect.succeed(null)),
      )
      if (!res) return ""
      const body = yield* res.arrayBuffer.pipe(Effect.catch(() => Effect.succeed(new ArrayBuffer(0))))
      return new TextDecoder().decode(body)
    })

    const markCompacted = Effect.fn("Instruction.markCompacted")(function* (sessionID: string) {
      ;(yield* InstanceState.get(state)).compacted.add(sessionID)
    })

    const clear = Effect.fn("Instruction.clear")(function* (messageID: MessageID) {
      const s = yield* InstanceState.get(state)
      s.claims.delete(messageID)
    })

    const systemPaths = Effect.fn("Instruction.systemPaths")(function* () {
      const config = yield* cfg.get()
      const ctx = yield* InstanceState.context
      const paths = new Set<string>()

      for (const file of globalFiles) {
        if (yield* fs.existsSafe(file)) {
          paths.add(path.resolve(file))
          break
        }
      }

      // The first project-level match wins so we don't stack AGENTS.md/CLAUDE.md from every ancestor.
      if (!Flag.OPENCODE_DISABLE_PROJECT_CONFIG) {
        for (const file of instructionFiles) {
          const matches = yield* fs
            .findUp(file, ctx.directory, ctx.worktree)
            .pipe(Effect.catch(() => Effect.succeed([])))
          if (matches.length > 0) {
            matches.forEach((item) => paths.add(path.resolve(item)))
            break
          }
        }
      }

      if (config.instructions) {
        for (const raw of config.instructions) {
          if (raw.startsWith("https://") || raw.startsWith("http://")) continue
          const instruction = raw.startsWith("~/") ? path.join(global.home, raw.slice(2)) : raw
          const matches = yield* (
            path.isAbsolute(instruction)
              ? fs.glob(path.basename(instruction), {
                  cwd: path.dirname(instruction),
                  absolute: true,
                  include: "file",
                })
              : relative(instruction)
          ).pipe(Effect.catch(() => Effect.succeed([] as string[])))
          matches.forEach((item) => paths.add(path.resolve(item)))
        }
      }

      return paths
    })

    const system = Effect.fn("Instruction.system")(function* (input?: { sessionID: string; transcriptPath?: string }) {
      const callSettings = Option.getOrUndefined(yield* Effect.serviceOption(SettingsHook.Service)) ?? settingsHook
      const config = yield* cfg.get()
      const paths = yield* systemPaths()
      const urls = (config.instructions ?? []).filter(
        (item) => item.startsWith("https://") || item.startsWith("http://"),
      )

      const files = yield* Effect.forEach(Array.from(paths), read, { concurrency: 8 })
      const remote = yield* Effect.forEach(urls, fetch, { concurrency: 4 })

      // SettingsHook: InstructionsLoaded — observation only (the official event runs in the background), so it
      // never delays the model request. Once per file/version; after a committed compaction the files actually
      // reloaded here are announced again with load_reason "compact".
      if (callSettings && input?.sessionID && input.transcriptPath) {
        const sessionID = input.sessionID
        const transcriptPath = input.transcriptPath
        const s = yield* InstanceState.get(state)
        const compact = s.compacted.delete(sessionID)
        const batch = compact ? ++s.compactions : 0
        const loaded = Array.from(paths).flatMap((item, i) => (files[i] ? [{ path: item, content: files[i] }] : []))
        const pending: typeof loaded = []
        for (const file of loaded) {
          const key = compact
            ? `${sessionID}:compact:${batch}:${file.path}`
            : `${sessionID}:${file.path}:${createHash("sha256").update(file.content).digest("hex")}`
          if (s.announced.has(key)) continue
          s.announced.add(key)
          pending.push(file)
        }
        if (pending.length)
          yield* Effect.forEach(
            pending,
            (file) =>
              Effect.gen(function* () {
                const eligible =
                  !callSettings.hasEvent || (yield* callSettings.hasEvent("InstructionsLoaded", sessionID))
                // Without a matching handler the raw trigger still runs, but no environment is materialized.
                const environment = eligible
                  ? yield* HookTranscript.environment(sessionID).pipe(Effect.orDie)
                  : undefined
                const ilResult = yield* callSettings
                  .trigger(
                    {
                      event: "InstructionsLoaded",
                      loadReason: compact ? "compact" : "session_start",
                      memoryType: memoryType(file.path),
                      path: file.path,
                      content: file.content.slice(0, 32 * 1024),
                    },
                    { sessionID, transcriptPath, ...(environment ? { environment } : {}) },
                  )
                  .pipe(Effect.catch(() => Effect.succeed({ additionalContexts: [], systemMessages: [] })))
                yield* SettingsHook.landSystemMessages(ilResult, { sessionID })
              }),
            { discard: true },
          ).pipe(
            Effect.catchDefect(() => Effect.void),
            Effect.forkIn(s.scope),
          )
      }

      return [
        ...Array.from(paths).flatMap((item, i) => (files[i] ? [`Instructions from: ${item}\n${files[i]}`] : [])),
        ...urls.flatMap((item, i) => (remote[i] ? [`Instructions from: ${item}\n${remote[i]}`] : [])),
      ]
    })

    const find = Effect.fn("Instruction.find")(function* (dir: string) {
      for (const file of instructionFiles) {
        const filepath = path.resolve(path.join(dir, file))
        if (yield* fs.existsSafe(filepath)) return filepath
      }
      return undefined
    })

    const resolve = Effect.fn("Instruction.resolve")(function* (
      messages: SessionV1.WithParts[],
      filepath: string,
      messageID: MessageID,
    ) {
      const callSettings = Option.getOrUndefined(yield* Effect.serviceOption(SettingsHook.Service)) ?? settingsHook
      const sys = yield* systemPaths()
      const already = extract(messages)
      const results: { filepath: string; content: string }[] = []
      const s = yield* InstanceState.get(state)
      const root = path.resolve(yield* InstanceState.directory)

      const target = path.resolve(filepath)
      let current = path.dirname(target)

      // Walk upward from the file being read and attach nearby instruction files once per message.
      while (current.startsWith(root) && current !== root) {
        const found = yield* find(current)
        if (!found || found === target || sys.has(found) || already.has(found)) {
          current = path.dirname(current)
          continue
        }

        let set = s.claims.get(messageID)
        if (!set) {
          set = new Set()
          s.claims.set(messageID, set)
        }
        if (set.has(found)) {
          current = path.dirname(current)
          continue
        }

        set.add(found)
        const content = yield* read(found)
        if (content) {
          results.push({ filepath: found, content: `Instructions from: ${found}\n${content}` })
          const sessionID = messages.at(-1)?.info.sessionID
          const key = `${sessionID}:${found}:${createHash("sha256").update(content).digest("hex")}`
          if (callSettings && sessionID && !s.announced.has(key)) {
            s.announced.add(key)
            // Background observation: the read tool result must not wait for the hook.
            yield* Effect.gen(function* () {
              const eligible = !callSettings.hasEvent || (yield* callSettings.hasEvent("InstructionsLoaded", sessionID))
              const transcriptPath = eligible
                ? yield* HookTranscript.materialize({ sessionID, directory: root, messages }).pipe(Effect.orDie)
                : ""
              const environment = eligible ? yield* HookTranscript.environment(sessionID).pipe(Effect.orDie) : undefined
              const result = yield* callSettings.trigger(
                {
                  event: "InstructionsLoaded",
                  loadReason: "nested_traversal",
                  memoryType: memoryType(found),
                  path: found,
                  triggerFilePath: target,
                  content: content.slice(0, 32 * 1024),
                },
                { sessionID, transcriptPath, ...(environment ? { environment } : {}) },
              )
              yield* SettingsHook.landSystemMessages(result, { sessionID })
            }).pipe(
              Effect.catchDefect(() => Effect.void),
              Effect.forkIn(s.scope),
            )
          }
        }

        current = path.dirname(current)
      }

      return results
    })

    return Service.of({ clear, markCompacted, systemPaths, system, find, resolve })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Config.defaultLayer),
  Layer.provide(Global.layer),
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(RuntimeFlags.defaultLayer),
)

export function loaded(messages: SessionV1.WithParts[]) {
  return extract(messages)
}

export const node = LayerNode.make(layer, [Config.node, FSUtil.node, Global.node, RuntimeFlags.node, httpClient])

export * as Instruction from "./instruction"
