// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { JSONSchema7 } from "@ai-sdk/provider"
import type { ModelProfile } from "@graphagent/core/model-profile"
import { Ajv } from "@modelcontextprotocol/client/validators/ajv"
import type { ToolExecutionOptions } from "ai"
import { InvalidTool } from "./invalid"
import type { ToolEntry } from "./registry"
import { ToolError } from "./tool-error"

/**
 * Model-facing names of the two helpers that stand in for the tools of `deferred` MCP servers (#1459). A deferred
 * server's tools stay out of the tool list: the model reads their one-line catalog in the description of
 * `mcp_describe` (as far as its cap reaches, `CATALOG_MAX_LINES`; `mcp_describe` lists the rest of a server's tools for
 * the `server` it is given), loads a schema with it and calls the tool through `mcp_call`. They are not
 * server-provided tools: the registry adds them while the catalog is not empty, and `McpCatalog.RESERVED_TOOL_KEYS`
 * keeps a server tool from taking either name.
 */
export const MCP_DEFERRED_TOOLS = { describe: "mcp_describe", call: "mcp_call" } as const

export type McpDeferredOp = keyof typeof MCP_DEFERRED_TOOLS

export const MCP_DEFERRED_IDS = [MCP_DEFERRED_TOOLS.describe, MCP_DEFERRED_TOOLS.call] as const

/**
 * A call to a helper whose arguments are wrong, or that names a tool the catalog does not have. The engine counts a
 * failure by its `name`, so this one is a validation fault and not an execution error (#1473).
 */
export class ArgumentsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ToolInvalidArgumentsError"
  }
}

/** The end of a refusal that names a tool's arguments: where the model finds out what they should be. */
export const SCHEMA_HINT = ` Call ${MCP_DEFERRED_TOOLS.describe} for the schema.`

const NO_DESCRIPTION = "(no description)"
const LINE_LIMIT = 120
const FIRST_SENTENCE_END = /[.!?](?=\s|$)|[。！？]/

/**
 * What the description of `mcp_describe` lists of the catalog (#1574): at most this many tools, and at most this many
 * bytes of their lines, each counted with its newline. The first limit reached ends the list, so a server with many
 * tools no longer makes every request bigger by a line for each one. The tools past it are summed up by server in the
 * last lines (`listCatalog`); only the description is cut, the catalog the two helpers work from is whole.
 */
export const CATALOG_MAX_LINES = 200
export const CATALOG_MAX_BYTES = 16 * 1024

const collapse = (text: string) => text.replace(/\s+/g, " ").trim()

/** A line over 120 code points is cut to 119 and an ellipsis. */
function clip(line: string): string {
  const points = Array.from(line)
  return points.length > LINE_LIMIT ? `${points.slice(0, LINE_LIMIT - 1).join("")}…` : line
}

/**
 * The one-line description of a tool: the first sentence of the first line of its description. The sentence is cut at
 * the first `.`, `!` or `?` that a space or the end follows (or the first `。`, `！`, `？`), with its stop, and is the
 * whole line when there is none.
 */
function sentenceOf(description: string): string {
  const first = description
    .split(/\r\n|\r|\n/)
    .map(collapse)
    .find((line) => line !== "")
  const stop = first === undefined ? null : FIRST_SENTENCE_END.exec(first)
  const sentence = first === undefined ? "" : stop === null ? first : first.slice(0, stop.index + stop[0].length)
  return sentence === "" ? NO_DESCRIPTION : sentence
}

/**
 * The catalog line of one tool: `- <key>: <first sentence of the description>`, over 120 code points cut to 119 and an
 * ellipsis.
 */
export function catalogLine(key: string, description: string): string {
  return clip(`- ${key}: ${sentenceOf(description)}`)
}

/** The line of one tool in the listing of a server: `<key> — <first sentence of the description>`, cut the same way. */
export function serverLine(key: string, description: string): string {
  return clip(`${key} — ${sentenceOf(description)}`)
}

