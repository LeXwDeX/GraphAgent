import { Prompt, type PromptRef } from "../component/prompt"
import { createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { Logo } from "../component/logo"
import { useSync } from "../context/sync"
import { useArgs } from "../context/args"
import { useRouteData } from "../context/route"
import { usePromptRef } from "../context/prompt"
import { useLocal } from "../context/local"
import { useEditorContext } from "../context/editor"
import { useTerminalDimensions } from "@opentui/solid"
import { useTuiConfig } from "../config"
import { t } from "../i18n"
import { GRAPHAGENT_BASE_MODE, useBindings } from "../keymap"
import { useBottomZoneOptional } from "../shell/bottom-zone"
import { GUTTER } from "../ui/layout"
import { useToast } from "../ui/toast"

let once = false

export function Home() {
  const sync = useSync()
  const route = useRouteData("home")
  const promptRef = usePromptRef()
  const [ref, setRef] = createSignal<PromptRef | undefined>()
  const args = useArgs()
  const local = useLocal()
  const editor = useEditorContext()
  const dimensions = useTerminalDimensions()
  const tuiConfig = useTuiConfig()
  const toast = useToast()
  const bottomZone = useBottomZoneOptional()
  const promptMaxWidth = createMemo(() => {
    const configured = tuiConfig.prompt?.max_width
    if (configured === "auto") return Math.max(75, Math.floor(dimensions().width * 0.7))
    return configured ?? 75
  })
  let sent = false

  onMount(() => {
    editor.clearSelection()
  })

  // DAG mode is a per-session setting (#886 3.9). Without a session the key only
  // says where to set it and sends no request.
  useBindings(() => ({
    mode: GRAPHAGENT_BASE_MODE,
    commands: [
      {
        name: "session.dagmode.toggle",
        title: t("help.dagmode.toggle"),
        category: "Session",
        hidden: true,
        run: () => {
          toast.show({ text: t("dagmode.toggle.needSession"), level: "info", dedupeKey: "dagmode.toggle.needSession" })
        },
      },
    ],
    bindings: tuiConfig.keybinds.gather("home.dagmode", ["session.dagmode.toggle"]),
  }))

  const bind = (r: PromptRef | undefined) => {
    setRef(r)
    promptRef.set(r)
    if (once || !r) return
    if (route.prompt) {
      r.set(route.prompt)
      once = true
      return
    }
    if (!args.prompt) return
    r.set({ input: args.prompt, parts: [] })
    once = true
  }

  // Wait for sync and model store to be ready before auto-submitting --prompt
  createEffect(() => {
    const r = ref()
    if (sent) return
    if (!r) return
    if (!sync.ready || !local.model.ready) return
    if (!args.prompt) return
    if (r.current.input !== args.prompt) return
    sent = true
    r.submit()
  })

  // The input belongs to the bottom zone, below the main area and above the footer (#1032 D1); only the logo is
  // left here. The closure runs inside the zone but reads this route's draft binding.
  const offComposer = bottomZone?.setComposer({
    render: () => (
      <box
        width="100%"
        flexShrink={0}
        alignItems="center"
        paddingLeft={GUTTER}
        paddingRight={GUTTER}
        paddingTop={1}
        paddingBottom={1}
      >
        <box width="100%" maxWidth={promptMaxWidth()} flexShrink={0}>
          <Prompt ref={bind} />
        </box>
      </box>
    ),
  })
  onCleanup(() => offComposer?.())

  return (
    <box flexGrow={1} alignItems="center" paddingLeft={GUTTER} paddingRight={GUTTER}>
      <box flexGrow={1} minHeight={0} />
      <box height={4} minHeight={0} flexShrink={1} />
      <box flexShrink={0}>
        <Logo />
      </box>
      <box flexGrow={1} minHeight={0} />
    </box>
  )
}
