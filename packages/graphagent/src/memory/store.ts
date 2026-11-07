export * as MemoryStore from "./store"

import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ProjectV2 } from "@opencode-ai/core/project"
import { Context, Effect, Layer, Option, Schema, Types } from "effect"
import { basename, join } from "node:path"
import { randomUUID } from "node:crypto"
import { ulid } from "ulid"
import { parse, stringify } from "yaml"
import { MemoryFile } from "./file"
import { MemoryHome } from "./home"
import { MemorySchema } from "./schema"

const TOPIC_KEYS = ["schema_version", "id", "name", "summary", "metadata", "items"] as const
const METADATA_KEYS = [
  "categories",
  "status",
  "importance",
  "keywords",
  "related_topics",
  "created_at",
  "updated_at",
  "last_matched_at",
  "match_count",
  "revision",
  "item_count",
] as const
const ITEM_KEYS = ["id", "kind", "content", "rationale", "confirmed_at"] as const

// Keep a few recent generations on disk: a reader holding a just-published
// manifest must still find its generation after later commits GC older ones.
const RETAINED_GENERATIONS = 3

const PROHIBITED_CONTENT = [
  /```|`[^`]+`/,
  /(?:^|\s)(?:~\/|\.\.?\/|\/)[^\s]+/,
  /(?:^|[/\\])(?:src|packages|lib|test|tests|docs?)(?:[/\\]|$)/i,
  /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|swift|rb|php|cs|sql|sh|ya?ml|jsonc?|md)(?:\b|$)/i,
  /\b(?:function|class|interface|import|export|const|let|var|return|stack trace|expected|actual)\b/i,
  /\b(?:def|fn|func|struct|enum|async|await|lambda|yield|pass|break|continue|raise|throw|switch|case|catch|public|private|protected|static|void)\b/i,
  /^\s*(?:if|for|while|try|with|match)\b.*:\s*(?:break|continue|pass|return|raise)?/i,
  /^\s*(?:echo|cd|pwd|ls|find|grep|rg|cat|head|tail|cp|mv|rm|mkdir|touch|chmod|chown|curl|wget|git|docker|kubectl|sudo)\b/i,
  /^\s*(?:python\d*|node|deno|bun|ruby|perl|php|java|javac|go|rustc|cargo|sh|bash|zsh|fish|pwsh|powershell|cmd|awk|sed|make|cmake|ninja)\b/i,
  /(?:^|\s)--?[A-Za-z][\w-]*\b/,
  /(?:^|\s)(?:\d?>|<)\s*\S|[;&|]/,
  /\b[a-z_$][\w$]*\s*\([^)]*\)/i,
  /(?:^|\s)[a-z_$][\w$]*\s*(?:\+|\*|%|==|!=|<=|>=|\+=|-=|\*=)\s*[a-z0-9_$]+(?:\s|$)/i,
  /(?:^|\s)[a-z_$][\w$]*\s+-\s+[a-z0-9_$]+(?:\s|$)/i,
  /\b(?:select\b.+\bfrom|insert\s+into|update\s+\w+\s+set|delete\s+from|create\s+(?:table|index)|alter\s+table|drop\s+(?:table|index))\b/i,
  /^\s*(?:select|insert|update|delete|create|alter|drop|merge|with|pragma)\b/i,
  /\b(?:console\.log|print|printf|system\.out\.println)\s*\(/i,
  /\b[a-z_$][\w$]*\.[a-z_$][\w$]*\b/i,
  /\b[A-Z][A-Za-z0-9]*(?:Service|Controller|Handler|Schema|Interface|API)\b/,
  /=>|[{}<>]|\(\)\s*;|::/,
  /(?:^|\s)[a-z_$][\w$]*\s*=\s*(?!=)/i,
  /\b(?:npm|bun|pnpm|yarn|pip|cargo)\s+(?:add|install|run|test|build)\b/i,
  /\b(?:AGENTS\.md|CLAUDE\.md|README|TODO|roadmap|milestone|sprint|goal|plan|progress|next step)\b/i,
  /\b(?:we|i|you|the team)\s+(?:should|need(?:s)?\s+to|will|plan(?:s)?\s+to|intend(?:s)?\s+to)\b/i,
  /(?:计划|目标|待办|进度|下一步|临时|当前状态|承诺|稍后)/,
  /\b(?:repository|repo|codebase)\s+(?:currently\s+)?(?:uses?|depends?|contains?|has|implements?|imports?|exports?|is\s+(?:built|written))\b/i,
  /\bwe\s+(?:currently\s+)?(?:use|run|depend\s+on|implement|import|export)\b/i,
  /\b(?:frontend|backend|application|app|service|system)\s+(?:currently\s+)?(?:uses?|runs?|depends?|is\s+(?:powered|built|implemented|written))\b/i,
  /\b(?:powers?|backs?|implements?)\s+(?:the\s+)?(?:frontend|backend|application|app|service|system)\b/i,
  /\b[A-Za-z][A-Za-z0-9_.-]*\s+v?\d+(?:\.\d+){0,3}\b/,
  /(?:仓库|代码库)(?:当前|目前)?(?:使用|依赖|包含|拥有|采用|实现|导入|导出)/,
  /\b(?:dependency|dependencies|package version|runtime version|unit test|integration test|test case|log output|stderr|stdout|exit code)\b/i,
  /\b(?:according to|per) (?:the )?(?:docs?|documentation)\b|(?:文档|说明书)(?:中|里)?(?:规定|写明|说明|提到)/i,
  /\b(?:api[_-]?key|secret|password|access[_-]?token|private[_-]?key)\b/i,
  /\b(?:sk-(?:proj-)?|gh[pousr]_|github_pat_|AKIA)[A-Za-z0-9_-]{8,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/i,
  /(?:身份证|社会安全号码|银行卡号|信用卡号|家庭住址|手机号)/,
  /(?:病史|病历|诊断|患有|罹患|过敏|血型|基因|生物识别|指纹|面部识别|宗教|民族|种族|性取向|政治立场|收入|工资|财务状况|征信|护照|驾照|出生日期)/,
  /\b(?:medical|diagnos(?:is|ed)|disease|disability|depression|anxiety|religion|race|ethnicity|sexual orientation|political affiliation|biometric|fingerprint|passport|driver'?s license|salary|income|credit score|date of birth)\b/i,
  /\b(?:\d[ -]*?){13,19}\b/,
  /\b(?:SSN\s*)?\d{3}-\d{2}-\d{4}\b/i,
  /\b(?:phone|tel(?:ephone)?|mobile)\s*[:：]?\s*\+?[\d(). -]{7,}\b/i,
  /\b\d{3}[-.]\d{3}[-.]\d{4}\b/,
  /https?:\/\//i,
  /[\w.+-]+@[\w.-]+\.[a-z]{2,}/i,
] as const

// Credentials under any common label, enforced only when new or changed
// content is admitted (applyActions / isAllowedMemory*). Decoding persisted
// topics keeps PROHIBITED_CONTENT alone, so stores written under the earlier
// rules stay strictly readable and committable. A bare English "token" stays
// allowed ("token budget" is legitimate durable context); only credential-shaped
// token phrases are blocked. 令牌 likewise stays allowed in its usage senses.
const ADMISSION_CONTENT = [
  ...PROHIBITED_CONTENT,
  /\b(?:api[_\s-]?keys?|secrets?|passwords?|passwd|passphrases?|credentials?|private[_\s-]?keys?|(?:access|auth(?:entication)?|bearer|api|refresh|deploy|oauth|personal[_\s-]access)[_\s-]?tokens?)\b/i,
  /(?:密码|密钥|秘钥|私钥|口令|凭据|凭证|令牌(?!桶|预算|数|上限|限额|限制|计数|用量|消耗|配额))/,
] as const

type ContentRules = ReadonlyArray<RegExp>

const ITEM_INTENT = {
  preference:
    /^(?:(?:the\s+)?user\s+(?:prefers?|requires?|always|never)|(?:responses?|answers?)\s+(?:must|should|use|avoid)|用户(?:长期)?(?:偏好|要求)|回答(?:保持|使用|避免)|始终|永远|不要)/i,
  decision:
    /^(?:(?:confirmed\s+)?(?:core\s+)?decision\b|(?:we\s+)?(?:decided|adopted|selected|chose)\b|(?:已确认的?)?(?:核心)?(?:决定|决策)[:：]?|(?:长期)?(?:采用|选择|确定))/i,
  term: /(?:\bmeans\b|\brefers to\b|\bis defined as\b|(?:术语|名称).*(?:指|表示|定义)|定义为|称为)/i,
} as const

const DURABLE_CONFIRMATION =
  /(?:\buser\b.*\b(?:confirm(?:ed|s)?|explicit(?:ly)?|long[- ]term|stable|durable)|\b(?:confirm(?:ed|s)?|explicit(?:ly)?)\b.*\buser\b|用户.*(?:确认|明确|长期|稳定)|(?:确认|明确|长期|稳定).*用户)/i

export type Applied = {
  readonly topics: MemorySchema.Topic[]
  readonly changed: string[]
  readonly deleted: string[]
}

export type Update<A> = {
  readonly applied: Applied
  readonly result: A
}

export type Snapshot = {
  readonly revision: number
  readonly topics: MemorySchema.Topic[]
}

type MutableTopic = Types.DeepMutable<MemorySchema.Topic>

export interface Interface {
  readonly readTopics: (projectID: ProjectV2.ID) => Effect.Effect<MemorySchema.Topic[], FSUtil.Error>
  readonly readSnapshot: (
    projectID: ProjectV2.ID,
  ) => Effect.Effect<Snapshot, FSUtil.Error | StoreError>
  readonly commit: (
    projectID: ProjectV2.ID,
    expectedRevision: number,
    applied: Applied,
  ) => Effect.Effect<Snapshot, FSUtil.Error | StoreError | CommitConflictError | EffectFlock.LockError>
  readonly inspectTopics: (
    projectID: ProjectV2.ID,
  ) => Effect.Effect<MemorySchema.Topic[], FSUtil.Error | StoreError>
  readonly updateTopics: <A>(
    projectID: ProjectV2.ID,
    update: (topics: MemorySchema.Topic[]) => Update<A>,
  ) => Effect.Effect<
    Snapshot & { result: A },
    FSUtil.Error | StoreError | EffectFlock.LockError
  >
}

export class StoreError extends Schema.TaggedError<StoreError>()("MemoryStore.Error", {
  message: Schema.String,
}) {}

export class CommitConflictError extends Schema.TaggedError<CommitConflictError>()("MemoryStore.CommitConflict", {
  expected_revision: Schema.Number,
  actual_revision: Schema.Number,
}) {}

export class Service extends Context.Service<Service, Interface>()("@opencode/MemoryStore") {}

const Manifest = Schema.Struct({
  schema_version: Schema.Literal(1),
  revision: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  generation: Schema.String,
})
const ManifestJson = Schema.fromJsonString(Manifest)
const decodeManifest = Schema.decodeUnknownOption(ManifestJson)

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const flock = yield* EffectFlock.Service
    const home = yield* MemoryHome.Service

    const readDirectoryTopics = Effect.fnUntraced(function* (directory: string, strict = false) {
      if (!(yield* fs.existsSafe(directory))) return []
      const entries = yield* fs.readDirectoryEntries(directory)
      if (strict) {
        const unexpected = entries.filter((entry) => entry.type !== "file" || !entry.name.endsWith(".yaml"))
        if (unexpected.length > 0)
          return yield* new StoreError({
            message: `Memory topics directory contains unexpected entries: ${unexpected.map((entry) => entry.name).join(", ")}`,
          })
      }
      const names = entries
        .filter((entry) => entry.type === "file" && entry.name.endsWith(".yaml"))
        .map((entry) => entry.name)
        .sort()
      const topics = yield* Effect.forEach(
        names,
        (name) => {
          const read = Effect.gen(function* () {
            const file = join(directory, name)
            const text = yield* fs.readFileString(file)
            const value = yield* Effect.try({
              try: () => parse(text),
              catch: (cause) => new StoreError({ message: `Memory topic YAML parse failed: ${String(cause)}` }),
            })
            const decoded = decodeTopic(value, basename(name, ".yaml"))
            if (decoded) return decoded
            if (strict) return yield* new StoreError({ message: `Memory topic is invalid: ${file}` })
            yield* Effect.logWarning("memory topic is invalid — ignoring", { path: file })
            return undefined
          })
          if (strict) return read
          return read.pipe(
            Effect.catchCause((cause) =>
              Effect.gen(function* () {
                yield* Effect.logWarning("memory topic read failed — ignoring", { path: name, cause })
                return undefined
              }),
            ),
          )
        },
        { concurrency: 8 },
      )
      return topics.filter((topic): topic is MemorySchema.Topic => topic !== undefined)
    })

    const writeDirectoryTopics = Effect.fnUntraced(function* (directory: string, applied: Applied) {
      yield* fs.makeDirectory(directory, { recursive: true })
      const byID = new Map(applied.topics.map((topic) => [topic.id, topic]))
      yield* Effect.forEach(
        applied.changed,
        (id) => {
          const topic = byID.get(id)
          if (!topic) return Effect.void
          return MemoryFile.atomicWrite(fs, join(directory, `${id}.yaml`), stringify(topic, { lineWidth: 0 }))
        },
        { concurrency: 1, discard: true },
      )
      yield* Effect.forEach(applied.deleted, (id) => fs.remove(join(directory, `${id}.yaml`), { force: true }), {
        concurrency: 1,
        discard: true,
      })
    })

    const readSnapshotUnsafe = Effect.fnUntraced(function* (projectID: ProjectV2.ID, strict: boolean) {
      const text = yield* fs.readFileStringSafe(home.manifest(projectID))
      if (text === undefined)
        return {
          revision: 0,
          topics: yield* readDirectoryTopics(home.topics(projectID), strict),
        } satisfies Snapshot
      const decoded = decodeManifest(text)
      if (Option.isNone(decoded) || !/^[a-z0-9-]+$/.test(decoded.value.generation))
        return yield* new StoreError({ message: "Memory generation manifest is invalid" })
      const directory = join(home.generations(projectID), decoded.value.generation)
      if (!(yield* fs.existsSafe(directory)))
        return yield* new StoreError({ message: "Memory generation referenced by manifest is missing" })
      return {
        revision: decoded.value.revision,
        topics: yield* readDirectoryTopics(directory, strict),
      } satisfies Snapshot
    })

    // `live` is the generation the manifest was just published to; it is never
    // collected. The manifest only advances under the project lock, so any other
    // generation at or above the live revision is the orphan of a failed or
    // crashed publish whose revision number was reused. Orphans are removed
    // outright: ranked among retained generations they could evict the live one.
    const gcGenerations = Effect.fnUntraced(function* (
      projectID: ProjectV2.ID,
      live: { readonly revision: number; readonly generation: string },
    ) {
      const generations = home.generations(projectID)
      const entries = yield* fs.readDirectoryEntries(generations)
      const candidates = entries
        .filter((entry) => entry.type === "directory" && /^\d+-/.test(entry.name) && entry.name !== live.generation)
        .map((entry) => ({ name: entry.name, revision: Number.parseInt(entry.name, 10) }))
      const orphans = candidates.filter((entry) => entry.revision >= live.revision).map((entry) => entry.name)
      const stale = candidates
        .filter((entry) => entry.revision < live.revision)
        .sort((a, b) => b.revision - a.revision || b.name.localeCompare(a.name))
        .slice(RETAINED_GENERATIONS - 1)
        .map((entry) => entry.name)
      // Orphan staging directories are rename leftovers from crashed writes.
      const staging = entries
        .filter((entry) => entry.name.startsWith(".") && entry.name.endsWith(".tmp"))
        .map((entry) => entry.name)
      yield* Effect.forEach(
        [...orphans, ...stale, ...staging],
        (name) => fs.remove(join(generations, name), { force: true, recursive: true }),
        { discard: true },
      )
    })

    // A failed publish removes its renamed generation so it cannot linger as an
    // orphan — unless the manifest did land on it, in which case it is live.
    const discardUnpublished = (projectID: ProjectV2.ID, generation: string, directory: string) =>
      Effect.gen(function* () {
        const text = yield* fs.readFileStringSafe(home.manifest(projectID))
        const manifest = text === undefined ? Option.none() : decodeManifest(text)
        if (Option.isSome(manifest) && manifest.value.generation === generation) return
        yield* fs.remove(directory, { force: true, recursive: true })
      }).pipe(Effect.ignore)

    const writeSnapshot = Effect.fnUntraced(function* (
      projectID: ProjectV2.ID,
      revision: number,
      topics: MemorySchema.Topic[],
    ) {
      if (
        new Set(topics.map((topic) => topic.id)).size !== topics.length ||
        topics.some((topic) => !decodeTopic(topic, topic.id))
      )
        yield* new StoreError({ message: "Memory update produced an invalid generation" })
      const generation = `${revision}-${randomUUID()}`
      const generations = home.generations(projectID)
      const staging = join(generations, `.${generation}.tmp`)
      const directory = join(generations, generation)
      yield* Effect.gen(function* () {
        yield* fs.makeDirectory(generations, { recursive: true })
        yield* writeDirectoryTopics(staging, {
          topics,
          changed: topics.map((topic) => topic.id),
          deleted: [],
        })
        // Publication (rename + manifest) is one uninterruptible region: an
        // interrupt cannot split it, and a failure inside it discards the
        // renamed generation rather than leaving an orphan at the next revision.
        yield* Effect.gen(function* () {
          yield* fs.rename(staging, directory)
          yield* MemoryFile.atomicWrite(
            fs,
            home.manifest(projectID),
            JSON.stringify({ schema_version: 1, revision, generation }) + "\n",
          )
        }).pipe(
          Effect.onError(() => discardUnpublished(projectID, generation, directory)),
          Effect.uninterruptible,
        )
      }).pipe(Effect.onError(() => fs.remove(staging, { force: true, recursive: true }).pipe(Effect.ignore)))
      yield* fs.remove(home.topics(projectID), { force: true, recursive: true }).pipe(Effect.ignore)
      // GC is best-effort: the commit has already landed, a cleanup failure
      // must never fail it.
      yield* gcGenerations(projectID, { revision, generation }).pipe(
        Effect.catchCause((cause) => Effect.logWarning("memory generation GC failed", { cause: cause })),
      )
    })

    const readTopics = Effect.fn("MemoryStore.readTopics")((projectID: ProjectV2.ID) =>
      readSnapshotUnsafe(projectID, false).pipe(
        Effect.map((snapshot) => snapshot.topics),
        Effect.catchTag("MemoryStore.Error", () => Effect.succeed([])),
      ),
    )

    const readSnapshot = Effect.fn("MemoryStore.readSnapshot")((projectID: ProjectV2.ID) =>
      readSnapshotUnsafe(projectID, true),
    )

    const inspectTopics = Effect.fn("MemoryStore.inspectTopics")((projectID: ProjectV2.ID) =>
      readSnapshot(projectID).pipe(Effect.map((snapshot) => snapshot.topics)),
    )

    const commitUnsafe = Effect.fnUntraced(function* (
      projectID: ProjectV2.ID,
      expectedRevision: number,
      applied: Applied,
    ) {
      const current = yield* readSnapshot(projectID)
      if (current.revision !== expectedRevision)
        return yield* new CommitConflictError({
          expected_revision: expectedRevision,
          actual_revision: current.revision,
        })
      if (applied.changed.length === 0 && applied.deleted.length === 0) return current
      const revision = current.revision + 1
      yield* writeSnapshot(projectID, revision, applied.topics)
      return { revision, topics: applied.topics } satisfies Snapshot
    })

    const commit = Effect.fn("MemoryStore.commit")((projectID: ProjectV2.ID, expectedRevision: number, applied: Applied) =>
      flock.withLock(commitUnsafe(projectID, expectedRevision, applied), `memory-project:${projectID}`, home.locks),
    )

    const updateTopics: Interface["updateTopics"] = (projectID, update) =>
      flock.withLock(
        Effect.gen(function* () {
          const current = yield* readSnapshot(projectID)
          const next = yield* Effect.try({
            try: () => update(current.topics),
            catch: (cause) =>
              cause instanceof StoreError
                ? cause
                : new StoreError({ message: `Memory update failed: ${String(cause)}` }),
          })
          const applied = next.applied
          if (applied.changed.length === 0 && applied.deleted.length === 0)
            return { revision: current.revision, topics: applied.topics, result: next.result }
          const revision = current.revision + 1
          yield* writeSnapshot(projectID, revision, applied.topics)
          return { revision, topics: applied.topics, result: next.result }
        }),
        `memory-project:${projectID}`,
        home.locks,
      )

    return Service.of({ readTopics, readSnapshot, commit, inspectTopics, updateTopics })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(EffectFlock.defaultLayer),
  Layer.provide(MemoryHome.defaultLayer),
)

export const node = LayerNode.make(layer, [FSUtil.node, EffectFlock.node, MemoryHome.node])

export function decodeTopic(value: unknown, expectedID?: string) {
  if (!hasExactKeys(value, TOPIC_KEYS)) return undefined
  if (!hasExactKeys(value.metadata, METADATA_KEYS)) return undefined
  if (!Array.isArray(value.items) || value.items.some((item) => !hasExactKeys(item, ITEM_KEYS))) return undefined
  const decoded = Schema.decodeUnknownOption(MemorySchema.Topic)(value)
  if (Option.isNone(decoded)) return undefined
  const topic = decoded.value
  if (expectedID && topic.id !== expectedID) return undefined
  if (topic.metadata.item_count !== topic.items.length) return undefined
  if (new Set(topic.items.map((item) => item.id)).size !== topic.items.length) return undefined
  if (new Set(topic.metadata.categories).size !== topic.metadata.categories.length) return undefined
  if (topic.metadata.related_topics.includes(topic.id)) return undefined
  // Persisted content is checked under the original rules; the admission-only
  // credential rules apply to new or changed values in applyActions.
  if ([topic.name, topic.summary, ...topic.metadata.keywords].some((value) => !allowedText(value, PROHIBITED_CONTENT)))
    return undefined
  if (topic.items.some((item) => !allowedItem(item, PROHIBITED_CONTENT))) return undefined
  return topic
}

export function applyActions(input: {
  topics: MemorySchema.Topic[]
  actions: ReadonlyArray<MemorySchema.MaintenanceAction>
  topicLimit: number
  now?: string
  id?: () => string
}): Applied {
  const now = input.now ?? new Date().toISOString()
  const makeID = input.id ?? (() => ulid().toLowerCase())
  const topics = new Map(input.topics.map((topic) => [topic.id, cloneTopic(topic)]))
  const changed = new Set<string>()
  const deleted = new Set<string>()

  for (const action of input.actions) {
    if (action.type === "no_change") continue
    if (action.type === "create_topic") {
      assertSemantic(action.name, action.summary, ...action.keywords)
      assertItem(action.item)
      if (topics.size >= input.topicLimit) throw new StoreError({ message: "Memory topic capacity reached" })
      const id = `topic-${makeID()}`
      const itemID = `item-${makeID()}`
      if (topics.has(id)) throw new StoreError({ message: `Memory topic ID collision: ${id}` })
      const topic: MutableTopic = {
        schema_version: MemorySchema.SCHEMA_VERSION,
        id,
        name: action.name,
        summary: action.summary,
        metadata: {
          categories: unique(action.categories),
          status: "active",
          importance: "core",
          keywords: unique(action.keywords),
          related_topics: validRelated(action.related_topics, id, topics),
          created_at: now,
          updated_at: now,
          last_matched_at: null,
          match_count: 0,
          revision: 1,
          item_count: 1,
        },
        items: [
          {
            id: itemID,
            kind: action.item.kind,
            content: action.item.content,
            rationale: action.item.rationale,
            confirmed_at: now,
          },
        ],
      }
      topics.set(id, topic)
      changed.add(id)
      continue
    }

    const topic = topics.get(action.topic_id)
    if (!topic) throw new StoreError({ message: `Memory topic not found: ${action.topic_id}` })

    if (action.type === "delete_topic") {
      topics.delete(topic.id)
      changed.delete(topic.id)
      deleted.add(topic.id)
      for (const related of topics.values()) {
        if (!related.metadata.related_topics.includes(topic.id)) continue
        related.metadata.related_topics = related.metadata.related_topics.filter((id) => id !== topic.id)
        touch(related, now)
        changed.add(related.id)
      }
      continue
    }

    if (action.type === "upsert_item") {
      assertItem(action.item)
      const index = action.item_id ? topic.items.findIndex((item) => item.id === action.item_id) : -1
      if (action.item_id && index < 0) throw new StoreError({ message: `Memory item not found: ${action.item_id}` })
      const itemID = action.item_id ?? `item-${makeID()}`
      const item = {
        id: itemID,
        kind: action.item.kind,
        content: action.item.content,
        rationale: action.item.rationale,
        confirmed_at: now,
      }
      topic.items = index < 0 ? [...topic.items, item] : topic.items.map((current, i) => (i === index ? item : current))
      touch(topic, now)
      changed.add(topic.id)
      continue
    }

    if (action.type === "delete_item") {
      if (!topic.items.some((item) => item.id === action.item_id))
        throw new StoreError({ message: `Memory item not found: ${action.item_id}` })
      if (topic.items.length === 1) throw new StoreError({ message: "Cannot delete the last item from a topic" })
      topic.items = topic.items.filter((item) => item.id !== action.item_id)
      touch(topic, now)
      changed.add(topic.id)
      continue
    }

    const semantic = [action.name, action.summary, ...(action.keywords ?? [])].filter(
      (value): value is string => value !== undefined,
    )
    assertSemantic(...semantic)
    if (
      action.name === undefined &&
      action.summary === undefined &&
      action.categories === undefined &&
      action.keywords === undefined &&
      action.related_topics === undefined
    )
      throw new StoreError({ message: "Memory topic update is empty" })
    topic.name = action.name ?? topic.name
    topic.summary = action.summary ?? topic.summary
    topic.metadata.categories = action.categories ? unique(action.categories) : topic.metadata.categories
    topic.metadata.keywords = action.keywords ? unique(action.keywords) : topic.metadata.keywords
    topic.metadata.related_topics = action.related_topics
      ? validRelated(action.related_topics, topic.id, topics)
      : topic.metadata.related_topics
    touch(topic, now)
    changed.add(topic.id)
  }

  const result = Array.from(topics.values()).sort((a, b) => a.id.localeCompare(b.id))
  if (result.some((topic) => !decodeTopic(topic, topic.id)))
    throw new StoreError({ message: "Memory actions produced an invalid topic" })
  return {
    topics: result,
    changed: Array.from(changed),
    deleted: Array.from(deleted),
  }
}

export function markMatched(topics: MemorySchema.Topic[], topicIDs: string[], now = new Date().toISOString()): Applied {
  const ids = new Set(topicIDs)
  const changed: string[] = []
  const next = topics.map((topic) => {
    if (!ids.has(topic.id)) return topic
    changed.push(topic.id)
    const updated = cloneTopic(topic)
    updated.metadata.last_matched_at = now
    updated.metadata.match_count += 1
    updated.metadata.revision += 1
    updated.metadata.updated_at = now
    return updated
  })
  return { topics: next, changed, deleted: [] }
}

/** Admission check for new or changed text. */
export function isAllowedMemoryText(value: string) {
  return allowedText(value, ADMISSION_CONTENT)
}

/** Admission check for a new or changed item. */
export function isAllowedMemoryItem(item: Pick<MemorySchema.TopicItem, "kind" | "content" | "rationale">) {
  return allowedItem(item, ADMISSION_CONTENT)
}

function allowedText(value: string, rules: ContentRules) {
  const text = value.trim()
  if (!text || text.length > 1_000) return false
  if (text.includes("\n") || text.includes("\r")) return false
  return !rules.some((pattern) => pattern.test(text))
}

function allowedItem(item: Pick<MemorySchema.TopicItem, "kind" | "content" | "rationale">, rules: ContentRules) {
  if (!allowedText(item.content, rules) || !allowedText(item.rationale, rules)) return false
  const intent = item.content.match(ITEM_INTENT[item.kind])
  if (!intent || !DURABLE_CONFIRMATION.test(item.rationale)) return false
  const payload = item.content
    .slice((intent.index ?? 0) + intent[0].length)
    .replace(/^[\s:：—–-]+/, "")
    .trim()
  return payload.length > 0 && allowedText(payload, rules)
}

export function indexes(topics: MemorySchema.Topic[]) {
  return topics.map(MemorySchema.topicIndex)
}

function assertSemantic(...values: string[]) {
  if (values.some((value) => !isAllowedMemoryText(value)))
    throw new StoreError({ message: "Memory action contains prohibited content" })
}

function cloneTopic(topic: MemorySchema.Topic): MutableTopic {
  return {
    schema_version: topic.schema_version,
    id: topic.id,
    name: topic.name,
    summary: topic.summary,
    metadata: {
      categories: [...topic.metadata.categories],
      status: topic.metadata.status,
      importance: topic.metadata.importance,
      keywords: [...topic.metadata.keywords],
      related_topics: [...topic.metadata.related_topics],
      created_at: topic.metadata.created_at,
      updated_at: topic.metadata.updated_at,
      last_matched_at: topic.metadata.last_matched_at,
      match_count: topic.metadata.match_count,
      revision: topic.metadata.revision,
      item_count: topic.metadata.item_count,
    },
    items: topic.items.map((item) => ({
      id: item.id,
      kind: item.kind,
      content: item.content,
      rationale: item.rationale,
      confirmed_at: item.confirmed_at,
    })),
  }
}

function assertItem(item: Pick<MemorySchema.TopicItem, "kind" | "content" | "rationale">) {
  if (!isAllowedMemoryItem(item)) throw new StoreError({ message: "Memory action contains prohibited content" })
}

function touch(topic: MutableTopic, now: string) {
  topic.metadata.updated_at = now
  topic.metadata.revision++
  topic.metadata.item_count = topic.items.length
}

function unique<T>(values: ReadonlyArray<T>) {
  return Array.from(new Set(values))
}

function validRelated(values: ReadonlyArray<string>, self: string, topics: ReadonlyMap<string, MutableTopic>) {
  return unique(values).filter((id) => id !== self && topics.has(id))
}

function hasExactKeys(value: unknown, keys: ReadonlyArray<string>): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const actual = Object.keys(value)
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}
