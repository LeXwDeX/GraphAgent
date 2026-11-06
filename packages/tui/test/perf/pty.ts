import { performance } from "node:perf_hooks"
import path from "node:path"
import { spawn } from "@opencode-ai/core/pty/pty.bun"

const command = process.env.TUI_PTY_COMMAND ?? "bun"
const args = (process.env.TUI_PTY_ARGS ?? "run dev").split(" ").filter(Boolean)
const expected = process.env.TUI_PTY_EXPECTED ?? ">"
const timeoutMs = Number(process.env.TUI_PTY_TIMEOUT_MS ?? 30_000)
const baselinePath = process.env.TUI_PTY_BASELINE

const started = performance.now()
let output = ""
let done!: (value: number) => void
const ready = new Promise<number>((resolve) => (done = resolve))
const proc = spawn(command, args, {
  name: "xterm-256color",
  cols: 100,
  rows: 30,
  cwd: process.cwd(),
  env: { ...process.env, OPENCODE_FAST_BOOT: "1" } as Record<string, string>,
})
const data = proc.onData((chunk) => {
  output += chunk
  if (output.includes(expected)) done(performance.now() - started)
})
const timer = setTimeout(() => done(Number.POSITIVE_INFINITY), timeoutMs)
proc.write("hello")

const elapsedMs = await ready
clearTimeout(timer)
data.dispose()
proc.kill("SIGTERM")

let baselineMs: number | undefined
if (baselinePath) {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- generated benchmark report
  const baseline = (await Bun.file(path.resolve(baselinePath)).json()) as { elapsedMs?: number }
  baselineMs = baseline.elapsedMs
}

console.log(
  JSON.stringify(
    {
      command,
      args,
      expected,
      elapsedMs: Number.isFinite(elapsedMs) ? Number(elapsedMs.toFixed(2)) : null,
      baselineMs,
      relative: baselineMs && Number.isFinite(elapsedMs) ? Number((elapsedMs / baselineMs).toFixed(3)) : null,
      nightly: true,
    },
    null,
    2,
  ),
)
