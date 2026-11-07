import type { TuiPlugin, TuiPluginApi } from "@graphagent/tui/plugin-api"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo, Show } from "solid-js"

const id = "internal:sidebar-goal"

const STATUS_LABEL: Record<string, string> = {
  active: "进行中",
  waiting: "等待中",
  done: "已达成",
  paused: "已暂停",
}

function View(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const goal = createMemo(() => props.api.state.session.goal(props.session_id))

  return (
    <Show when={goal()}>
      {(g) => (
        <box>
          <text fg={theme().text}>
            <b>目标</b> [{STATUS_LABEL[g().status] ?? g().status}]
          </text>
          <text fg={theme().textMuted}>{g().goal.length > 60 ? g().goal.slice(0, 57) + "..." : g().goal}</text>
          <text fg={theme().textMuted}>{`${g().turnsUsed}/${g().maxTurns} 轮`}</text>
        </box>
      )}
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 150,
    slots: {
      sidebar_content(_ctx, props) {
        return <View api={api} session_id={props.session_id} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
