import { isRecord } from "@/util/record"
import { Hash } from "@graphagent/core/util/hash"
import { ListToolsResultSchema, ToolSchema } from "@modelcontextprotocol/core"
import { Client } from "@modelcontextprotocol/client"
import type { Tool as MCPToolDef } from "@modelcontextprotocol/client"
import { dynamicTool, jsonSchema, type JSONSchema7, type Tool } from "ai"
import { SessionContext } from "@/effect/session-context"
import { McpContent } from "./content"
import { mcpHookSource, withClientElicitationCall } from "./elicitation-binding"
import { Effect } from "effect"

const DEFAULT_TIMEOUT = 30_000
const MAX_LIST_PAGES = 1_000

const TolerantListToolsResultSchema = ListToolsResultSchema.extend({
  tools: ToolSchema.omit({ outputSchema: true }).array(),
})

type CallResult = Awaited<ReturnType<Client["callTool"]>>

/** The text of a failed call: its text items, and a line in place of every other kind of item (#1447). */
function failureText(content: CallResult["content"], server: string | undefined) {
  return (
    content
      .map((item) => (item.type === "text" ? item.text : McpContent.omitted(item, server)))
      .filter((text) => text.trim())
      .join("\n\n") || "MCP tool returned an error"
  )
}

/**
 * The result a call returns. A result's `structuredContent` is shown beside its `content` instead of replacing it
 * (#1447). A `mcp_tool` hook reads the first text item as the hook's stdout, so a hook's call still gets one compact
 * JSON line.
 */
function callResult(result: CallResult, forHook: boolean): CallResult {
  if (result.structuredContent === undefined || result.structuredContent === null) return result
  if (forHook)
    return { ...result, content: [{ type: "text" as const, text: JSON.stringify(result.structuredContent) }] }
  const extra = McpContent.structured(result)
  return extra ? { ...result, content: [...result.content, extra] } : result
}

export async function paginate<T, R extends { nextCursor?: string }>(
  list: (cursor?: string) => Promise<R>,
  items: (result: R) => T[],
) {
  const result: T[] = []
  const cursors = new Set<string>()
  let cursor: string | undefined

  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const page = await list(cursor)
    result.push(...items(page))
    if (page.nextCursor === undefined) return result
    if (cursors.has(page.nextCursor)) throw new Error(`MCP list returned duplicate cursor: ${page.nextCursor}`)
    cursors.add(page.nextCursor)
    cursor = page.nextCursor
  }

  throw new Error(`MCP list exceeded ${MAX_LIST_PAGES} pages`)
}

export function defs(client: Client, timeout?: number) {
  return listTools(client, timeout ?? DEFAULT_TIMEOUT).pipe(Effect.catch(() => Effect.void))
}

export function convertTool(mcpTool: MCPToolDef, client: Client, timeout?: number, server?: string): Tool {
  const inputSchema: JSONSchema7 = {
    ...(mcpTool.inputSchema as JSONSchema7),
    type: "object",
    properties: (mcpTool.inputSchema.properties ?? {}) as JSONSchema7["properties"],
    // A server that declared `additionalProperties` keeps its own answer; only silence means "no extra arguments".
    ...(Object.hasOwn(mcpTool.inputSchema, "additionalProperties") ? {} : { additionalProperties: false }),
  }

  return dynamicTool({
    description: mcpTool.description ?? "",
    inputSchema: jsonSchema(inputSchema),
    execute: async (args: unknown, options) => {
      const hook = mcpHookSource(options)
      const result = await withClientElicitationCall(
        client,
        {
          sessionID: hook?.sessionID ?? SessionContext.sessionID,
          callID: options.toolCallId,
          signal: options.abortSignal,
          inHook: hook?.inHook,
        },
        (signal) =>
          client.callTool(
            {
              name: mcpTool.name,
              arguments: isRecord(args) ? args : {},
            },
            {
              resetTimeoutOnProgress: true,
              signal,
              timeout,
              // The MCP SDK only sends a progress token when this hook is present, enabling timeout resets.
              onprogress: () => {},
            },
          ),
      )
      if (result.isError) throw new Error(failureText(result.content, server))
      return callResult(result, hook !== undefined)
    },
  })
}

export function fetch<T extends { name: string }>(
  clientName: string,
  client: Client,
  list: (client: Client) => Promise<T[]>,
  label: string,
  key?: (item: T) => string,
) {
  return Effect.tryPromise({
    try: () => list(client),
    catch: (error) => error,
  }).pipe(
    Effect.tapError((error) =>
      Effect.logWarning(`failed to get ${label}`, {
        clientName,
        error: error instanceof Error ? error.message : String(error),
      }),
    ),
    Effect.flatMap((items) => {
      const sanitizedClient = sanitize(clientName)
      // Escape both the separator and escape marker so `server:uri` keys remain unambiguous.
      const resourceClient = clientName.replaceAll("%", "%25").replaceAll(":", "%3A")
      const found = new Map<string, T & { client: string }>()
      const skipped: { name: string; key: string }[] = []
      for (const item of items) {
        const itemKey = key ? resourceClient + ":" + key(item) : sanitizedClient + ":" + sanitize(item.name)
        // Two names can sanitize to one key (`a.b`, `a_b`): the first listed keeps it and the rest are reported.
        if (!key && found.has(itemKey)) skipped.push({ name: item.name, key: itemKey })
        else found.set(itemKey, { ...item, client: clientName })
      }
      return Effect.forEach(
        skipped,
        (item) => Effect.logWarning(`duplicate ${label} key; keeping the first one listed`, { clientName, ...item }),
        { discard: true },
      ).pipe(Effect.as(Object.fromEntries(found)))
    }),
    Effect.orElseSucceed(() => undefined),
  )
}