/** A deferred tool as the catalog sees it: a `mcp` entry, or what is read of one. */
type CatalogItem = Readonly<{ id: string; description: string; source: Readonly<{ server: string }> }>
type SchemaItem = Readonly<{ id: string; description: string; rawSchema: JSONSchema7 }>

/**
 * The parameters of the two helpers, as they are meant. Fresh objects each time, so a rewrite of one request never
 * reaches another. A provider's rewrite of them may drop constraints (`minItems`, `maxItems`): the helpers check their
 * own arguments against these, not against what the model was shown.
 */
export function helperSchemas(): Record<McpDeferredOp, JSONSchema7> {
  return {
    // Neither property is required and the root is no `oneOf`: a provider may refuse a combinator at the root of a
    // tool's parameters, so the choice of exactly one is checked where the call runs (`describeRequest`).
    describe: {
      type: "object",
      properties: {
        tools: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 10,
          description:
            "Names of the deferred tools to describe, exactly as listed in this tool's description (1 to 10). Give tools or server, not both.",
        },
        server: {
          type: "string",
          description:
            "Name of a server with deferred tools: lists all of its tools, one line each, including any this tool's description does not list. Give server or tools, not both.",
        },
      },
      additionalProperties: false,
    },
    call: {
      type: "object",
      properties: {
        tool: {
          type: "string",
          description: `Name of the deferred tool to call, exactly as listed in the ${MCP_DEFERRED_TOOLS.describe} description.`,
        },
        arguments: {
          type: "object",
          description: `Arguments of the tool, as its input schema from ${MCP_DEFERRED_TOOLS.describe} requires. Omit when it takes none.`,
        },
      },
      required: ["tool"],
      additionalProperties: false,
    },
  }
}

/** How many tools of a server `listCatalog` left out, and how to list them. One line for each server. */
function unlistedLine(server: string, count: number): string {
  const [noun, them] = count === 1 ? ["tool", "it"] : ["tools", "them"]
  return `... ${collapse(server)}: ${count} more ${noun} not listed — call ${MCP_DEFERRED_TOOLS.describe} with {"server": ${JSON.stringify(server)}} to list ${them}.`
}

/**
 * The lines the description of `mcp_describe` shows of `catalog`, the deferred tools by key, ascending: a line for each
 * tool while the lines stay within `CATALOG_MAX_LINES` and their bytes within `CATALOG_MAX_BYTES`, the first limit
 * reached ending the list. Then one line for each server that has tools past it, by server, with their number. A server
 * that has none gets no line. `unlisted` is the number of tools past the list.
 */
export function listCatalog(catalog: ReadonlyArray<CatalogItem>): { lines: string[]; unlisted: number } {
  const lines: string[] = []
  let bytes = 0
  for (const item of catalog) {
    if (lines.length >= CATALOG_MAX_LINES) break
    const line = catalogLine(item.id, item.description)
    const size = Buffer.byteLength(line) + 1
    if (bytes + size > CATALOG_MAX_BYTES) break
    lines.push(line)
    bytes += size
  }
  const rest = catalog.slice(lines.length)
  const counts = new Map<string, number>()
  for (const item of rest) counts.set(item.source.server, (counts.get(item.source.server) ?? 0) + 1)
  const summary = [...counts]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([server, count]) => unlistedLine(server, count))
  return { lines: [...lines, ...summary], unlisted: rest.length }
}

/**
 * The two helper entries, `mcp_describe` then `mcp_call`. `catalog` is the deferred tools by key, ascending: the first
 * of their lines are in the description of `mcp_describe` (`listCatalog`), so the model finds them without a call, and
 * `unlisted` is how many tools are past the cap and not in it. `transform` is the provider's schema rewrite.
 */
