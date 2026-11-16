// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * Template inputs (#1073): a start document may declare `inputs`, and a caller
 * fills them with `run.start { spec_path, inputs }` instead of copying and
 * rewriting the spec.
 *
 *   inputs:
 *     objective: { description: What the stage must achieve }
 *     acceptance: { type: array, default: [{ id: AC1, text: ... }] }
 *   config:
 *     objective: "Build it. Request: {{objective}}"
 *     acceptance: "{{acceptance}}"
 *
 * Substitution walks the parsed document, never its YAML text, so a value can
 * neither break the syntax nor add structure. Only placeholders that name a
 * declared input are replaced; every other `{{name}}` stays as written for the
 * runtime's own `{{node-id}}` bindings. A string that is exactly one
 * placeholder takes the input's own value, so an `array` input can fill an
 * array field; inside longer text a value is rendered as plain text and is not
 * scanned for placeholders again.
 *
 * This module is a pure step of the Workflow Authoring Check: it runs on the
 * parsed document before strict decoding, so the instantiated document meets
 * the same rules as any other start document. It reads no files and creates
 * nothing.
 */

import { isRecord } from "@/util/record"
import { DagValidation } from "./validation"

export type InputType = DagValidation.TemplateInputType

export interface Declaration {
  readonly name: string
  readonly type: InputType
  readonly description?: string
  readonly default?: unknown
  /** An input without a default must be supplied. */
  readonly required: boolean
}

/** What the caller supplies for the declared inputs. `values` is a real start
 * or validate call; `sample` stands in for the required inputs so a template can
 * be listed, read, and checked on its own. */
export type Supply =
  { readonly kind: "values"; readonly values: Readonly<Record<string, unknown>> } | { readonly kind: "sample" }

/** A value that replaced a whole field, so a decode failure under that field
 * can name the input it came from. */
export interface Origin {
  readonly path: string
  readonly input: string
}

export interface Outcome {
  /** The document with placeholders resolved and `inputs` removed, or the
   * original document when it declares no inputs. */
  readonly value: unknown
  readonly diagnostics: DagValidation.Diagnostic[]
  /** The document declared `inputs`. */
  readonly declared: boolean
  /** Declared inputs the caller supplied, in declaration order. */
  readonly supplied: string[]
  /** Declared inputs that used their default, in declaration order. */
  readonly defaulted: string[]
  readonly origins: Origin[]
}

const NAME = /^[A-Za-z][A-Za-z0-9_]*$/
const PLACEHOLDER = /{{\s*([^{}]+?)\s*}}/g
const WHOLE_PLACEHOLDER = /^\s*{{\s*([^{}]+?)\s*}}\s*$/
const DEFAULT_PREVIEW = 24

const DECLARATION_HINT =
  'Declare each input as { type?: "string" | "number" | "boolean" | "array", description?, default? }; an input without a default is required, and a name uses letters, digits, and underscores'

function describe(value: unknown): string {
  if (Array.isArray(value)) return "an array"
  if (value === null) return "null"
  return typeof value === "object" ? "an object" : `a ${typeof value}`
}

function matches(type: InputType, value: unknown): boolean {
  if (type === "string") return typeof value === "string"
  if (type === "number") return typeof value === "number" && Number.isFinite(value)
  if (type === "boolean") return typeof value === "boolean"
  return Array.isArray(value)
}

function sampleOf(type: InputType): unknown {
  if (type === "string") return "sample"
  if (type === "number") return 1
  if (type === "boolean") return false
  return []
}

/** The declarations of a parsed `inputs` value. Malformed entries are reported
 * in strict use and skipped in lenient use (listing a spec that does not parse
 * must not fail). */
