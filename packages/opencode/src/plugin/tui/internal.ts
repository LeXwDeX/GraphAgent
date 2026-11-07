import { createBuiltinPlugins, type BuiltinTuiPlugin } from "@opencode-ai/tui/builtins"

export type InternalTuiPlugin = BuiltinTuiPlugin

export function internalTuiPlugins(): InternalTuiPlugin[] {
  return createBuiltinPlugins()
}