export function helperEntries(
  catalog: ReadonlyArray<CatalogItem>,
  transform: (schema: JSONSchema7) => JSONSchema7,
): { entries: ToolEntry[]; unlisted: number } {
  const source = (op: McpDeferredOp) =>
    ({ kind: "mcp-deferred", op, registrationID: `mcp-deferred:${MCP_DEFERRED_TOOLS[op]}` }) as const
  const schemas = helperSchemas()
  const { lines, unlisted } = listCatalog(catalog)
  return {
    entries: [
      {
        id: MCP_DEFERRED_TOOLS.describe,
        source: source("describe"),
        effects: "read",
        description: [
          `Read the input schema of deferred MCP tools before calling them with ${MCP_DEFERRED_TOOLS.call}. Pass tools (1 to 10 names from the list below), or server (a server name) to list all tools of that server; not both.`,
          "Deferred tools:",
          ...lines,
        ].join("\n"),
        jsonSchema: transform(schemas.describe),
      },
      {
        id: MCP_DEFERRED_TOOLS.call,
        source: source("call"),
        effects: "unknown",
        description: "Call a deferred MCP tool by its catalog name.",
        jsonSchema: transform(schemas.call),
      },
    ],
    unlisted,
  }
}

/** What a call to `mcp_describe` asks for: the schemas of tools by key, or the tools of a server. */
export type DescribeRequest =
  { readonly kind: "tools"; readonly names: string[] } | { readonly kind: "server"; readonly server: string }

/** The detail of the refusal of a call that names both `tools` and `server`, or neither: what each one is for. */
export const DESCRIBE_CHOICE =
  "(root) must have exactly one of 'tools' and 'server': 'tools' reads the schemas of tools, 'server' lists the tools of a server"

/**
 * What a call to `mcp_describe` asks for, once its arguments fit `helperSchemas().describe`: exactly one of `tools` and
 * `server`. `undefined` for both and for neither. The names are each tool once, in the order asked.
 */
export function describeRequest(args: Readonly<Record<string, unknown>>): DescribeRequest | undefined {
  const { tools, server } = args
  if ((tools === undefined) === (server === undefined)) return undefined
  if (server !== undefined) return typeof server === "string" ? { kind: "server", server } : undefined
  const names = Array.isArray(tools) ? tools.filter((name): name is string => typeof name === "string") : []
  return { kind: "tools", names: [...new Set(names)] }
}

/** What `mcp_describe` returns for a server: a line for each of its tools, by key, as `serverLine` writes it. */
export function serverListing(items: ReadonlyArray<Pick<CatalogItem, "id" | "description">>): string {
  return items
    .toSorted((left, right) => left.id.localeCompare(right.id))
    .map((item) => serverLine(item.id, item.description))
    .join("\n")
}

/** The refusal of a `server` that has no tool in the catalog the agent can see; the servers that have one are listed. */
export function unknownServer(requested: string, available: readonly string[]): string {
  return `Unknown MCP server "${ToolError.clipName(requested)}". Servers with deferred tools: ${ToolError.nameList(available)}. Use one of them.`
}

/**
 * What `mcp_describe` returns: for each tool, its key, its whole description and its input schema, a blank line
 * between the tools. The schema is the server's own, not the provider's rewrite of it, and `mcp_call` holds the
 * arguments to that same one (#1576).
 */
export function describeBlocks(items: ReadonlyArray<SchemaItem>): string {
  return items
    .map((item) =>
      [
        item.id,
        item.description.trim() === "" ? NO_DESCRIPTION : item.description,
        `Input schema: ${JSON.stringify(item.rawSchema)}`,
      ].join("\n"),
    )
    .join("\n\n")
}

type AjvError = NonNullable<InstanceType<typeof Ajv>["errors"]>[number]

const FAULT_LIMIT = 4
const DETAIL_LIMIT = 480

const isPlainValue = (value: unknown): value is string | number | boolean =>
  typeof value === "string" || typeof value === "number" || typeof value === "boolean"

