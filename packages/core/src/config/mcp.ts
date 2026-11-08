export * as ConfigMCP from "./mcp"

import { Schema } from "effect"
import { PositiveInt } from "../schema"
import { InvalidError } from "../v1/config/error"

export class Timeout extends Schema.Class<Timeout>("ConfigMCP.Timeout")({
  startup: PositiveInt.pipe(Schema.optional).annotate({
    description: "Maximum time in milliseconds to establish and initialize the MCP server (default: 30000).",
  }),
  request: PositiveInt.pipe(Schema.optional).annotate({
    description: "Maximum time in milliseconds to wait for each MCP request after initialization (default: 30000).",
  }),
}) {}

export class Local extends Schema.Class<Local>("ConfigMCP.Local")({
  type: Schema.Literal("local"),
  command: Schema.String.pipe(Schema.Array),
  cwd: Schema.String.pipe(Schema.optional).annotate({
    description: "Working directory for the MCP server process. Relative paths resolve from the workspace directory.",
  }),
  environment: Schema.Record(Schema.String, Schema.String).pipe(Schema.optional),
  disabled: Schema.Boolean.pipe(Schema.optional),
  timeout: Timeout.pipe(Schema.optional),
}) {}

export class OAuth extends Schema.Class<OAuth>("ConfigMCP.OAuth")({
  client_id: Schema.String.pipe(Schema.optional),
  client_secret: Schema.String.pipe(Schema.optional),
  scope: Schema.String.pipe(Schema.optional),
  callback_port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })).pipe(Schema.optional),
  redirect_uri: Schema.String.pipe(Schema.optional),
}) {}

export class Remote extends Schema.Class<Remote>("ConfigMCP.Remote")({
  type: Schema.Literal("remote"),
  url: Schema.String,
  headers: Schema.Record(Schema.String, Schema.String).pipe(Schema.optional),
  oauth: Schema.Union([OAuth, Schema.Literal(false)]).pipe(Schema.optional),
  disabled: Schema.Boolean.pipe(Schema.optional),
  timeout: Timeout.pipe(Schema.optional),
}) {}

export const Server = Schema.Union([Local, Remote]).pipe(Schema.toTaggedUnion("type"))
export type Server = Schema.Schema.Type<typeof Server>

/**
 * The `mcp.json` document. MCP servers live in their own file so that the
 * shared settings file cannot silently enable external servers; the document
 * has exactly one top-level key, `mcpServers`.
 */
export class Info extends Schema.Class<Info>("ConfigMCP")({
  mcpServers: Schema.Record(Schema.String, Server).pipe(Schema.optional).annotate({
    description: "MCP servers run or connected by GraphAgent, keyed by server name.",
  }),
}) {}

/**
 * Reject settings that no longer live in the shared configuration file. The
 * decoder ignores excess properties, so without this check a leftover `mcp`
 * map or `experimental.mcp_timeout` would be dropped silently instead of
 * pointing at its new home in `mcp.json`.
 */
export function rejectRemovedSettings(input: unknown, source: string): void {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return
  const doc = input as Record<string, unknown>
  if (Object.hasOwn(doc, "mcp")) {
    throw new InvalidError({
      path: source,
      message:
        '"mcp" is no longer a configuration key. Move every server entry to mcp.json under "mcpServers" (project layer: .agents/mcp.json; user level: mcp.json in the config directory).',
    })
  }
  const experimental = doc.experimental
  if (
    experimental !== null &&
    typeof experimental === "object" &&
    !Array.isArray(experimental) &&
    Object.hasOwn(experimental, "mcp_timeout")
  ) {
    throw new InvalidError({
      path: source,
      message:
        '"experimental.mcp_timeout" was removed. Set "timeout": { "request": <milliseconds> } on each mcp.json entry instead.',
    })
  }
}