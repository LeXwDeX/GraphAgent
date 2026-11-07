import type { TuiPluginApi } from "@opencode-ai/tui/plugin-api"
import type { TuiConfig } from "../config"
import { createContext, useContext, type JSX, type ParentProps } from "solid-js"
import { createPluginRoutes } from "./api"
import { createSlots, type HostSlots } from "./slots"

export function createPluginRuntime() {
  const slots = createSlots()

  return {
    Slot: slots.Slot,
    routes: createPluginRoutes(),
    clear() {
      slots.clear()
    },
    setupSlots(api: TuiPluginApi): HostSlots {
      return slots.setup(api)
    },
  }
}

export type PluginRuntime = ReturnType<typeof createPluginRuntime>

export type TuiPluginHost = {
  start(input: {
    api: TuiPluginApi
    config: TuiConfig.Resolved
    runtime: PluginRuntime
    dispose?: () => void
  }): Promise<void>
  dispose(): Promise<void>
}

const Context = createContext<PluginRuntime>()

export function PluginRuntimeProvider(props: ParentProps<{ value: PluginRuntime }>): JSX.Element {
  return <Context.Provider value={props.value}>{props.children}</Context.Provider>
}

export function usePluginRuntime() {
  const runtime = useContext(Context)
  if (!runtime) throw new Error("usePluginRuntime must be used within PluginRuntimeProvider")
  return runtime
}
