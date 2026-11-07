import { Effect } from "effect"
import { message } from "./assertions"
import { disposeApps } from "./backend"
import { cleanupExercisePaths } from "./environment"
import { color } from "./report"
import { bounded } from "./runner"
import { type Options } from "./types"

export async function teardown(options: Pick<Options, "heartbeat">) {
  // Main-scope twin of resetState's bounded cleanup: a dispose stalled on a
  // ref'd outbound socket must degrade into a loud warning, not hang the whole
  // composite `&&` chain (issue #472). Arming the backstop here — not at
  // startup — because the scenario run itself may legitimately take minutes.
  exitBackstop.arm()
  await bounded("disposeApps", () => disposeApps(options.heartbeat))
  options.heartbeat?.("teardown: cleanupExercisePaths")
  await bounded("cleanupExercisePaths", () => Effect.runPromise(cleanupExercisePaths))
  options.heartbeat?.("teardown: complete")
}

export const HARD_EXIT_TIMEOUT_MS = 30_000

// process.exit must not depend on the main fiber settling: even with bounded
// teardown, a ref'd socket can keep the event loop alive past settlement. The
// wall-clock backstop guarantees the process always reaches an exit.
export function createExitBackstop(exit: (code: number) => void, ms = HARD_EXIT_TIMEOUT_MS) {
  let timer: ReturnType<typeof setTimeout> | undefined
  return {
    arm() {
      timer ??= setTimeout(() => {
        console.error(`[cleanup] main scope settlement exceeded ${ms}ms — forcing exit`)
        exit(1)
      }, ms)
    },
    disarm() {
      clearTimeout(timer)
      timer = undefined
    },
  }
}

export const exitBackstop = createExitBackstop((code) => process.exit(code))

export function runMainWithHardExit(main: Promise<unknown>, exit: (code: number) => void) {
  main.then(
    () => {
      exitBackstop.disarm()
      exit(0)
    },
    (error: unknown) => {
      exitBackstop.disarm()
      console.error(`${color.red}${message(error)}${color.reset}`)
      exit(1)
    },
  )
}
