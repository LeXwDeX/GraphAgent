// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { fileURLToPath } from "url"
import { isRecord } from "@/util/record"

/**
 * What the lsp tool shows a model (#1450). A language server answers in LSP's own coordinates: 0-based lines and
 * characters, and `file://` URIs. `read` shows 1-based line numbers and absolute paths, so the model would pass an
 * LSP line straight to `read` and land one line off. This view converts the answer to the `read` convention.
 */

const PATH_KEYS = new Map([
  ["uri", "path"],
  ["targetUri", "targetPath"],
])

/** A position is an object holding exactly `line` and `character`, both numbers. */
function isPosition(value: Record<string, unknown>): value is { line: number; character: number } {
  return Object.keys(value).length === 2 && typeof value.line === "number" && typeof value.character === "number"
}

/** `uri` and `targetUri` hold a `file://` URI that becomes an absolute path; a value that does not convert stays as it was. */
function entryOf(key: string, value: unknown): readonly [string, unknown] {
  const renamed = PATH_KEYS.get(key)
  if (renamed === undefined || typeof value !== "string" || !value.startsWith("file://")) return [key, modelView(value)]
  try {
    return [renamed, fileURLToPath(value)]
  } catch {
    return [key, value]
  }
}

/**
 * A copy of a language server's answer in the `read` convention: positions are 1-based, `uri` and `targetUri` become
 * `path` and `targetPath` with absolute paths, everything else is copied as it is. The input is not changed.
 */
export function modelView(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => modelView(item))
  if (!isRecord(value)) return value
  if (isPosition(value)) return { line: value.line + 1, character: value.character + 1 }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => entryOf(key, item)))
}

export * as LspModelView from "./model-view"
