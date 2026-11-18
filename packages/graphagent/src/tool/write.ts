import { Schema } from "effect"
import * as path from "path"
import { Effect } from "effect"
import * as Tool from "./tool"
import { LSP } from "@/lsp/lsp"
import { createTwoFilesPatch } from "diff"
import DESCRIPTION from "./write.txt"
import { EventV2Bridge } from "@/event-v2-bridge"
import { FileSystem } from "@graphagent/core/filesystem"
import { Watcher } from "@graphagent/core/filesystem/watcher"
import { Format } from "../format"
import { FSUtil } from "@graphagent/core/fs-util"
import { InstanceState } from "@/effect/instance-state"
import { convertToLineEnding, detectLineEnding, normalizeLineEndings, trimDiff } from "./edit"
import { assertExternalDirectoryEffect } from "./external-directory"
import * as Bom from "@/util/bom"
import { FileState } from "@/session/file-state"
import type { SessionID } from "@/session/schema"

export const Parameters = Schema.Struct({
  content: Schema.String.annotate({ description: "The content to write to the file" }),
  filePath: Schema.String.annotate({
    description: "Path to the file to write; relative paths resolve from the project directory",
  }),
})

/** An overwrite keeps the line ending the file already had. */
const keepLineEnding = (text: string, previous: string) =>
  convertToLineEnding(normalizeLineEndings(text), detectLineEnding(previous))

export const WriteTool = Tool.define(
  "write",
  Effect.gen(function* () {
    const lsp = yield* LSP.Service
    const fs = yield* FSUtil.Service
    const events = yield* EventV2Bridge.Service
    const format = yield* Format.Service
    const fileState = yield* FileState.Service

    // Replacing an existing file needs a read of its current content in this session. The bytes read here are what
    // the call plans against: they are checked against the session's record, and kept as the call's own baseline
    // for the check under the path lock.
    const readOverwriteTarget = Effect.fnUntraced(function* (sessionID: SessionID, filepath: string) {
      const info = yield* fs.stat(filepath)
      if (info.type === "Directory") yield* Effect.fail(new Error(FileState.directoryMessage(filepath)))
      if (Number(info.size) > FileState.MAX_EDITABLE_BYTES)
        yield* Effect.fail(new Error(FileState.tooLargeMessage(filepath)))
      const bytes = yield* fs.readFile(filepath)
      const baseline = FileState.baselineOf(bytes)
      yield* fileState.requireRead(sessionID, filepath, baseline)
      return { ...Bom.decodeEditable(bytes, filepath), baseline }
    })

    // Under the path lock, the disk must still hold what the call planned against: the bytes it read, or no file at
    // all. The question that was asked in between could have taken a while, and another call of this session may
    // have replaced the file and the session's record meanwhile, so the call's own baseline decides, not the record.
    const requireUnchanged = Effect.fnUntraced(function* (filepath: string, baseline: FileState.Baseline | undefined) {
      if (baseline) yield* fileState.requireBaseline(filepath, baseline)
      else if (yield* fs.existsSafe(filepath))
        yield* Effect.fail(new Error(FileState.changedWhileAskingMessage(filepath)))
    })

    return {
      description: DESCRIPTION,
      effects: "workspace_write",
      parameters: Parameters,
      execute: (params: { content: string; filePath: string }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const filepath = path.isAbsolute(params.filePath)
            ? params.filePath
            : path.join(instance.directory, params.filePath)
          yield* assertExternalDirectoryEffect(ctx, filepath)

          const exists = yield* fs.existsSafe(filepath)
          const target = exists ? yield* readOverwriteTarget(ctx.sessionID, filepath) : undefined
          const source = target ?? { bom: false, text: "" }
          const next = Bom.split(params.content)
          const desiredBom = source.bom || next.bom
          const contentOld = source.text
          let contentNew = exists ? keepLineEnding(next.text, contentOld) : next.text

          const diff = trimDiff(createTwoFilesPatch(filepath, filepath, contentOld, contentNew))
          yield* ctx.ask({
            permission: "edit",
            patterns: [path.relative(instance.worktree, filepath)],
            always: ["*"],
            metadata: {
              filepath,
              diff,
            },
          })

          yield* FileState.withLocks([filepath])(
            Effect.gen(function* () {
              yield* requireUnchanged(filepath, target?.baseline)
              yield* fs.writeWithDirs(filepath, Bom.join(contentNew, desiredBom))
              if (yield* format.file(filepath)) {
                // Keep the post-format text: diagnostics and afterEdit use disk line
                // coordinates, so the pre-format snapshot would hide moved errors.
                contentNew = yield* Bom.syncFile(fs, filepath, desiredBom)
              }
              yield* fileState.record(ctx.sessionID, filepath, "write")
              yield* events.publish(FileSystem.Event.Edited, { file: filepath })
              yield* events.publish(Watcher.Event.Updated, {
                file: filepath,
                event: exists ? "change" : "add",
              })
            }),
          )

          let output = "Wrote file successfully."
          yield* lsp.touchFile(filepath, "document")
          const diagnostics = yield* lsp.diagnostics()
          const normalizedFilepath = FSUtil.normalizePath(filepath)
          // Writing one file cannot fix or break errors in other files; repeat
          // only the errors the written lines are responsible for.
          const block = LSP.Diagnostic.afterEdit(
            filepath,
            diagnostics[normalizedFilepath] ?? [],
            contentOld,
            contentNew,
          )
          if (block) output += `\n\nLSP errors detected in this file, please fix:\n${block}`

          return {
            title: path.relative(instance.worktree, filepath),
            metadata: {
              diagnostics,
              filepath,
              exists: exists,
            },
            output,
          }
        }).pipe(Effect.orDie),
    }
  }),
)
