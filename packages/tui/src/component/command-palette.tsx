import { createMemo } from "solid-js"
import { DialogSelect, type DialogSelectRef } from "../ui/dialog-select"
import { type DialogContext } from "../ui/dialog"
import { formatKeyBindings, useGraphagentKeymap } from "../keymap"
import { useTuiConfig } from "../config"
import { useCommands, useCommandScope } from "../commands/context"
import { commandCategoryTitle, commandDescription, commandTitle } from "../commands/registry"
import { paletteRows, selectPaletteCommand, suggestedCommandIds } from "../commands/palette"
import { usePromptRef } from "../context/prompt"
import { useRoute } from "../context/route"
import { useSync } from "../context/sync"
import { useConnected } from "./use-connected"
import { t } from "../i18n"

export function CommandPaletteDialog() {
  const config = useTuiConfig()
  const keymap = useGraphagentKeymap()
  const registry = useCommands()
  const commandScope = useCommandScope()
  const prompt = usePromptRef()
  const route = useRoute()
  const sync = useSync()
  const connected = useConnected()

  const entries = createMemo(() => registry.list(commandScope()))
  const bindings = createMemo(() => {
    const ids = entries().map((spec) => spec.id)
    return keymap.getCommandBindings({ visibility: "registered", commands: ids })
  })
  const suggested = createMemo(() =>
    suggestedCommandIds({
      scope: commandScope(),
      hasSessions: sync.data.session.length > 0,
      connected: connected(),
    }),
  )
  const renameTitle = createMemo(() => {
    if (route.data.type !== "session") return undefined
    return sync.session.get(route.data.sessionID)?.title
  })
  const options = createMemo(() =>
    entries().map((spec) => ({
      title: commandTitle(spec),
      description: commandDescription(spec),
      category: commandCategoryTitle(spec.category),
      footer: formatKeyBindings(bindings().get(spec.id) ?? [], config),
      value: spec.id,
      suggested: suggested().has(spec.id),
      onSelect: (dialog: DialogContext) =>
        selectPaletteCommand({ registry, spec, dialog, prompt, renameTitle: renameTitle() }),
    })),
  )

  let ref: DialogSelectRef<string>
  const list = () => {
    if (ref?.filter) return options()
    return paletteRows(options())
  }

  return <DialogSelect ref={(value) => (ref = value)} title={t("command.palette.title")} options={list()} />
}
