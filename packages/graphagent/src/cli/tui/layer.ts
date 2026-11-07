import { run as runTui, type TuiInput } from "@graphagent/tui"
import { Global } from "@graphagent/core/global"
import { Effect } from "effect"

export function run(input: TuiInput) {
  return runTui(input).pipe(Effect.provide(Global.defaultLayer))
}
