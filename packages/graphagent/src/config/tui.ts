export * as TuiConfig from "./tui"

import path from "path"
import { mergeDeep } from "remeda"
import { Cause, Context, Effect, Layer } from "effect"
import { ConfigParse } from "@/config/parse"
import * as ConfigPaths from "@/config/paths"
import { resolveHostAttentionSoundPaths } from "./tui-host-attention"
import { Flag } from "@graphagent/core/flag/flag"
import { isRecord } from "@graphagent/tui/util/record"
import { Global } from "@graphagent/core/global"
import { FSUtil } from "@graphagent/core/fs-util"
import { TuiKeybind } from "@graphagent/tui/config/keybind"
import { makeRuntime } from "@graphagent/core/effect/runtime"
import { ConfigVariable } from "@/config/variable"
import { FormatError, FormatUnknownError } from "@/cli/error"
import { TuiConfig } from "@graphagent/tui/config"

export const Info = TuiConfig.Info
export type Info = TuiConfig.Info

export type Resolved = TuiConfig.Resolved

export interface Interface {
  readonly get: () => Effect.Effect<Resolved>
}

export class Service extends Context.Service<Service, Interface>()("@graphagent/TuiConfig") {}

function normalize(raw: Record<string, unknown>) {
  const data = { ...raw }
  if (!("tui" in data)) return data
  if (!isRecord(data.tui)) {
    delete data.tui
    return data
  }

  const tui = data.tui
  delete data.tui
  return {
    ...tui,
    ...data,
  }
}

function dropUnknownKeybinds(input: Record<string, unknown>) {
  if (!isRecord(input.keybinds)) return input

  const invalid = TuiKeybind.unknownKeys(input.keybinds)
  if (!invalid.length) return input

  return {
    ...input,
    keybinds: Object.fromEntries(Object.entries(input.keybinds).filter(([key]) => !invalid.includes(key))),
  }
}

const loadState = Effect.fn("TuiConfig.loadState")(function* () {
  const afs = yield* FSUtil.Service
  let appliedOrder = 0

  const load = (text: string, configFilepath: string): Effect.Effect<Info> =>
    Effect.gen(function* () {
      const expanded = yield* Effect.promise(() =>
        ConfigVariable.substitute({ text, type: "path", path: configFilepath, missing: "empty" }),
      )
      const data = ConfigParse.jsonc(expanded, configFilepath)
      if (!isRecord(data)) return {} as Info
      // Flatten a nested "tui" key so users who wrote `{ "tui": { ... } }` inside tui.json
      // (mirroring the old main-config shape) still get their settings applied.
      const normalized = dropUnknownKeybinds(normalize(data))
      const parsed = ConfigParse.schema(Info, normalized, configFilepath)
      if (!parsed.attention?.sounds) return parsed
      return {
        ...parsed,
        attention: {
          ...parsed.attention,
          sounds: resolveHostAttentionSoundPaths(path.dirname(configFilepath), parsed.attention.sounds),
        },
      }
    }).pipe(
      // catchCause (not tapErrorCause + orElseSucceed) because JSONC parsing and validation
      // can sync-throw — those become defects, which orElseSucceed wouldn't catch.
      Effect.catchCause((cause) =>
        Effect.logWarning("skipping invalid tui config", {
          path: configFilepath,
          reason: FormatError(Cause.squash(cause)) ?? FormatUnknownError(Cause.squash(cause)),
        }).pipe(Effect.as({} as Info)),
      ),
    )

  const loadFile = (filepath: string): Effect.Effect<Info> =>
    Effect.gen(function* () {
      // Silent-swallow non-NotFound read errors (perms, EISDIR, IO) → log + skip.
      // Matches how parse/schema failures in load() are handled — every
      // broken-config path degrades gracefully rather than crashing TUI startup.
      const text = yield* afs.readFileStringSafe(filepath).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("failed to read tui config", {
            path: filepath,
            reason: FormatError(Cause.squash(cause)) ?? FormatUnknownError(Cause.squash(cause)),
          }).pipe(Effect.as(undefined)),
        ),
      )
      if (!text) return {} as Info
      yield* Effect.logInfo("loading tui config", { path: filepath })
      return yield* load(text, filepath)
    })

  const mergeFile = (acc: { result: Info }, file: string) =>
    Effect.gen(function* () {
      const data = yield* loadFile(file)
      if (Object.keys(data).length) {
        appliedOrder += 1
        yield* Effect.logInfo("applying tui config", { path: file, order: appliedOrder })
      }
      acc.result = mergeDeep(acc.result, data)
    })

  const acc: { result: Info } = { result: {} }

  // 1. Global tui config (lowest precedence). TUI settings are user-level
  // only; project directories do not contribute tui.json(c).
  for (const file of ConfigPaths.fileInDirectory(Global.Path.config, "tui")) {
    yield* mergeFile(acc, file)
  }

  // 2. Explicit GRAPHAGENT_TUI_CONFIG override, if set.
  if (Flag.GRAPHAGENT_TUI_CONFIG) {
    const configFile = Flag.GRAPHAGENT_TUI_CONFIG
    yield* mergeFile(acc, configFile)
    yield* Effect.logDebug("loaded custom tui config", { path: configFile })
  }

  return TuiConfig.resolve(
    {
      ...acc.result,
    },
    {
      terminalSuspend: process.platform !== "win32",
    },
  )
})

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const data = yield* loadState()
    const get = Effect.fn("TuiConfig.get")(() => Effect.succeed(data))
    return Service.of({ get })
  }).pipe(Effect.withSpan("TuiConfig.layer")),
)

export const defaultLayer = layer.pipe(Layer.provide(FSUtil.defaultLayer))

const { runPromise } = makeRuntime(Service, defaultLayer)

export async function get() {
  return runPromise((svc) => svc.get())
}
