import { EOL } from "os"
import { Schema } from "effect"
import { LOGO_AGENT, LOGO_GAP, LOGO_GRAPH, LOGO_MINI, LOGO_MIN_COLUMNS } from "./logo"

export class CancelledError extends Schema.TaggedError<CancelledError>()("UICancelledError", {}) {}

export const Style = {
  TEXT_HIGHLIGHT: "\x1b[96m",
  TEXT_HIGHLIGHT_BOLD: "\x1b[96m\x1b[1m",
  TEXT_DIM: "\x1b[90m",
  TEXT_DIM_BOLD: "\x1b[90m\x1b[1m",
  TEXT_NORMAL: "\x1b[0m",
  TEXT_NORMAL_BOLD: "\x1b[1m",
  TEXT_WARNING: "\x1b[93m",
  TEXT_WARNING_BOLD: "\x1b[93m\x1b[1m",
  TEXT_DANGER: "\x1b[91m",
  TEXT_DANGER_BOLD: "\x1b[91m\x1b[1m",
  TEXT_SUCCESS: "\x1b[92m",
  TEXT_SUCCESS_BOLD: "\x1b[92m\x1b[1m",
  TEXT_INFO: "\x1b[94m",
  TEXT_INFO_BOLD: "\x1b[94m\x1b[1m",
}

export function println(...message: string[]) {
  print(...message)
  process.stderr.write(EOL)
}

export function print(...message: string[]) {
  blank = false
  process.stderr.write(message.join(" "))
}

let blank = false
export function empty() {
  if (blank) return
  println("" + Style.TEXT_NORMAL)
  blank = true
}

export function logo(pad?: string) {
  // The wordmark only fits a wide interactive terminal. Narrow terminals,
  // pipes and non-TTY stderr get the single-line mark instead.
  if (!process.stderr.isTTY || (process.stderr.columns ?? 0) < LOGO_MIN_COLUMNS) {
    return (pad ?? "") + LOGO_MINI
  }

  const result: string[] = []
  const reset = "\x1b[0m"
  const left = {
    fg: "\x1b[90m",
    shadow: "\x1b[38;5;235m",
  }
  const right = {
    fg: reset,
    shadow: "\x1b[38;5;238m",
  }
  const gap = " ".repeat(LOGO_GAP)
  const draw = (line: string, fg: string, shadow: string) => {
    const parts: string[] = []
    for (const char of line) {
      if (char === " ") {
        parts.push(" ")
        continue
      }
      if (char === "█") {
        parts.push(fg, char, reset)
        continue
      }
      parts.push(shadow, char, reset)
    }
    return parts.join("")
  }
  LOGO_GRAPH.forEach((row, index) => {
    if (pad) result.push(pad)
    result.push(draw(row, left.fg, left.shadow))
    result.push(gap)
    const other = LOGO_AGENT[index] ?? ""
    result.push(draw(other, right.fg, right.shadow))
    result.push(EOL)
  })
  return result.join("").trimEnd()
}

export async function input(prompt: string): Promise<string> {
  const readline = require("readline")
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  return new Promise((resolve) => {
    rl.question(prompt, (answer: string) => {
      rl.close()
      resolve(answer.trim())
    })
  })
}

export function error(message: string) {
  if (message.startsWith("Error: ")) {
    message = message.slice("Error: ".length)
  }
  println(Style.TEXT_DANGER_BOLD + "Error: " + Style.TEXT_NORMAL + message)
}

export function markdown(text: string): string {
  return text
}

export * as UI from "./ui"
