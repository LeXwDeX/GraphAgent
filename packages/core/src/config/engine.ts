// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

export * as ConfigEngine from "./engine"

import { Cause, Exit, Schema, SchemaIssue } from "effect"
import { ConfigV1 } from "../v1/config/config"
import { InvalidError } from "../v1/config/error"

const decodeEngine = Schema.decodeUnknownExit(ConfigV1.Engine)

/**
 * Configuration decoding ignores excess properties so that files written for a
 * different version keep loading. `engine` is the one closed object: it is a
 * draft surface with few keys, and a typo would silently drop a limit. Reject
 * unknown keys there and report their full path; every other configuration
 * object keeps the ignore policy, and non-excess schema issues are left to the
 * regular decoder.
 */
export function rejectUnknownKeys(input: unknown, source: string): void {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return
  if (!Object.hasOwn(input, "engine")) return

  const engine: unknown = Reflect.get(input, "engine")
  const decoded = decodeEngine(engine, { errors: "all", onExcessProperty: "error" })
  if (Exit.isSuccess(decoded)) return
  const error = Cause.squash(decoded.cause)
  if (!Schema.isSchemaError(error)) return

  const issues = SchemaIssue.makeFormatterStandardSchemaV1()(error.issue)
    .issues.filter((issue) => issue.message === ConfigV1.ENGINE_UNEXPECTED_KEY_MESSAGE)
    .map((issue) => ({
      path: ["engine", ...(issue.path?.map(String) ?? [])],
      message: ConfigV1.ENGINE_UNEXPECTED_KEY_MESSAGE,
    }))
  if (issues.length === 0) return

  throw new InvalidError({ path: source, issues })
}