function read(raw: unknown): { declarations: Declaration[]; diagnostics: DagValidation.Diagnostic[] } {
  const diagnostics: DagValidation.Diagnostic[] = []
  const invalid = (path: string, message: string) =>
    diagnostics.push(
      DagValidation.diagnostic({
        code: DagValidation.DIAGNOSTIC_CODES.templateInputs,
        path,
        message,
        hint: DECLARATION_HINT,
      }),
    )
  if (!isRecord(raw)) {
    invalid("inputs", "inputs must be a mapping of input name to declaration")
    return { declarations: [], diagnostics }
  }
  const declarations: Declaration[] = []
  for (const [name, entry] of Object.entries(raw)) {
    const path = `inputs.${name}`
    if (!NAME.test(name)) {
      invalid(path, `input name "${name}" must start with a letter and use only letters, digits, and underscores`)
      continue
    }
    const decoded = DagValidation.decodeTemplateInput(entry ?? {})
    if (decoded === undefined) {
      invalid(path, `input "${name}" is not a valid declaration`)
      continue
    }
    const type = decoded.type ?? "string"
    if (decoded.default !== undefined && !matches(type, decoded.default)) {
      invalid(path, `input "${name}" declares type ${type} but its default is ${describe(decoded.default)}`)
      continue
    }
    declarations.push({
      name,
      type,
      ...(decoded.description !== undefined ? { description: decoded.description } : {}),
      ...(decoded.default !== undefined ? { default: decoded.default } : {}),
      required: decoded.default === undefined,
    })
  }
  return { declarations, diagnostics }
}

/** The declared inputs of a parsed document, for listings. Never fails. */
export function declarationsOf(document: unknown): Declaration[] {
  return isRecord(document) && document.inputs !== undefined ? read(document.inputs).declarations : []
}

function preview(declaration: Declaration): string {
  const value = declaration.default
  if (Array.isArray(value)) return `[${value.length} item${value.length === 1 ? "" : "s"}]`
  if (typeof value === "string") {
    const points = Array.from(value)
    return JSON.stringify(points.length > DEFAULT_PREVIEW ? `${points.slice(0, DEFAULT_PREVIEW - 1).join("")}…` : value)
  }
  return String(value)
}

/** One line naming every input: `objective*` is required, `name=default` is
 * optional, and a type other than string follows the name (`scope:array=[]`). */
export function summary(declarations: readonly Declaration[]): string {
  return declarations
    .map((declaration) => {
      const type = declaration.type === "string" ? "" : `:${declaration.type}`
      return declaration.required ? `${declaration.name}${type}*` : `${declaration.name}${type}=${preview(declaration)}`
    })
    .join(", ")
}

/** A value as it reads inside a sentence. */
function render(value: unknown): string {
  if (typeof value === "string") return value
  if (Array.isArray(value)) {
    if (value.length === 0) return "(none)"
    return value.every((item) => ["string", "number", "boolean"].includes(typeof item))
      ? value.join(", ")
      : JSON.stringify(value)
  }
  return String(value)
}

interface State {
  readonly values: ReadonlyMap<string, unknown>
  readonly used: Set<string>
  readonly origins: Origin[]
}

function substituteText(text: string, path: string, state: State): unknown {
  const whole = WHOLE_PLACEHOLDER.exec(text)
  if (whole && state.values.has(whole[1])) {
    const value = state.values.get(whole[1])
    state.used.add(whole[1])
    // A whole-field placeholder keeps the input's own type, so an array input
    // can fill an array field.
    if (typeof value !== "string") {
      state.origins.push({ path, input: whole[1] })
      return value
    }
  }
  return text.replace(PLACEHOLDER, (match, key: string) => {
    if (!state.values.has(key)) return match
    state.used.add(key)
    return render(state.values.get(key))
  })
}

function substitute(value: unknown, path: string, state: State): unknown {
  if (typeof value === "string") return substituteText(value, path, state)
  if (Array.isArray(value)) return value.map((item, index) => substitute(item, `${path}[${index}]`, state))
  if (isRecord(value))
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, substitute(child, `${path}[${JSON.stringify(key)}]`, state)]),
    )
  return value
}

/**
 * Resolve a start document's template inputs. A document that declares none is
 * returned as it is; supplying inputs to one is an error, so a call never
 * silently drops values it meant to use. A document that declares inputs is
 * instantiated for every supply, including none: the required inputs then
 * report as missing.
 */
