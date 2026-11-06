export * as MemorySchema from "./schema"

import { Schema } from "effect"

export const SCHEMA_VERSION = 1
export const MIN_TOPIC_LIMIT = 10
export const MAX_TOPIC_LIMIT = 100
export const MIN_TURN_INTERVAL = 1
export const MAX_TURN_INTERVAL = 20
export const MAX_INJECTION_TOPICS = 3
export const MAX_INJECTION_TOKENS = 1_200

const StableID = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isBetweenLength(1, 80),
  Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
)
const ShortText = Schema.String.check(Schema.isTrimmed(), Schema.isBetweenLength(1, 300))
const ItemText = Schema.String.check(Schema.isTrimmed(), Schema.isBetweenLength(1, 1_000))
const Timestamp = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u))
const NonNegativeInteger = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
const PositiveInteger = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1))

export const Kind = Schema.Literals(["preference", "decision", "term"])
export type Kind = typeof Kind.Type

export class Injection extends Schema.Class<Injection>("MemoryInjection")({
  max_topics: Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: MAX_INJECTION_TOPICS })),
  max_tokens: Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 200, maximum: MAX_INJECTION_TOKENS })),
}) {}

export class Config extends Schema.Class<Config>("MemoryConfig")({
  schema_version: Schema.Literal(SCHEMA_VERSION),
  enabled: Schema.Boolean,
  model: Schema.String.check(Schema.isTrimmed(), Schema.isBetweenLength(3, 240), Schema.isPattern(/^[^/\s]+\/.+$/u)),
  topic_limit: Schema.Number.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: MIN_TOPIC_LIMIT, maximum: MAX_TOPIC_LIMIT }),
  ),
  turn_interval: Schema.Number.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: MIN_TURN_INTERVAL, maximum: MAX_TURN_INTERVAL }),
  ),
  injection: Injection,
}) {}

export function updateConfig(
  config: Config,
  updates: { enabled?: boolean; model?: string },
) {
  return new Config({
    schema_version: config.schema_version,
    enabled: updates.enabled ?? config.enabled,
    model: updates.model ?? config.model,
    topic_limit: config.topic_limit,
    turn_interval: config.turn_interval,
    injection: config.injection,
  })
}

export class TopicItem extends Schema.Class<TopicItem>("MemoryTopicItem")({
  id: StableID,
  kind: Kind,
  content: ItemText,
  rationale: ItemText,
  confirmed_at: Timestamp,
}) {}

export class TopicMetadata extends Schema.Class<TopicMetadata>("MemoryTopicMetadata")({
  categories: Schema.Array(Kind).check(Schema.isBetweenLength(1, 3)),
  status: Schema.Literal("active"),
  importance: Schema.Literal("core"),
  keywords: Schema.Array(ShortText).check(Schema.isMaxLength(20)),
  related_topics: Schema.Array(StableID).check(Schema.isMaxLength(20)),
  created_at: Timestamp,
  updated_at: Timestamp,
  last_matched_at: Schema.NullOr(Timestamp),
  match_count: NonNegativeInteger,
  revision: PositiveInteger,
  item_count: NonNegativeInteger,
}) {}

export class Topic extends Schema.Class<Topic>("MemoryTopic")({
  schema_version: Schema.Literal(SCHEMA_VERSION),
  id: StableID,
  name: ShortText,
  summary: ShortText,
  metadata: TopicMetadata,
  items: Schema.Array(TopicItem).check(Schema.isMinLength(1)),
}) {}

export class TopicIndex extends Schema.Class<TopicIndex>("MemoryTopicIndex")({
  id: StableID,
  name: ShortText,
  summary: ShortText,
  categories: Schema.Array(Kind),
  importance: Schema.Literal("core"),
  keywords: Schema.Array(ShortText),
  related_topics: Schema.Array(StableID),
  updated_at: Timestamp,
  last_matched_at: Schema.NullOr(Timestamp),
  match_count: NonNegativeInteger,
  revision: PositiveInteger,
  item_count: PositiveInteger,
}) {}

class SemanticItem extends Schema.Class<SemanticItem>("MemorySemanticItem")({
  kind: Kind,
  content: ItemText,
  rationale: ItemText,
}) {}

class CreateTopic extends Schema.Class<CreateTopic>("MemoryCreateTopic")({
  type: Schema.Literal("create_topic"),
  name: ShortText,
  summary: ShortText,
  categories: Schema.Array(Kind).check(Schema.isBetweenLength(1, 3)),
  keywords: Schema.Array(ShortText).check(Schema.isMaxLength(20)),
  related_topics: Schema.Array(StableID).check(Schema.isMaxLength(20)),
  item: SemanticItem,
}) {}

class UpsertItem extends Schema.Class<UpsertItem>("MemoryUpsertItem")({
  type: Schema.Literal("upsert_item"),
  topic_id: StableID,
  item_id: Schema.optional(StableID),
  item: SemanticItem,
}) {}

class DeleteItem extends Schema.Class<DeleteItem>("MemoryDeleteItem")({
  type: Schema.Literal("delete_item"),
  topic_id: StableID,
  item_id: StableID,
}) {}

class UpdateTopic extends Schema.Class<UpdateTopic>("MemoryUpdateTopic")({
  type: Schema.Literal("update_topic"),
  topic_id: StableID,
  name: Schema.optional(ShortText),
  summary: Schema.optional(ShortText),
  categories: Schema.optional(Schema.Array(Kind).check(Schema.isBetweenLength(1, 3))),
  keywords: Schema.optional(Schema.Array(ShortText).check(Schema.isMaxLength(20))),
  related_topics: Schema.optional(Schema.Array(StableID).check(Schema.isMaxLength(20))),
}) {}

class DeleteTopic extends Schema.Class<DeleteTopic>("MemoryDeleteTopic")({
  type: Schema.Literal("delete_topic"),
  topic_id: StableID,
}) {}

class NoChange extends Schema.Class<NoChange>("MemoryNoChange")({
  type: Schema.Literal("no_change"),
}) {}

export const MaintenanceAction = Schema.Union([CreateTopic, UpsertItem, DeleteItem, UpdateTopic, DeleteTopic, NoChange])
export type MaintenanceAction = typeof MaintenanceAction.Type

export class MaintenanceResponse extends Schema.Class<MaintenanceResponse>("MemoryMaintenanceResponse")({
  actions: Schema.Array(MaintenanceAction).check(Schema.isMaxLength(20)),
}) {}

export class MatchResponse extends Schema.Class<MatchResponse>("MemoryMatchResponse")({
  topic_ids: Schema.Array(StableID).check(Schema.isMaxLength(MAX_INJECTION_TOPICS)),
}) {}

export function topicIndex(topic: Topic): TopicIndex {
  return {
    id: topic.id,
    name: topic.name,
    summary: topic.summary,
    categories: topic.metadata.categories,
    importance: topic.metadata.importance,
    keywords: topic.metadata.keywords,
    related_topics: topic.metadata.related_topics,
    updated_at: topic.metadata.updated_at,
    last_matched_at: topic.metadata.last_matched_at,
    match_count: topic.metadata.match_count,
    revision: topic.metadata.revision,
    item_count: topic.metadata.item_count,
  }
}
