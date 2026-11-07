import { resolve, type Info, type Resolved } from "@opencode-ai/tui/config"
import { TuiKeybind } from "@opencode-ai/tui/config/keybind"

type ResolvedInput = Omit<Info, "attention" | "keybinds" | "leader_timeout"> & {
  attention?: Partial<Resolved["attention"]>
  keybinds?: Partial<TuiKeybind.Keybinds>
  leader_timeout?: number
}

export function createTuiResolvedKeybinds(input: Partial<TuiKeybind.Keybinds> = {}): Resolved["keybinds"] {
  return resolve({ keybinds: input }, { terminalSuspend: process.platform !== "win32" }).keybinds
}

export function createTuiResolvedConfig(input: ResolvedInput = {}): Resolved {
  return resolve(input, { terminalSuspend: process.platform !== "win32" })
}
