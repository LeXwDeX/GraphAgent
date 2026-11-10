// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared shapes for the project-trust entry layer (T1 PR1).
 *
 * Everything in this module is data only. Enumeration, normalization,
 * fingerprinting, location identity and risk assessment are separate pure
 * functions; `trust.json`, the service and the load-point gates arrive in the
 * later PRs of the trust work.
 */

/** Categories of project-layer entries that can execute code or send data away. */
export const TRUST_CATEGORIES = [
  "hook",
  "mcp",
  "skill-hook",
  "agent-hook",
  "command-shell",
  "formatter",
  "lsp",
] as const
export type TrustCategory = (typeof TRUST_CATEGORIES)[number]

/** Hook handler kinds. Every kind can execute or transmit something when triggered. */
export type HookKind = "command" | "mcp_tool" | "http" | "prompt" | "agent"

/** A JSON value after key-order normalization. */
export type CanonicalValue = null | boolean | number | string | CanonicalValue[] | { [key: string]: CanonicalValue }

/** An object with canonical (sorted, comment-free) values. */
export type CanonicalObject = { [key: string]: CanonicalValue }

/** Where an entry was declared. */
export interface TrustSource {
  /** Path relative to the project layer directory (`<root>/.agents`), POSIX separators. */
  file: string
  /** 1-based line of the entry in its source file, when the format exposes one. */
  line?: number
}

/**
 * What the entry would run or contact, in display and risk-scanning form.
 * `text` is the full command/URL shown to the user; the panel truncates, not
 * this value.
 */
export interface EntryDisplay {
  text: string
  /** Command strings to scan with the heuristic risk rules. */
  commands: string[]
  /** URLs the entry sends data to or connects with. */
  urls: string[]
  /** Environment variable names the entry can read (values are never included). */
  envKeys: string[]
}

/** One enumerated project-layer entry. */
export interface TrustEntry {
  /** Stable location identity: `<file>|<category>|<label>|<matcher>|<index>`. */
  id: string
  category: TrustCategory
  /** Human label used by the location id: event, server name, agent or template name. */
  label: string
  /** Hook matcher inherited from the enclosing hook group, when declared. */
  matcher?: string
  /** 1-based occurrence among equal (file, category, label, matcher). */
  index: number
  source: TrustSource
  /**
   * Execution-relevant canonical fields. The per-category field list lives in
   * `normalize.ts`; keys are sorted only when serialized by `canonicalJSON`.
   */
  canonical: CanonicalObject
  /** Command tokens that may name files inside the project; hashed by `fingerprint.ts`. */
  references: string[]
  /** Directory relative reference tokens resolve from; the project root when absent. */
  cwd?: string
  display: EntryDisplay
  /** Handler kind for the hook-derived categories. */
  kind?: HookKind
  /** Transport for `mcp` entries. */
  mcpType?: "local" | "remote"
}