/** One fault as `<path> <what is wrong>`. The wording comes from the validator and from the schema, never from the value. */
function describeFault(error: AjvError): string {
  const where = error.instancePath === "" ? "(root)" : error.instancePath
  const allowed: unknown = error.params.allowedValues
  if (error.keyword === "enum" && Array.isArray(allowed) && allowed.every(isPlainValue))
    return `${where} must be ${ToolError.oneOf(allowed)}`
  return `${where} ${error.message ?? "does not match the schema"}`
}

/**
 * A check of a value against a JSON Schema, for the arguments of a call. It returns why the value does not fit, or
 * nothing when it fits. The schema is a server's, so it is taken as written, as the server takes it: unknown
 * keywords and formats are ignored and no `$schema` is held against it. One that does not compile is not checked; the
 * server answers for such a call. A compiled schema is kept for as long as the checker lives, by schema object, so
 * make one checker per request and not one per call.
 */
export function makeChecker(): (schema: JSONSchema7, value: unknown) => string | undefined {
  let ajv: InstanceType<typeof Ajv> | undefined
  const compiled = new Map<JSONSchema7, (value: unknown) => string | undefined>()

  const compile = (engine: InstanceType<typeof Ajv>, schema: JSONSchema7) => {
    try {
      const validate = engine.compile(schema)
      return (value: unknown): string | undefined => {
        const fits = validate(value)
        // A schema that declares itself asynchronous answers with a promise: it is not one to hold a call against.
        if (typeof fits !== "boolean") {
          void Promise.resolve(fits).catch(() => undefined)
          return undefined
        }
        if (fits) return undefined
        const detail = (validate.errors ?? []).slice(0, FAULT_LIMIT).map(describeFault).join("; ")
        const text = detail === "" ? "(root) does not match the schema" : detail
        return text.length <= DETAIL_LIMIT ? text : Array.from(text).slice(0, DETAIL_LIMIT).join("")
      }
    } catch {
      return () => undefined
    }
  }

  return (schema, value) => {
    ajv ??= new Ajv({ strict: false, validateFormats: false, validateSchema: false, allErrors: true })
    let check = compiled.get(schema)
    if (check === undefined) {
      check = compile(ajv, schema)
      compiled.set(schema, check)
    }
    return check(value)
  }
}

type McpEntry = Extract<ToolEntry, { source: { kind: "mcp" } }>

const isMcp = (entry: ToolEntry): entry is McpEntry => entry.source.kind === "mcp"
const isDeferred = (entry: ToolEntry): entry is McpEntry => isMcp(entry) && entry.source.deferred === true
const isLive = (entry: ToolEntry): entry is McpEntry => isMcp(entry) && entry.source.deferred !== true

/** The same tool, out of the tool list and in the catalog. */
const defer = (entry: McpEntry): McpEntry => ({ ...entry, source: { ...entry.source, deferred: true } })

const byKey = (left: ToolEntry, right: ToolEntry) => left.id.localeCompare(right.id)

/** The limits a model's profile puts on the tools it is sent. Each is checked only when it is declared. */
export type ToolLimits = ModelProfile["toolLimits"]

/** How many MCP tools `settle` moved into the catalog for a limit of the model: by the count of tools, by a name. */
export type Moved = Readonly<{ byCount: number; byName: number }>

/** A pattern as a `RegExp`; one that is absent or does not compile is no pattern. */
function patternOf(source: string | undefined): RegExp | undefined {
  if (source === undefined) return undefined
  try {
    return new RegExp(source)
  } catch {
    return undefined
  }
}

/**
 * The entries with the MCP tools that a limit of the model leaves no room for moved into the catalog. First by name:
 * a tool whose key is longer than `nameMaxLength`, or does not match `namePattern`, moves. Then by count: the model
 * is sent the tools that are neither MCP tools nor `invalid` (which no request carries), the MCP tools that stay, and
 * the two helpers while there is a catalog. Over `maxTools`, only as many MCP tools stay as the limit leaves room for
 * after the others, the first by key, and the rest move.
 */
