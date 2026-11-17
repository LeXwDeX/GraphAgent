// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs"
import path from "node:path"
import { parse } from "jsonc-parser"
import { xdgConfig } from "xdg-basedir"
import { CONFIG_BASENAME, APP_NAME } from "@graphagent/core/brand"
import { initLanguage } from "@graphagent/tui/i18n"

// Keep this first-import module synchronous and free of top-level await: the
// command modules evaluate their `describe` strings at import time, so the
// interface language must be settled before any of them load. It must never
// write to stdout either, because `generate` prints the OpenAPI document there.

type Environment = Record<string, string | undefined>

function languageOf(text: string | undefined): string | undefined {
  if (!text) return undefined
  const value: unknown = parse(text, [], { allowTrailingComma: true })
  if (!value || typeof value !== "object" || Array.isArray(value) || !("language" in value)) return undefined
  return typeof value.language === "string" ? value.language : undefined
}

function readFile(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8")
  } catch {
    return undefined
  }
}

/**
 * Read the configured interface language with the same source order as the
 * global config loader: the user config directory (`config.json`,
 * `graphagent.json`, `graphagent.jsonc`), extra files in a different
 * `GRAPHAGENT_CONFIG_DIR`, `GRAPHAGENT_CONFIG`, then `GRAPHAGENT_CONFIG_CONTENT`.
 * Later sources win. Managed and MDM layers are not consulted here; the TUI
 * applies the fully merged configuration once its server is up.
 */
export function configuredLanguage(env: Environment = process.env): string | undefined {
  const fallback = xdgConfig ? path.join(xdgConfig, APP_NAME) : undefined
  const directory = env.GRAPHAGENT_TEST_CONFIG_DIR ?? env.GRAPHAGENT_CONFIG_DIR ?? fallback
  const files: string[] = []
  if (directory)
    files.push(
      path.join(directory, "config.json"),
      path.join(directory, `${CONFIG_BASENAME}.json`),
      path.join(directory, `${CONFIG_BASENAME}.jsonc`),
    )
  if (env.GRAPHAGENT_CONFIG_DIR && directory && path.resolve(env.GRAPHAGENT_CONFIG_DIR) !== path.resolve(directory))
    files.push(
      path.join(env.GRAPHAGENT_CONFIG_DIR, `${CONFIG_BASENAME}.json`),
      path.join(env.GRAPHAGENT_CONFIG_DIR, `${CONFIG_BASENAME}.jsonc`),
    )
  if (env.GRAPHAGENT_CONFIG) files.push(env.GRAPHAGENT_CONFIG)

  let result: string | undefined
  for (const file of files) {
    try {
      result = languageOf(readFile(file)) ?? result
    } catch {
      // An unreadable or malformed file is reported by the real config loader.
    }
  }
  try {
    result = languageOf(env.GRAPHAGENT_CONFIG_CONTENT) ?? result
  } catch {}
  return result
}

initLanguage(configuredLanguage())