export function instantiate(document: unknown, supply?: Supply): Outcome {
  const passthrough = (diagnostics: DagValidation.Diagnostic[] = []): Outcome => ({
    value: document,
    diagnostics,
    declared: false,
    supplied: [],
    defaulted: [],
    origins: [],
  })
  const given = supply?.kind === "values" ? supply.values : {}
  if (!isRecord(document) || document.inputs === undefined) {
    const names = Object.keys(given)
    if (names.length === 0) return passthrough()
    return passthrough([
      DagValidation.diagnostic({
        code: DagValidation.DIAGNOSTIC_CODES.templateInputs,
        path: "inputs",
        message: `this spec declares no inputs, but the call passed inputs: ${names.join(", ")}`,
        hint: "Run the spec without inputs, or add an inputs: section that declares them and refer to them as {{name}}",
      }),
    ])
  }

  const declared = read(document.inputs)
  const fail = (diagnostics: DagValidation.Diagnostic[]): Outcome => ({
    value: document,
    diagnostics,
    declared: true,
    supplied: [],
    defaulted: [],
    origins: [],
  })
  if (declared.diagnostics.length > 0) return fail(declared.diagnostics)

  const names = new Set(declared.declarations.map((declaration) => declaration.name))
  const catalog = `Declared inputs: ${summary(declared.declarations) || "(none)"}`
  const diagnostics: DagValidation.Diagnostic[] = []
  const problem = (name: string, message: string, hint: string) =>
    diagnostics.push(
      DagValidation.diagnostic({
        code: DagValidation.DIAGNOSTIC_CODES.templateInputs,
        path: `inputs.${name}`,
        message,
        hint: `${hint}. ${catalog}`,
      }),
    )
  for (const name of Object.keys(given))
    if (!names.has(name))
      problem(name, `input "${name}" is not declared by this spec`, "Remove it from inputs, or declare it in the spec")

  const values = new Map<string, unknown>()
  const supplied: string[] = []
  const defaulted: string[] = []
  for (const declaration of declared.declarations) {
    const { name, type } = declaration
    if (Object.hasOwn(given, name)) {
      const value = given[name]
      if (!matches(type, value)) {
        problem(
          name,
          `input "${name}" must be ${type === "array" ? "an array" : `a ${type}`}, got ${describe(value)}`,
          `Pass inputs: { "${name}": <${type}> }`,
        )
        continue
      }
      values.set(name, value)
      supplied.push(name)
    } else if (declaration.default !== undefined) {
      values.set(name, declaration.default)
      defaulted.push(name)
    } else if (supply?.kind === "sample") {
      values.set(name, sampleOf(type))
    } else {
      problem(
        name,
        `required input "${name}" was not supplied`,
        `Pass it with run.start { spec_path, inputs: { "${name}": <${type}> } }`,
      )
    }
  }
  if (diagnostics.length > 0) return fail(diagnostics)

  const { inputs: _declarations, ...rest } = document
  const state: State = { values, used: new Set(), origins: [] }
  const value = substitute(rest, "", state)
  const unused = declared.declarations.filter((declaration) => !state.used.has(declaration.name))
  return {
    value,
    // A declared input nothing refers to is usually a misspelled placeholder.
    diagnostics: unused.map((declaration) =>
      DagValidation.diagnostic({
        severity: "warning",
        code: DagValidation.DIAGNOSTIC_CODES.templateInputs,
        path: `inputs.${declaration.name}`,
        message: `input "${declaration.name}" is declared but no {{${declaration.name}}} placeholder uses it`,
        hint: "Refer to it as {{name}} where its value belongs, or remove the declaration",
      }),
    ),
    declared: true,
    supplied,
    defaulted,
    origins: state.origins,
  }
}

/** Name the input a decode failure came from when the failing field was filled
 * from one. */
export function explainOrigins(
  diagnostics: readonly DagValidation.Diagnostic[],
  origins: readonly Origin[],
): DagValidation.Diagnostic[] {
  if (origins.length === 0) return [...diagnostics]
  return diagnostics.map((entry) => {
    const origin = origins.find((candidate) => entry.path.startsWith(candidate.path))
    if (!origin) return entry
    const note = `this value comes from input "${origin.input}"`
    return { ...entry, hint: entry.hint === "" ? note : `${entry.hint}; ${note}` }
  })
}

export * as DagTemplateInputs from "./template-inputs"
