import { spawn } from "./pty.bun"
import { Ghostty } from "ghostty-web"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { cliCommand, type ResolvedCliTarget, verifyCliTarget } from "./cli-process"

type Frame = {
  readonly atMs: number
  readonly screen: string
}

type Input = {
  readonly atMs: number
  readonly label: string
  readonly base64: string
}

type Waiter = {
  readonly description: string
  readonly predicate: (screen: string) => boolean
  readonly resolve: (screen: string) => void
  readonly reject: (error: Error) => void
  readonly timeout: ReturnType<typeof setTimeout>
}

export type TuiProcess = {
  readonly pid: number
  readonly screen: () => string
  readonly waitForText: (text: string, timeoutMs?: number) => Promise<string>
  readonly waitForTextAbsent: (text: string, timeoutMs?: number) => Promise<string>
  readonly clickText: (text: string) => void
  readonly write: (input: string, label: string) => void
  readonly close: (extra?: Record<string, unknown>) => Promise<void>
}

export type TuiProcessOptions = {
  readonly target: ResolvedCliTarget
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
  readonly evidenceDir: string
  readonly cols?: number
  readonly rows?: number
}

function viewportText(terminal: ReturnType<Ghostty["createTerminal"]>, cols: number, rows: number) {
  terminal.update()
  const cells = terminal.getViewport()
  const lines: string[] = []
  for (let row = 0; row < rows; row++) {
    let value = ""
    for (let col = 0; col < cols; col++) {
      const cell = cells[row * cols + col]
      value += cell?.codepoint ? String.fromCodePoint(cell.codepoint) : " "
    }
    lines.push(value.trimEnd())
  }
  return lines.join("\n")
}

export async function createTuiProcess(options: TuiProcessOptions): Promise<TuiProcess> {
  if (!path.isAbsolute(options.evidenceDir)) {
    throw new Error(`TUI evidence directory must be absolute: ${options.evidenceDir}`)
  }
  await verifyCliTarget(options.target)
  await mkdir(options.evidenceDir, { recursive: true, mode: 0o700 })

  const cols = options.cols ?? 120
  const rows = options.rows ?? 40
  const wasm = fileURLToPath(import.meta.resolve("ghostty-web/ghostty-vt.wasm"))
  const ghostty = await Ghostty.load(wasm)
  const terminal = ghostty.createTerminal(cols, rows)
  const command = cliCommand(options.target, options.args)
  const started = Date.now()
  const raw: string[] = []
  const frames: Frame[] = []
  const inputs: Input[] = []
  const waiters = new Set<Waiter>()
  let lastScreen = ""
  let closed = false
  let exit: { exitCode: number; signal?: number | string } | undefined
  let exitResolve: () => void = () => {}
  const exited = new Promise<void>((resolve) => {
    exitResolve = resolve
  })

  const proc = spawn(command.executable, [...command.args], {
    name: "xterm-256color",
    cols,
    rows,
    cwd: options.cwd,
    env: { ...process.env, ...options.env, TERM: "xterm-256color", COLORTERM: "truecolor" },
  })

  const snapshot = () => {
    const next = viewportText(terminal, cols, rows)
    if (next !== lastScreen) {
      lastScreen = next
      frames.push({ atMs: Date.now() - started, screen: next })
    }
    for (const waiter of waiters) {
      if (!waiter.predicate(next)) continue
      clearTimeout(waiter.timeout)
      waiters.delete(waiter)
      waiter.resolve(next)
    }
  }

  const data = proc.onData((chunk) => {
    raw.push(chunk)
    terminal.write(chunk)
    const response = terminal.readResponse()
    if (response) proc.write(response)
    snapshot()
  })
  const done = proc.onExit((event) => {
    exit = event
    exitResolve()
    for (const waiter of waiters) {
      clearTimeout(waiter.timeout)
      waiters.delete(waiter)
      waiter.reject(new Error(`TUI exited while waiting for ${waiter.description}: code=${event.exitCode}`))
    }
  })

  const waitFor = (description: string, predicate: (screen: string) => boolean, timeoutMs = 15_000) => {
    const current = viewportText(terminal, cols, rows)
    if (predicate(current)) return Promise.resolve(current)
    if (exit) {
      return Promise.reject(new Error(`TUI already exited while waiting for ${description}: code=${exit.exitCode}`))
    }
    return new Promise<string>((resolve, reject) => {
      const waiter: Waiter = {
        description,
        predicate,
        resolve,
        reject,
        timeout: setTimeout(() => {
          waiters.delete(waiter)
          reject(new Error(`Timed out waiting for ${description}\nCurrent screen:\n${lastScreen}`))
        }, timeoutMs),
      }
      waiters.add(waiter)
    })
  }

  const write = (input: string, label: string) => {
    inputs.push({ atMs: Date.now() - started, label, base64: Buffer.from(input).toString("base64") })
    proc.write(input)
  }

  return {
    pid: proc.pid,
    screen: () => viewportText(terminal, cols, rows),
    waitForText: (text, timeoutMs) =>
      waitFor(`text ${JSON.stringify(text)}`, (screen) => screen.includes(text), timeoutMs),
    waitForTextAbsent: (text, timeoutMs) =>
      waitFor(`text ${JSON.stringify(text)} to disappear`, (screen) => !screen.includes(text), timeoutMs),
    clickText(text) {
      const screen = viewportText(terminal, cols, rows)
      const lines = screen.split("\n")
      const row = lines.findIndex((line) => line.includes(text))
      if (row === -1) throw new Error(`Cannot click missing TUI text: ${text}\n${screen}`)
      const col = lines[row].indexOf(text)
      write(`\x1b[<0;${col + 1};${row + 1}M\x1b[<0;${col + 1};${row + 1}m`, `click:${text}`)
    },
    write,
    async close(extra = {}) {
      if (closed) return
      closed = true
      const beforeClose = viewportText(terminal, cols, rows)
      if (!exit) proc.kill()
      await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 2_000))])
      if (!exit) {
        proc.kill("SIGKILL")
        await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 2_000))])
      }
      const killError = exit ? undefined : new Error(`TUI PTY ${proc.pid} did not exit after SIGTERM and SIGKILL`)
      await writeFile(path.join(options.evidenceDir, "raw.ansi"), raw.join(""))
      await writeFile(path.join(options.evidenceDir, "frames.json"), JSON.stringify(frames, null, 2) + "\n")
      await writeFile(path.join(options.evidenceDir, "inputs.json"), JSON.stringify(inputs, null, 2) + "\n")
      await writeFile(
        path.join(options.evidenceDir, "result.json"),
        JSON.stringify(
          {
            target: options.target,
            command: { executable: command.executable, args: command.args },
            dimensions: { cols, rows },
            durationMs: Date.now() - started,
            exit,
            finalScreen: beforeClose,
            ...extra,
          },
          null,
          2,
        ) + "\n",
      )
      data.dispose()
      done.dispose()
      terminal.free()
      if (killError) throw killError
    },
  }
}
