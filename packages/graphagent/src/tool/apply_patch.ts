import * as path from "path"
import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Watcher } from "@graphagent/core/filesystem/watcher"
import { InstanceState } from "@/effect/instance-state"
import { Patch } from "../patch"
import { createTwoFilesPatch, diffLines } from "diff"
import { assertExternalDirectoryEffect } from "./external-directory"
import { trimDiff } from "./edit"
import { LSP } from "@/lsp/lsp"
import { FSUtil } from "@graphagent/core/fs-util"
import DESCRIPTION from "./apply_patch.txt"
import { FileSystem } from "@graphagent/core/filesystem"
import { Format } from "../format"
import * as Bom from "@/util/bom"
import { FileState } from "@/session/file-state"
import type { SessionID } from "@/session/schema"
import { addCorrections } from "@graphagent/core/session/outcome"
import { Receipt } from "./receipt"
import { WriteReceipt } from "./write-receipt"

export const Parameters = Schema.Struct({
  patchText: Schema.String.annotate({ description: "The full patch text that describes all changes to be made" }),
})

/** One file's part of a patch, planned before the question is asked and checked again under the path locks. */
interface FileChange {
  filePath: string
  oldContent: string
  newContent: string
  type: "add" | "update" | "delete" | "move"
  movePath?: string
  diff: string
  /**
   * The hunks of the diff, which the receipt and the language-server check are made from when the formatter leaves the
   * text as it was written.
   */
  changes?: WriteReceipt.Changes
  additions: number
  deletions: number
  bom: boolean
  /** BOM of the file as read; the source for update, move and delete, the file it replaces for an add over one. */
  oldBom: boolean
  /**
   * The add or move target as the call saw it, when it existed and the session had read it. The call's own
   * baseline, compared with the disk under the locks: the session's record may have been replaced by then.
   */
  targetBaseline?: FileState.Baseline
  /**
   * A move onto a file that exists: the text of that file, which the move replaces, for the receipt to compare the new
   * text with. `oldContent` stays the source's, which `recheck` checks and the language-server check measures from.
   */
  overwritten?: string
  /** Under the locks: the source no longer matched the session's last record of it. */
  outside: boolean
  /** Under the locks: the formatter changed the text after it was written. */
  reformatted: boolean
}