export const sanitize = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "_")

/** The plain key of a server tool. A tool's model-facing key comes from `assignToolKeys`, which starts from this one. */
export const toolName = (clientName: string, name: string) => sanitize(clientName) + "_" + sanitize(name)

/** The longest model-facing tool key; providers commonly cap function names at 64 characters (#1459). */
export const TOOL_KEY_MAX = 64

/**
 * Names the deferred-tool helpers will own, so no server tool may take them. `src/mcp/` does not import `src/tool/`,
 * which is why they are spelled out here.
 */
export const RESERVED_TOOL_KEYS: readonly string[] = ["mcp_describe", "mcp_call"]

const KEY_HASH_LENGTH = 8

const compareText = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0)

/**
 * The model-facing key of every `(server, tool)`, in the order given and the same length.
 *
 * A key is `toolName`. When two tools would share it, when it is longer than `TOOL_KEY_MAX` or when it is a reserved
 * name, each such tool gets instead its first `TOOL_KEY_MAX - 9` characters, `_` and 8 hex digits of the hash of its
 * real server and tool names: the key then depends on the tool alone, never on which server connected first. A key
 * that two tools still share after that stays with the first `(server, tool)` in lexicographic order and the others
 * get "", which the caller skips.
 */
export function assignToolKeys(pairs: ReadonlyArray<{ server: string; tool: string }>): string[] {
  const bases = pairs.map((pair) => toolName(pair.server, pair.tool))
  const shared = new Map<string, number>()
  for (const base of bases) shared.set(base, (shared.get(base) ?? 0) + 1)
  const keys = bases.map((base, index) =>
    base.length > TOOL_KEY_MAX || RESERVED_TOOL_KEYS.includes(base) || (shared.get(base) ?? 0) > 1
      ? base.slice(0, TOOL_KEY_MAX - KEY_HASH_LENGTH - 1) +
        "_" +
        Hash.sha256(pairs[index].server + "\0" + pairs[index].tool).slice(0, KEY_HASH_LENGTH)
      : base,
  )
  const first = new Map<string, number>()
  const order = pairs
    .map((_, index) => index)
    .toSorted(
      (left, right) =>
        compareText(pairs[left].server, pairs[right].server) || compareText(pairs[left].tool, pairs[right].tool),
    )
  for (const index of order) if (!first.has(keys[index])) first.set(keys[index], index)
  return keys.map((key, index) => (first.get(key) === index ? key : ""))
}

/**
 * Real identity of a server-provided tool. The model-facing key (`server_tool`) is
 * lossy, so hook consumers must read this binding instead of splitting a key.
 * `source` is where the server definition came from; it is "unknown" unless the
 * runtime actually tracked it.
 */
export interface ToolBinding {
  readonly server: string
  readonly tool: string
  readonly source: string
  /** The server marked this tool `_meta["anthropic/requiresUserInteraction"] === true`. */
  readonly requiresUserInteraction?: boolean
  /**
   * The key this tool had before `assignToolKeys` shortened it or made it unique (#1459); set only on such a tool.
   * A deny or ask rule written for that key still applies to the tool.
   */
  readonly baseKey?: string
}

const bindings = new WeakMap<object, ToolBinding>()

export function bindTool<T extends object>(item: T, binding: ToolBinding): T {
  bindings.set(item, binding)
  return item
}

export function toolBinding(item: object): ToolBinding | undefined {
  return bindings.get(item)
}

/** Claude-style `mcp__<server>__<tool>` name derived from the real binding. */
export const canonicalToolName = (binding: Pick<ToolBinding, "server" | "tool">) =>
  `mcp__${sanitize(binding.server)}__${sanitize(binding.tool)}`

export function prompts(client: Client, timeout?: number) {
  if (!client.getServerCapabilities()?.prompts) return Promise.resolve([])
  return paginate(
    (cursor) => client.listPrompts(cursor === undefined ? undefined : { cursor }, { timeout }),
    (result) => result.prompts,
  )
}

export function resources(client: Client, timeout?: number) {
  if (!client.getServerCapabilities()?.resources) return Promise.resolve([])
  return paginate(
    (cursor) => client.listResources(cursor === undefined ? undefined : { cursor }, { timeout }),
    (result) => result.resources,
  )
}

export function resourceTemplates(client: Client, timeout?: number) {
  if (!client.getServerCapabilities()?.resources) return Promise.resolve([])
  return paginate(
    (cursor) => client.listResourceTemplates(cursor === undefined ? undefined : { cursor }, { timeout }),
    (result) => result.resourceTemplates,
  )
}

function listTools(client: Client, timeout: number) {
  return Effect.tryPromise({
    try: () =>
      paginate(
        async (cursor) => {
          const params = cursor === undefined ? undefined : { cursor }
          try {
            return await client.listTools(params, { timeout })
          } catch (error) {
            if (!(error instanceof Error) || !isOutputSchemaValidationError(error)) throw error
            return client.request({ method: "tools/list", params }, TolerantListToolsResultSchema, { timeout })
          }
        },
        (result) => result.tools,
      ),
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  })
}

function isOutputSchemaValidationError(error: Error) {
  return /can't resolve reference|resolves to more than one schema|outputSchema|schema.*reference|reference.*schema/i.test(
    error.message,
  )
}

export * as McpCatalog from "./catalog"
