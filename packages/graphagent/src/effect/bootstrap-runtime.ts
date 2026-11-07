import { Layer, ManagedRuntime } from "effect"

import { LSP } from "@/lsp/lsp"
import { Format } from "@/format"
import { Vcs } from "@/project/vcs"
import { Snapshot } from "@/snapshot"
import { Config } from "@/config/config"
import { GoalLoop } from "@/goal/loop"
import * as Observability from "@opencode-ai/core/observability"
import { memoMap } from "@opencode-ai/core/effect/memo-map"

export const BootstrapLayer = Layer.mergeAll(
  Config.defaultLayer,
  Format.defaultLayer,
  LSP.defaultLayer,
  Vcs.defaultLayer,
  Snapshot.defaultLayer,
  GoalLoop.defaultLayer,
).pipe(Layer.provide(Observability.layer))

export const BootstrapRuntime = ManagedRuntime.make(
  BootstrapLayer as unknown as Parameters<typeof ManagedRuntime.make>[0],
  { memoMap },
)
