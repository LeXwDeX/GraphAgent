import { Effect, Option, Schema } from "effect"
import { Memory } from "@/memory/memory"
import { Session } from "@/session/session"
import { Tool } from "./tool"

export const Parameters = Schema.Struct({
  query: Schema.String.annotate({
    description: "A natural-language description of the durable project context needed for the current user turn.",
  }),
})

type Metadata = {
  status: Memory.SearchResult["status"]
  count?: number
  reused?: boolean
}

export const MemorySearchTool = Tool.define<typeof Parameters, Metadata, never>(
  "memory_search",
  Effect.succeed({
    description:
      "Retrieve relevant durable project memory for the current user turn. Use it when historical preferences, confirmed decisions, rationale, or project terms may materially affect the answer.",
    parameters: Parameters,
    execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
      Effect.gen(function* () {
        const query = params.query.trim().replace(/\s+/g, " ")
        if (!query) {
          throw new Tool.InvalidArgumentsError({
            tool: "memory_search",
            detail: "`query` must contain a natural-language retrieval need",
          })
        }

        const memory = Option.getOrUndefined(yield* Effect.serviceOption(Memory.Service))
        const sessions = Option.getOrUndefined(yield* Effect.serviceOption(Session.Service))
        if (!memory || !sessions) return unavailable()
        const current = yield* sessions.get(ctx.sessionID).pipe(Effect.option)
        if (Option.isNone(current) || current.value.parentID) return unavailable()

        const result = yield* memory.search({ sessionID: ctx.sessionID, messages: ctx.messages, query })
        // #350: an inert Memory answers "unavailable" with no field to carry
        // why — surface the actionable reason (init stamp, git identity)
        // instead of leaving the caller to guess.
        if (result.status === "unavailable") {
          const reason = yield* memory.statusReason()
          if (reason) return unavailable(reason)
        }
        return response(result)
      }),
  } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>),
)

function response(result: Memory.SearchResult): Tool.ExecuteResult<Metadata> {
  if (result.status === "attached") {
    return {
      title: "memory attached",
      output: `Attached ${result.count} memory ${result.count === 1 ? "topic" : "topics"} to the current turn`,
      metadata: { status: result.status, count: result.count, reused: result.reused },
    }
  }
  if (result.status === "empty") {
    return {
      title: "no relevant memory",
      output: "No relevant memory topics were attached to the current turn",
      metadata: { status: result.status, count: 0, reused: result.reused },
    }
  }
  if (result.status === "limit") {
    return {
      title: "memory search limit reached",
      output: "Memory search limit reached for the current turn",
      metadata: { status: result.status },
    }
  }
  if (result.status === "stale") {
    return {
      title: "memory result expired",
      output: "Memory search completed after the user turn changed; no topics were attached",
      metadata: { status: result.status },
    }
  }
  if (result.status === "failed") {
    return {
      title: "memory search unavailable",
      output: "Memory search did not complete; no topics were attached",
      metadata: { status: result.status },
    }
  }
  return unavailable()
}

function unavailable(reason?: string): Tool.ExecuteResult<Metadata> {
  return {
    title: "memory unavailable",
    output: reason ?? "Memory search is unavailable for this session",
    metadata: { status: "unavailable" },
  }
}

export * as MemorySearch from "./memory-search"
