import { createBuiltinPlugins, type BuiltinTuiPlugin } from "@graphagent/tui/builtins"

export type InternalTuiPlugin = BuiltinTuiPlugin

export function internalTuiPlugins(): InternalTuiPlugin[] {
  return createBuiltinPlugins()
}
