import type { TuiPlugin, TuiPluginModule } from "@graphagent/tui/plugin-api"
import HomeFooter from "./home/footer"
import HomeTips from "./home/tips"
import SidebarContext from "./sidebar/context"
import SidebarFiles from "./sidebar/files"
import SidebarFooter from "./sidebar/footer"
import SidebarGoal from "./sidebar/goal"
import SidebarLsp from "./sidebar/lsp"
import SidebarMcp from "./sidebar/mcp"
import SidebarTodo from "./sidebar/todo"
import DiffViewer from "./system/diff-viewer"
import Notifications from "./system/notifications"
import WhichKey from "./system/which-key"

export type BuiltinTuiPlugin = Omit<TuiPluginModule, "id"> & {
  id: string
  tui: TuiPlugin
  enabled?: boolean
}

export function createBuiltinPlugins(): BuiltinTuiPlugin[] {
  return [
    HomeFooter,
    HomeTips,
    SidebarContext,
    SidebarMcp,
    SidebarLsp,
    SidebarTodo,
    SidebarGoal,
    SidebarFiles,
    SidebarFooter,
    Notifications,
    WhichKey,
    DiffViewer,
  ]
}
