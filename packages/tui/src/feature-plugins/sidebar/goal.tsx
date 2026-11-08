import type { TuiPlugin, TuiPluginApi } from "@graphagent/tui/plugin-api"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo, Show } from "solid-js"
import { t, type MessageKey } from "../../i18n"

const id = "internal:sidebar-goal"

const STATUS_KEY: Record<string, MessageKey> = {
  active: "goal.status.active",
  waiting: "goal.status.waiting",
  done: "goal.status.done",
  paused: "goal.status.paused",
}

function statusLabel(status: string) {
  const key = STATUS_KEY[status]
  return key ? t(key) : status
}

function View(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const goal = createMemo(() => props.api.state.session.goal(props.session_id))

  return (
    <Show when={goal()}>
      {(g) => (
        <box>
          <text fg={theme().text}>
            <b>{t("goal.title")}</b> [{statusLabel(g().status)}]
          </text>
          <text fg={theme().textMuted}>{g().goal.length > 60 ? g().goal.slice(0, 57) + "..." : g().goal}</text>
          <text fg={theme().textMuted}>{t("goal.turns", { used: g().turnsUsed, max: g().maxTurns })}</text>
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
