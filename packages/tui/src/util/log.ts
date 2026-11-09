// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { Global } from "@graphagent/core/global"
import { APP_NAME } from "@graphagent/core/brand"
import fs from "fs/promises"
import path from "path"
import { formatWithOptions } from "util"

type ConsoleMethod = "log" | "warn" | "error"

const levelName = {
  log: "INFO",
  warn: "WARN",
  error: "ERROR",
} satisfies Record<ConsoleMethod, string>

const original = {
  log: console.log,
  warn: console.warn,
  error: console.error,
}

let installed = false

export function logFilePath() {
  return path.join(Global.Path.log, `${APP_NAME}.log`)
}

export function write(level: ConsoleMethod, ...args: unknown[]) {
  void fs
    .appendFile(
      logFilePath(),
      `${new Date().toISOString()} level=${levelName[level]} component=tui ${args.length ? formatWithOptions({ colors: false, depth: 8 }, ...args) : ""}\n`,
    )
    .catch(() => {})
}

export function installConsoleRedirect() {
  if (installed) return () => {}
  installed = true
  console.log = (...args) => write("log", ...args)
  console.warn = (...args) => write("warn", ...args)
  console.error = (...args) => write("error", ...args)
  return () => {
    console.log = original.log
    console.warn = original.warn
    console.error = original.error
    installed = false
  }
}

export * as TuiLog from "./log"