export const ApplyPatchTool = Tool.define(
  "apply_patch",
  Effect.gen(function* () {
    const lsp = yield* LSP.Service
    const afs = yield* FSUtil.Service
    const format = yield* Format.Service
    const events = yield* EventV2Bridge.Service
    const fileState = yield* FileState.Service

    // Every refusal of this tool reads "apply_patch verification failed: ...", whichever check raised it.
    const verificationFailed = (message: string) => new Error(`apply_patch verification failed: ${message}`)
    const changedWhileAsking = (target: string) => verificationFailed(FileState.changedWhileAskingMessage(target))

    // Add File and Move replace an existing target, which the session must have read in its current state. Returns
    // the target as seen here (the call's baseline for the check under the locks), or undefined when it does not
    // exist. The record is checked against that same observation.
    const requireOverwriteRead = Effect.fnUntraced(function* (sessionID: SessionID, target: string) {
      if (!(yield* afs.existsSafe(target))) return undefined
      const baseline = yield* fileState.baseline(target)
      yield* fileState
        .requireRead(sessionID, target, baseline)
        .pipe(Effect.mapError((error) => verificationFailed(error.message)))
      return baseline
    })

    // The text an Add File or a Move replaces, for the diff and the receipt only. It is never written back, so it is
    // decoded leniently: a file that is not UTF-8 can still be overwritten. A target above the size `write` loads is
    // not read, and one that cannot be read has no text either; the receipt then has nothing to compare with, as it
    // had nothing before. Whether the disk still holds what the call saw is decided under the locks, not here.
    const readOverwritten = Effect.fnUntraced(function* (target: string, baseline: FileState.Baseline | undefined) {
      if (!baseline || baseline.size > FileState.MAX_EDITABLE_BYTES) return undefined
      return yield* Bom.readFile(afs, target).pipe(Effect.catch(() => Effect.succeed(undefined)))
    })

    // Under the path locks the disk must still hold what the call planned against: an add or move target as the
    // call saw it, or still absent, and a source file with the content the patch was derived from.
    const requireTargetUnchanged = Effect.fnUntraced(function* (
      target: string,
      baseline: FileState.Baseline | undefined,
    ) {
      if (baseline)
        yield* fileState.requireBaseline(target, baseline).pipe(Effect.mapError(() => changedWhileAsking(target)))
      else if (yield* afs.existsSafe(target)) yield* Effect.fail(changedWhileAsking(target))
    })

    // Every check runs before the first write, so a patch that fails here leaves the tree as it was.
    const recheck = Effect.fnUntraced(function* (sessionID: SessionID, changes: ReadonlyArray<FileChange>) {
      for (const change of changes) {
        if (change.type === "add") {
          yield* requireTargetUnchanged(change.filePath, change.targetBaseline)
          continue
        }
        const read = change.type === "delete" ? Bom.readFile : Bom.readEditableFile
        const current = yield* read(afs, change.filePath).pipe(
          Effect.catchIf(
            (error) => "reason" in error && error.reason._tag === "NotFound",
            () => Effect.fail(changedWhileAsking(change.filePath)),
          ),
        )
        if (current.text !== change.oldContent || current.bom !== change.oldBom) {
          yield* Effect.fail(changedWhileAsking(change.filePath))
        }
        if (change.type !== "delete") {
          change.outside = (yield* fileState.verify(sessionID, change.filePath)) === "changed"
        }
        if (change.movePath) yield* requireTargetUnchanged(change.movePath, change.targetBaseline)
      }
    })

    const run = Effect.fn("ApplyPatchTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      if (!params.patchText) {
        return yield* Effect.fail(new Error("patchText is required"))
      }

      // Parse the patch to get hunks
      let hunks: Patch.Hunk[]
      try {
        const parseResult = Patch.parsePatch(params.patchText)
        hunks = parseResult.hunks
      } catch (error) {
        return yield* Effect.fail(new Error(`apply_patch verification failed: ${error}`))
      }

      if (hunks.length === 0) {
        const normalized = params.patchText.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim()
        if (normalized === "*** Begin Patch\n*** End Patch") {
          return yield* Effect.fail(new Error("patch rejected: empty patch"))
        }
        return yield* Effect.fail(new Error("apply_patch verification failed: no hunks found"))
      }

      const instance = yield* InstanceState.context

      // Validate file paths and check permissions
      const fileChanges: FileChange[] = []

      let totalDiff = ""

      for (const hunk of hunks) {
        const filePath = path.resolve(instance.directory, hunk.path)
        yield* assertExternalDirectoryEffect(ctx, filePath)

        switch (hunk.type) {
          case "add": {
            const targetBaseline = yield* requireOverwriteRead(ctx.sessionID, filePath)
            // An Add File over a file that exists replaces its text: the diff and the receipt are made against it.
            const replaced = yield* readOverwritten(filePath, targetBaseline)
            const oldContent = replaced?.text ?? ""
            const newContent =
              hunk.contents.length === 0 || hunk.contents.endsWith("\n") ? hunk.contents : `${hunk.contents}\n`
            const next = Bom.split(newContent)
            const planned = WriteReceipt.unifiedDiff(filePath, oldContent, next.text)
            const diff = trimDiff(planned.text)

            let additions = 0
            let deletions = 0
            for (const change of diffLines(oldContent, next.text)) {
              if (change.added) additions += change.count || 0
              if (change.removed) deletions += change.count || 0
            }

            fileChanges.push({
              filePath,
              oldContent,
              newContent: next.text,
              type: "add",
              diff,
              changes: planned.changes,
              additions,
              deletions,
              bom: next.bom,
              oldBom: replaced?.bom ?? false,
              targetBaseline,
              outside: false,
              reformatted: false,
            })

            totalDiff += diff + "\n"
            break
          }

          case "update": {
            // Check if file exists for update
            const stats = yield* afs.stat(filePath).pipe(
              Effect.catchIf(
                (error) => "reason" in error && error.reason._tag === "NotFound",
                () => Effect.succeed(undefined),
              ),
            )
            if (!stats || stats.type === "Directory") {
              return yield* Effect.fail(
                new Error(
                  `apply_patch verification failed: Failed to read file to update: ${filePath}. Check the path with glob.`,
                ),
              )
            }

            const source = yield* Bom.readEditableFile(afs, filePath)
            const oldContent = source.text
            let newContent = oldContent
            let bom = source.bom

            // Apply the update chunks to get new content
            try {
              const fileUpdate = Patch.deriveNewContentsFromChunks(
                filePath,
                hunk.chunks,
                Bom.join(source.text, source.bom),
              )
              newContent = fileUpdate.content
              bom = fileUpdate.bom
            } catch (error) {
              return yield* Effect.fail(new Error(`apply_patch verification failed: ${error}`))
            }

            const planned = WriteReceipt.unifiedDiff(filePath, oldContent, newContent)
            const diff = trimDiff(planned.text)

            let additions = 0
            let deletions = 0
            for (const change of diffLines(oldContent, newContent)) {
              if (change.added) additions += change.count || 0
              if (change.removed) deletions += change.count || 0
            }

            const target = hunk.move_path ? path.resolve(instance.directory, hunk.move_path) : undefined
            // Moving onto itself is an in-place update; as a move it would write
            // the file and then remove it.
            const movePath =
              target && FSUtil.normalizePath(target) !== FSUtil.normalizePath(filePath) ? target : undefined
            yield* assertExternalDirectoryEffect(ctx, movePath)
            const targetBaseline = movePath ? yield* requireOverwriteRead(ctx.sessionID, movePath) : undefined
            // A move onto a file that exists replaces it: the receipt compares with its text, not with the source's.
            const replaced = movePath ? yield* readOverwritten(movePath, targetBaseline) : undefined

            fileChanges.push({
              filePath,
              oldContent,
              newContent,
              type: movePath ? "move" : "update",
              movePath,
              diff,
              changes: planned.changes,
              additions,
              deletions,
              bom,
              oldBom: source.bom,
              targetBaseline,
              overwritten: replaced?.text,
              outside: false,
              reformatted: false,
            })

            totalDiff += diff + "\n"
            break
          }

          case "delete": {
            const source = yield* Bom.readFile(afs, filePath).pipe(
              Effect.catch((error) =>
                Effect.fail(
                  new Error(
                    `apply_patch verification failed: ${error instanceof Error ? error.message : String(error)}`,
                  ),
                ),
              ),
            )
            const contentToDelete = source.text
            const deleteDiff = trimDiff(createTwoFilesPatch(filePath, filePath, contentToDelete, ""))

            const deletions = contentToDelete.split("\n").length

            fileChanges.push({
              filePath,
              oldContent: contentToDelete,
              newContent: "",
              type: "delete",
              diff: deleteDiff,
              additions: 0,
              deletions,
              bom: source.bom,
              oldBom: source.bom,
              outside: false,
              reformatted: false,
            })

            totalDiff += deleteDiff + "\n"
            break
          }
        }
      }

      // Build per-file metadata for UI rendering (used for both permission and result)
      const files = fileChanges.map((change) => ({
        filePath: change.filePath,
        relativePath: path.relative(instance.worktree, change.movePath ?? change.filePath).replaceAll("\\", "/"),
        type: change.type,
        patch: change.diff,
        additions: change.additions,
        deletions: change.deletions,
        // Only a move has a destination. The key is left out otherwise: an `undefined` value cannot be encoded as JSON.
        ...(change.movePath ? { movePath: change.movePath } : {}),
      }))

      // Check permissions if needed
      const relativePaths = fileChanges.map((c) => path.relative(instance.worktree, c.filePath).replaceAll("\\", "/"))
      yield* ctx.ask({
        permission: "edit",
        patterns: relativePaths,
        always: ["*"],
        metadata: {
          filepath: relativePaths.join(", "),
          diff: totalDiff,
          files,
        },
      })

      // The question was asked outside the locks. Under them, check once more that the disk still holds what the
      // patch was planned against, then write, format, record and publish.
      yield* FileState.withLocks(
        fileChanges.flatMap((change) => (change.movePath ? [change.filePath, change.movePath] : [change.filePath])),
      )(
        Effect.gen(function* () {
          yield* recheck(ctx.sessionID, fileChanges)

          // Apply the changes
          const updates: Array<{ file: string; event: "add" | "change" | "unlink" }> = []

          for (const change of fileChanges) {
            const edited = change.type === "delete" ? undefined : (change.movePath ?? change.filePath)
            switch (change.type) {
              case "add":
                // Create parent directories (recursive: true is safe on existing/root dirs)

                yield* afs.writeWithDirs(change.filePath, Bom.join(change.newContent, change.bom))
                updates.push({ file: change.filePath, event: "add" })
                break

              case "update":
                yield* afs.writeWithDirs(change.filePath, Bom.join(change.newContent, change.bom))
                updates.push({ file: change.filePath, event: "change" })
                break

              case "move":
                if (change.movePath) {
                  // Create parent directories (recursive: true is safe on existing/root dirs)

                  yield* afs.writeWithDirs(change.movePath!, Bom.join(change.newContent, change.bom))
                  yield* afs.remove(change.filePath)
                  updates.push({ file: change.filePath, event: "unlink" })
                  updates.push({ file: change.movePath, event: "add" })
                }
                break

              case "delete":
                yield* afs.remove(change.filePath)
                updates.push({ file: change.filePath, event: "unlink" })
                break
            }

            if (edited) {
              if (yield* format.file(edited)) {
                // afterEdit runs against diagnostics in post-format disk coordinates,
                // so retain the formatter's output rather than the patch snapshot.
                const written = change.newContent
                change.newContent = yield* Bom.syncFile(afs, edited, change.bom)
                change.reformatted = change.newContent !== written
              }
              yield* fileState.record(ctx.sessionID, edited, "apply_patch")
              yield* events.publish(FileSystem.Event.Edited, { file: edited })
            }
          }

          // Publish file change events
          for (const update of updates) {
            yield* events.publish(Watcher.Event.Updated, update)
          }
        }),
      )

      // Notify LSP of file changes and collect diagnostics. Each touch may wait
      // up to the diagnostics timeout, so files settle concurrently rather than
      // stacking one wait per file.
      const checked = yield* Effect.forEach(
        fileChanges.filter((change) => change.type !== "delete"),
        (change) =>
          lsp
            .touchFile(change.movePath ?? change.filePath, "document")
            .pipe(Effect.map((status) => ({ change, status }))),
        { concurrency: 8 },
      )
      const diagnostics = yield* lsp.diagnostics()

      // Generate output summary
      const summaryLines = fileChanges.map((change) => {
        if (change.type === "add") {
          // An Add File over a file that existed replaced it.
          const mark = change.targetBaseline ? "M" : "A"
          return `${mark} ${path.relative(instance.worktree, change.filePath).replaceAll("\\", "/")}`
        }
        if (change.type === "delete") {
          return `D ${path.relative(instance.worktree, change.filePath).replaceAll("\\", "/")}`
        }
        const target = change.movePath ?? change.filePath
        return `M ${path.relative(instance.worktree, target).replaceAll("\\", "/")}`
      })
      let output = `Success. Updated the following files:\n${summaryLines.join("\n")}`
      for (const change of fileChanges) {
        if (!change.outside) continue
        const shown = path.relative(instance.worktree, change.movePath ?? change.filePath).replaceAll("\\", "/")
        output += `\n${FileState.changedOutsideNote(shown)}`
      }

      // Each written file gets a receipt block, after the summary, and a status line after all of those, ahead of the
      // error blocks. The diffs of the blocks share one budget of lines. The title keeps the result as it was before
      // the receipt blocks and the status lines.
      const head = output
      const receiptBlocks: string[] = []
      const statusLines: string[] = []
      let blocks = ""
      let budget = WriteReceipt.DIFF_LINES
      for (const { change, status } of checked) {
        const target = change.movePath ?? change.filePath
        const rel = path.relative(instance.worktree, target).replaceAll("\\", "/")
        // The diff of the plan is the diff of the text on disk unless the formatter changed it.
        const changes = change.reformatted ? undefined : change.changes
        // A move onto a file that existed replaces it, so its receipt compares with that file's text, which the plan did
        // not diff: its diff is of the source, and only the language-server check below uses it.
        let receiptChanges = changes
        if (changes && change.overwritten !== undefined) {
          receiptChanges = WriteReceipt.unifiedDiff(target, change.overwritten, change.newContent).changes
        }
        const receipt = WriteReceipt.writeReceipt({
          file: target,
          oldText: change.overwritten ?? change.oldContent,
          newText: change.newContent,
          reformatted: change.reformatted,
          diffBudget: budget,
          changes: receiptChanges,
        })
        budget -= receipt.diffLines
        if (receipt.text) receiptBlocks.push(`${rel}\n${receipt.text}`)
        const issues = diagnostics[FSUtil.normalizePath(target)] ?? []
        // The status line and the report share the written lines, which are worked out once and only for an error.
        const ranges = WriteReceipt.lazyRanges(target, change.oldContent, change.newContent, changes)
        const line = LSP.Diagnostic.checkLine(status, target, issues, ranges)
        statusLines.push(`${rel}: ${line}`)
        const block = LSP.Diagnostic.afterEdit(target, issues, ranges)
        if (block) blocks += `\n\nLSP errors detected in ${rel}, please fix:\n${block}`
      }
      const title = head + blocks
      const parts = [head, ...receiptBlocks, ...(statusLines.length > 0 ? [statusLines.join("\n")] : [])]
      output = parts.join("\n\n") + blocks
      const reformatted = fileChanges.some((change) => change.reformatted)
      if (reformatted) yield* Receipt.logCorrection("apply_patch", "formatted")

      return {
        title,
        metadata: addCorrections({ diff: totalDiff, files, diagnostics }, ...(reformatted ? ["formatted"] : [])),
        output,
      }
    })

    return {
      description: DESCRIPTION,
      effects: "workspace_write",
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
