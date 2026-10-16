import { markPermissionRewrite } from "./permission-rewrite"
export * as GlobTool from "./glob"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import path from "path"
import { FileSystem } from "../filesystem"
import { Location } from "../location"
import { LocationMutation } from "../location-mutation"
import { Ripgrep } from "../ripgrep"
import { RelativePath } from "../schema"
import { PermissionV2 } from "../permission"
import { ContextFoldingBuiltins } from "./context-folding-builtins"
import { Tool } from "./tool"

export const name = "glob"

export const Input = Schema.Struct({
  pattern: FileSystem.GlobInput.fields.pattern.annotate({ description: "Glob pattern to match files against" }),
  path: RelativePath.pipe(Schema.optional).annotate({
    description:
      "Search path relative to the active Location, or an absolute path. External absolute paths require external_directory approval. Relative paths must stay inside the Location. Paths inside it cannot escape through symlinks.",
  }),
  limit: FileSystem.GlobInput.fields.limit.annotate({
    description: "Maximum results to return",
  }),
})

export const Output = Schema.Array(FileSystem.Entry)
type ModelOutput = typeof Output.Encoded

/** Format raw search results into the concise line-oriented output models expect. */
export const toModelOutput = (output: ModelOutput) => {
  const lines = output.length === 0 ? ["No files found"] : output.map((item) => item.path)
  return lines.join("\n")
}

/** Glob leaf that defaults its filesystem root to the active Location. */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* ContextFoldingBuiltins.Service
    const ripgrep = yield* Ripgrep.Service
    const location = yield* Location.Service
    const permission = yield* PermissionV2.Service
    const mutation = yield* LocationMutation.Service

    yield* tools
      .register({
        [name]: markPermissionRewrite(
          Tool.make({
            contextFolding: { instructions: "none" },
            description:
              "Find files by glob pattern. Paths default to the active Location; external absolute directories require external_directory approval. Relative paths must stay inside the Location. Paths inside it cannot escape through symlinks. Structured file resources are Location-relative; model output shows absolute paths. Use limit to bound the result count.",
            input: Input,
            output: Output,
            toModelOutput: ({ output }) => [
              {
                type: "text",
                text: toModelOutput(
                  output.map((entry) => ({ ...entry, path: path.resolve(location.directory, entry.path) })),
                ),
              },
            ],
            execute: (input, context) =>
              Effect.gen(function* () {
                const resolved = yield* mutation.resolve({ path: input.path ?? ".", kind: "directory" })
                if (resolved.externalDirectory)
                  yield* permission.assert({
                    ...LocationMutation.externalDirectoryPermission(resolved.externalDirectory),
                    sessionID: context.sessionID,
                    agent: context.agent,
                    source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
                  })
                yield* permission.assert({
                  action: name,
                  resources: [input.pattern],
                  save: ["*"],
                  metadata: {
                    root: input.path ?? ".",
                    path: input.path,
                    limit: input.limit,
                  },
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
                })
                const cwd = resolved.canonical
                return yield* ripgrep
                  .glob({
                    cwd,
                    pattern: input.pattern,
                    limit: input.limit ?? Number.MAX_SAFE_INTEGER,
                  })
                  .pipe(
                    Effect.map((result) =>
                      result.map((entry) =>
                        FileSystem.Entry.make({
                          ...entry,
                          path: RelativePath.make(path.relative(location.directory, path.resolve(cwd, entry.path))),
                        }),
                      ),
                    ),
                  )
              }).pipe(
                Effect.mapError(() => new ToolFailure({ message: `Unable to find files matching ${input.pattern}` })),
              ),
          }),
        ),
      })
      .pipe(Effect.orDie)
  }),
)