function fit(kept: ToolEntry[], limits: ToolLimits): { entries: ToolEntry[]; moved: Moved } {
  const longest = limits.nameMaxLength
  const pattern = patternOf(limits.namePattern)
  let byName = 0
  const named = kept.map((entry) => {
    if (!isLive(entry)) return entry
    if ((longest === undefined || entry.id.length <= longest) && (pattern === undefined || pattern.test(entry.id)))
      return entry
    byName++
    return defer(entry)
  })

  const native = named.filter((entry) => !isMcp(entry) && entry.id !== InvalidTool.id).length
  const live = named.filter(isLive).toSorted(byKey)
  const helpers = named.some(isDeferred) ? MCP_DEFERRED_IDS.length : 0
  const most = limits.maxTools
  if (most === undefined || native + live.length + helpers <= most)
    return { entries: named, moved: { byCount: 0, byName } }

  const over = new Set(live.slice(Math.max(0, most - native - MCP_DEFERRED_IDS.length)).map((entry) => entry.id))
  return {
    entries: named.map((entry) => (isLive(entry) && over.has(entry.id) ? defer(entry) : entry)),
    moved: { byCount: over.size, byName },
  }
}

/**
 * The entries a request resolves to, and how many MCP tools were moved into the catalog for a limit of the model. The
 * ones `visible` stay, in order, the deferred MCP tools among them: the pipeline needs them to run a call through
 * `mcp_call`, and the model never sees them as tools. While both helper names are visible (a rule or a switch can hide
 * either) the tools that break `limits` are moved into the catalog (`fit`), as there is a way to reach them; where
 * either is hidden nothing is moved. While at least one deferred tool is left and both helpers are visible, the two
 * helpers follow, and their description is the catalog of those tools by key, as far as the cap on it reaches
 * (`listCatalog`); `unlisted` is the number of tools past it, 0 where there are no helpers. The deferred entries are all
 * kept, so a tool past the cap is reached by its key as any other.
 */
export function settle(input: {
  entries: Iterable<ToolEntry>
  visible: (id: string) => boolean
  transform: (schema: JSONSchema7) => JSONSchema7
  limits: ToolLimits
}): { entries: ToolEntry[]; moved: Moved; unlisted: number } {
  const kept = [...input.entries].filter((entry) => input.visible(entry.id))
  if (!MCP_DEFERRED_IDS.every((id) => input.visible(id)))
    return { entries: kept, moved: { byCount: 0, byName: 0 }, unlisted: 0 }
  const { entries, moved } = fit(kept, input.limits)
  const catalog = entries.filter(isDeferred).toSorted(byKey)
  if (catalog.length === 0) return { entries, moved, unlisted: 0 }
  const helpers = helperEntries(catalog, input.transform)
  return { entries: [...entries, ...helpers.entries], moved, unlisted: helpers.unlisted }
}

/** The toast for tools moved into the catalog for the limits of `model`, written `<provider>/<id>`. */
export function movedNotice(count: number, model: string): { title: string; message: string } {
  return {
    title: "MCP tools moved to the deferred catalog",
    message: `${count} ${count === 1 ? "tool does" : "tools do"} not fit the limits of ${model}`,
  }
}

/**
 * What the transcript keeps as the input of a call. A call through `mcp_call` runs the target's own pipeline, which
 * records the arguments it executes; the model's call was `{ tool, arguments }`, so that is what stays. Any other
 * call keeps its arguments.
 */
export function recordedInput(
  proxied: WeakMap<ToolExecutionOptions, string>,
  options: ToolExecutionOptions,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const key = proxied.get(options)
  return key === undefined ? args : { tool: key, arguments: args }
}
