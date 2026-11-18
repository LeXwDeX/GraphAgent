import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import path from "path"
import { LSP } from "@/lsp/lsp"
import DESCRIPTION from "./lsp.txt"
import { InstanceState } from "@/effect/instance-state"
import { pathToFileURL } from "url"
import { assertExternalDirectoryEffect } from "./external-directory"
import { FSUtil } from "@graphagent/core/fs-util"
import { LspModelView } from "@/lsp/model-view"

const operations = [
  "goToDefinition",
  "findReferences",
  "hover",
  "documentSymbol",
  "workspaceSymbol",
  "goToImplementation",
  "prepareCallHierarchy",
  "incomingCalls",
  "outgoingCalls",
] as const

/** The operations that act at a cursor position; `documentSymbol` and `workspaceSymbol` take none. */
const POSITIONAL: ReadonlySet<(typeof operations)[number]> = new Set([
  "goToDefinition",
  "findReferences",
  "hover",
  "goToImplementation",
  "prepareCallHierarchy",
  "incomingCalls",
  "outgoingCalls",
])

/** `workspaceSymbol` shows this many symbols; the total says how many exist. */
const WORKSPACE_SYMBOL_LIMIT = 10

export const Parameters = Schema.Struct({
  operation: Schema.Literals(operations).annotate({ description: "The LSP operation to perform" }),
  filePath: Schema.String.annotate({
    description: "Path to the file; relative paths resolve from the project directory",
  }),
  line: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))).annotate({
    description: "The line number (1-based, as shown by read); required except for documentSymbol and workspaceSymbol",
  }),
  character: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))).annotate({
    description:
      "The character offset (1-based, as shown by read); required except for documentSymbol and workspaceSymbol",
  }),
  query: Schema.optional(Schema.String).annotate({
    description: "Search query for workspaceSymbol. Empty string requests all symbols.",
  }),
})

/** Why a positional operation cannot run: `line` and `character` are optional on the wire, so the call is checked here. */
function missingPositionDetail(args: Schema.Schema.Type<typeof Parameters>): string | undefined {
  if (!POSITIONAL.has(args.operation) || (args.line !== undefined && args.character !== undefined)) return undefined
  return `line and character (1-based, as shown by read) are required for ${args.operation}; only documentSymbol and workspaceSymbol work without them.`
}

/** The text of a result: the model's view of it, with the symbol total in front when `workspaceSymbol` was cut. */
function renderResult(operation: string, shown: unknown[], total: number) {
  if (total === 0) return `No results found for ${operation}`
  const body = JSON.stringify(LspModelView.modelView(shown), null, 2)
  if (total <= shown.length) return body
  return `${operation}: showing ${shown.length} of ${total} symbols. Narrow the query to see others.\n${body}`
}

export const LspTool = Tool.define(
  "lsp",
  Effect.gen(function* () {
    const lsp = yield* LSP.Service
    const fs = yield* FSUtil.Service
    return {
      description: DESCRIPTION,
      effects: "read",
      parameters: Parameters,
      execute: (args: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const missing = missingPositionDetail(args)
          if (missing) return yield* Effect.fail(new Tool.InvalidArgumentsError({ tool: "lsp", detail: missing }))
          const instance = yield* InstanceState.context
          const file = path.isAbsolute(args.filePath) ? args.filePath : path.join(instance.directory, args.filePath)
          yield* assertExternalDirectoryEffect(ctx, file)
          const meta =
            args.operation === "workspaceSymbol"
              ? { operation: args.operation }
              : args.operation === "documentSymbol"
                ? { operation: args.operation, filePath: file }
                : { operation: args.operation, filePath: file, line: args.line, character: args.character }
          yield* ctx.ask({
            permission: "lsp",
            patterns: ["*"],
            always: ["*"],
            metadata: meta,
          })

          const uri = pathToFileURL(file).href
          // Positional operations were checked above; the defaults only satisfy the types.
          const position = { file, line: (args.line ?? 1) - 1, character: (args.character ?? 1) - 1 }
          const relPath = path.relative(instance.worktree, file)
          const detail =
            args.operation === "workspaceSymbol"
              ? ""
              : args.operation === "documentSymbol"
                ? relPath
                : `${relPath}:${args.line}:${args.character}`
          const title = detail ? `${args.operation} ${detail}` : args.operation

          const exists = yield* fs.existsSafe(file)
          if (!exists) throw new Error(`File not found: ${file}. Check the path with glob.`)

          const available = yield* lsp.hasClients(file)
          if (!available) throw new Error("No LSP server available for this file type. Use grep or read instead.")

          yield* lsp.touchFile(file, "document")

          const found: unknown[] = yield* (() => {
            switch (args.operation) {
              case "goToDefinition":
                return lsp.definition(position)
              case "findReferences":
                return lsp.references(position)
              case "hover":
                return lsp.hover(position)
              case "documentSymbol":
                return lsp.documentSymbol(uri)
              case "workspaceSymbol":
                return lsp.workspaceSymbol(args.query ?? "")
              case "goToImplementation":
                return lsp.implementation(position)
              case "prepareCallHierarchy":
                return lsp.prepareCallHierarchy(position)
              case "incomingCalls":
                return lsp.incomingCalls(position)
              case "outgoingCalls":
                return lsp.outgoingCalls(position)
            }
          })()

          const result = args.operation === "workspaceSymbol" ? found.slice(0, WORKSPACE_SYMBOL_LIMIT) : found
          return {
            title,
            metadata: { result },
            output: renderResult(args.operation, result, found.length),
          }
        }).pipe(Effect.orDie),
    }
  }),
)
