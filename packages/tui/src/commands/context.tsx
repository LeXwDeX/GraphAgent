// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { createMemo, type Accessor } from "solid-js"
import { createSimpleContext } from "../context/helper"
import { useRoute } from "../context/route"
import { useSync } from "../context/sync"
import { BUILTIN_COMMANDS } from "./catalog"
import { createCommandRegistry, type CommandRegistry, type CommandScope } from "./registry"

/** Register the v2 builtin metadata; handlers stay with the mounted views. */
export function registerBuiltinCommands(registry: CommandRegistry): () => void {
  const disposers = BUILTIN_COMMANDS.map((definition) => registry.register({ ...definition, source: "builtin" }))
  return () => {
    for (const dispose of disposers) dispose()
  }
}

function createDefaultRegistry() {
  const registry = createCommandRegistry()
  registerBuiltinCommands(registry)
  return registry
}

export const { use: useCommands, provider: CommandRegistryProvider } = createSimpleContext({
  name: "Commands",
  init: (props: { registry?: CommandRegistry }) => props.registry ?? createDefaultRegistry(),
})

/** Current view scope used to filter the registry. */
export function useCommandScope(): Accessor<CommandScope> {
  const route = useRoute()
  const sync = useSync()
  return createMemo(() => {
    const data = route.data
    if (data.type === "home") return "home"
    const sessionID = data.type === "session" ? data.sessionID : data.params.sessionID
    const session = sessionID ? sync.session.get(sessionID) : undefined
    return session?.parentID ? "subagent" : "session"
  })
}
