import { Schema } from "effect"

export const decodeRecord = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))
export const decodeRecords = Schema.decodeUnknownSync(Schema.Array(Schema.Record(Schema.String, Schema.Unknown)))
export const decodeString = Schema.decodeUnknownSync(Schema.String)
export const decodeSession = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }))
export const decodeV2Session = Schema.decodeUnknownSync(Schema.Struct({ data: Schema.Struct({ id: Schema.String }) }))
export const decodeV2Record = Schema.decodeUnknownSync(
  Schema.Struct({ data: Schema.Record(Schema.String, Schema.Unknown) }),
)
export const decodeV2Context = Schema.decodeUnknownSync(
  Schema.Struct({ data: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)) }),
)
export const decodeNames = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ name: Schema.String })))
export const decodeJsonRecord = (text: string) => decodeRecord(JSON.parse(text))

export const decodeOptionalRecord = Schema.decodeUnknownSync(
  Schema.UndefinedOr(Schema.Record(Schema.String, Schema.Unknown)),
)
