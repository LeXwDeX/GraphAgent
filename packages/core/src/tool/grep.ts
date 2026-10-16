import { markPermissionRewrite } from "./permission-rewrite"
export * as GrepTool from "./grep"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import path from "path"
import { FileSystem } from "../filesystem"
import { FSUtil } from "../fs-util"
import { Location } from "../location"
import { LocationMutation } from "../location-mutation"
import { PermissionV2 } from "../permission"
import { Ripgrep } from "../ripgrep"
import { RelativePath } from "../schema"
import { ContextFoldingBuiltins } from "./context-folding-builtins"
import { Tool } from "./tool"

export const name = "grep"

export const Input = Schema.Struct({
  pattern: FileSystem.GrepInput.fields.pattern.annotate({
    description: "Regex pattern to search for in file contents",
  }),
  path: RelativePath.pipe(Schema.optional).annotate({
    description:
      "Search path relative to the active Location, or an absolute path. External absolute paths require external_directory approval. Relative paths must stay inside the Location. Paths inside it cannot escape through symlinks.",
  }),
  include: FileSystem.GrepInput.fields.include.annotate({
    description: 'File glob to include in the search (for example, "*.js" or "*.{ts,tsx}")',
  }),
  limit: FileSystem.GrepInput.fields.limit.annotate({
    description: "Maximum matches to return",
  }),
})

export const Output = Schema.Array(FileSystem.Match)
type ModelOutput = typeof Output.Encoded

/** Format raw search matches into the familiar concise model output. */
export const toModelOutput = (output: ModelOutput) => {
  const lines = output.length === 0 ? ["No files found"] : [`Found ${output.length} matches`]
  let current = ""
  for (const match of output) {
    if (current !== match.entry.path) {
      if (current) lines.push("")
      current = match.entry.path
      lines.push(`${match.entry.path}:`)
    }
    lines.push(`  Line ${match.line}: ${match.text}`)
  }
  return lines.join("\n")
}

/** Grep leaf that defaults its filesystem root to the active Location. */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* ContextFoldingBuiltins.Service
    const fs = yield* FSUtil.Service
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
              "Search file contents by regular expression. Paths default to the active Location; external absolute files or directories require external_directory approval. Relative paths must stay inside the Location. Paths inside it cannot escape through symlinks. Use a path to narrow the search, include to filter files by glob, and limit to bound the match count. Returns concise file resources, line numbers, and bounded line previews.",
            input: Input,
            output: Output,
            toModelOutput: ({ output }) => [
              {
                type: "text",
                text: toModelOutput(
                  output.map((match) => ({
                    ...match,
                    entry: { ...match.entry, path: path.resolve(location.directory, match.entry.path) },
                  })),
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
                    root: ".",
                    path: input.path,
                    include: input.include,
                    limit: input.limit,
                  },
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
                })
                const target = resolved.canonical
                const info = yield* fs.stat(target).pipe(Effect.catch(() => Effect.succeed(undefined)))
                return yield* ripgrep
                  .grep({
                    cwd: info?.type === "Directory" ? target : path.dirname(target),
                    pattern: input.pattern,
                    file: info?.type === "File" ? path.basename(target) : undefined,
                    include: input.include,
                    limit: input.limit ?? Number.MAX_SAFE_INTEGER,
                  })
                  .pipe(
                    Effect.map((result) =>
                      result.map((match) =>
                        FileSystem.Match.make({
                          ...match,
                          entry: FileSystem.Entry.make({
                            ...match.entry,
                            path: RelativePath.make(
                              path.relative(
                                location.directory,
                                path.resolve(
                                  info?.type === "Directory" ? target : path.dirname(target),
                                  match.entry.path,
                                ),
                              ),
                            ),
                          }),
                        }),
                      ),
                    ),
                  )
              }).pipe(Effect.mapError(() => new ToolFailure({ message: `Unable to grep for ${input.pattern}` }))),
          }),
        ),
      })
      .pipe(Effect.orDie)
  }),
)
