import type { Session as SDKSession, Message, Part } from "@graphagent/sdk"
import { SessionV1 } from "@graphagent/core/v1/session"
import { Session } from "@/session/session"
import { MessageV2 } from "../../session/message-v2"
import { CliError, effectCmd } from "../effect-cmd"
import { Database } from "@graphagent/core/database/database"
import { SessionTable, MessageTable, PartTable } from "@graphagent/core/session/sql"
import { InstanceRef } from "@/effect/instance-ref"
import { EOL } from "os"
import path from "path"
import { FSUtil } from "@graphagent/core/fs-util"
import { Effect, Schema } from "effect"
import type { InstanceContext } from "@/project/instance-context"

const decodeMessageInfo = Schema.decodeUnknownSync(SessionV1.Info)
const decodePart = Schema.decodeUnknownSync(SessionV1.Part)

export function formatImportFileError(file: string, error: FSUtil.Error) {
  if (error._tag === "PlatformError") {
    if (error.reason._tag === "NotFound") return `File not found: ${file}`
    if (error.reason._tag === "PermissionDenied") return `Failed to read file: Permission denied`
    return `Failed to read file: ${error.message}`
  }

  const detail = error.cause instanceof Error ? error.cause.message : error.message
  return `Invalid JSON in ${file}: ${detail}`
}

type ExportData = { info: SDKSession; messages: Array<{ info: Message; parts: Part[] }> }

export const ImportCommand = effectCmd({
  command: "import <file>",
  describe: "import session data from JSON file",
  builder: (yargs) =>
    yargs.positional("file", {
      describe: "path to JSON file",
      type: "string",
      demandOption: true,
    }),
  handler: Effect.fn("Cli.import")(function* (args) {
    const ctx = yield* InstanceRef
    if (!ctx) return yield* Effect.die("InstanceRef not provided")
    return yield* runImport(args.file, ctx)
  }),
})

const runImport = Effect.fn("Cli.import.body")(function* (file: string, ctx: InstanceContext) {
  const fs = yield* FSUtil.Service
  const { db } = yield* Database.Service

  const exportData = (yield* fs
    .readJson(file)
    .pipe(Effect.mapError((error) => new CliError({ message: formatImportFileError(file, error) })))) as ExportData

  const info = Schema.decodeUnknownSync(Session.Info)({
    ...exportData.info,
    projectID: ctx.project.id,
    directory: ctx.directory,
    path: path.relative(path.resolve(ctx.worktree), ctx.directory).replaceAll("\\", "/"),
  }) as Session.Info
  const row = Session.toRow(info)
  yield* db
    .insert(SessionTable)
    .values(row)
    .onConflictDoUpdate({
      target: SessionTable.id,
      set: { project_id: row.project_id, directory: row.directory, path: row.path },
    })
    .run()
    .pipe(Effect.orDie)

  for (const msg of exportData.messages) {
    const msgInfo = decodeMessageInfo(msg.info) as SessionV1.Info
    const { id, sessionID: _, ...msgData } = msgInfo
    yield* db
      .insert(MessageTable)
      .values({
        id,
        session_id: row.id,
        time_created: msgInfo.time?.created ?? Date.now(),
        data: msgData as never,
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)

    for (const part of msg.parts) {
      const partInfo = decodePart(part) as SessionV1.Part
      const { id: partId, sessionID: _s, messageID, ...partData } = partInfo
      yield* db
        .insert(PartTable)
        .values({
          id: partId,
          message_id: messageID,
          session_id: row.id,
          data: partData,
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
    }
  }

  process.stdout.write(`Imported session: ${exportData.info.id}`)
  process.stdout.write(EOL)
})
