/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi } from "@graphagent/tui/plugin-api"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo, Show } from "solid-js"
import { dagStatusColor } from "../system/dag-inspector-utils"

const id = "internal:sidebar-dag"

/**
 * Compact one-line indicator next to the prompt: presence + aggregate counts
 * only. Node-level detail lives in the sidebar panel and the DAG inspector.
 */
function DagIndicator(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const dags = createMemo(() => props.api.state.session.dag(props.session_id))
  const active = createMemo(() =>
    dags().filter((d) => d.status === "running" || d.status === "paused" || d.status === "stepping"),
  )
  const attention = createMemo(() => active().filter((d) => d.status === "paused" || d.status === "stepping"))

  const label = createMemo(() => {
    const running = active().length - attention().length
    const parts = [
      ...(running > 0 ? [`${running} running`] : []),
      ...(attention().length > 0 ? [`${attention().length} paused`] : []),
    ]
    return parts.join(", ")
  })

  return (
    <Show when={active().length > 0}>
      <box flexDirection="row" gap={1}>
        <text flexShrink={0} style={{ fg: dagStatusColor(theme(), attention().length > 0 ? "paused" : "running") }}>
          •
        </text>
        <text fg={theme().text} wrapMode="none">
          DAG <span style={{ fg: theme().textMuted }}>({label()})</span>
        </text>
      </box>
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 450,
    slots: {
      session_prompt_right(_ctx, props) {
        return <DagIndicator api={api} session_id={props.session_id} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
