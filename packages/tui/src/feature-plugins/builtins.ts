import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/tui/plugin-api"
import HomeFooter from "./home/footer"
import HomeTips from "./home/tips"
import SidebarContext from "./sidebar/context"
import SidebarFiles from "./sidebar/files"
import SidebarFooter from "./sidebar/footer"
import SidebarGoal from "./sidebar/goal"
import SidebarLsp from "./sidebar/lsp"
import SidebarMcp from "./sidebar/mcp"
import SidebarTodo from "./sidebar/todo"
import SidebarDag from "./sidebar/dag"
import SidebarDagPanel from "./sidebar/dag-panel"
import DiffViewer from "./system/diff-viewer"
import DagInspector from "./system/dag-inspector"
import Notifications from "./system/notifications"
import WhichKey from "./system/which-key"

export type BuiltinTuiPlugin = Omit<TuiPluginModule, "id"> & {
  id: string
  tui: TuiPlugin
  enabled?: boolean
}

export function createBuiltinPlugins(options: { experimentalEventSystem: boolean }): BuiltinTuiPlugin[] {
  return [
    HomeFooter,
    HomeTips,
    SidebarContext,
    SidebarMcp,
    SidebarLsp,
    SidebarTodo,
    SidebarGoal,
    SidebarFiles,
    SidebarDag,
    SidebarDagPanel,
    SidebarFooter,
    Notifications,
    WhichKey,
    DiffViewer,
    DagInspector,
  ]
}
