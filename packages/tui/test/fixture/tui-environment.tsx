/** @jsxImportSource @opentui/solid */
import {
  TuiPathsProvider,
  TuiStartupProvider,
  TuiTerminalEnvironmentProvider,
  type TuiPaths,
} from "../../src/context/runtime"
import type { ParentProps } from "solid-js"
import { CommandRegistryProvider } from "../../src/commands/context"

export function TestTuiContexts(
  props: ParentProps<{
    cwd?: string
    directory?: string
    paths?: Partial<TuiPaths>
  }>,
) {
  return (
    <CommandRegistryProvider>
      <TuiPathsProvider
        value={{
          cwd: props.cwd ?? props.directory ?? "/tmp/opencode/packages/tui",
          home: "/tmp/opencode/home",
          state: "/tmp/opencode/state",
          worktree: "/tmp/opencode",
          ...props.paths,
        }}
      >
        <TuiTerminalEnvironmentProvider value={{ platform: "linux" }}>
          <TuiStartupProvider value={{ skipInitialLoading: false }}>{props.children}</TuiStartupProvider>
        </TuiTerminalEnvironmentProvider>
      </TuiPathsProvider>
    </CommandRegistryProvider>
  )
}
