import { BackgroundJob } from "@/background/job"
import { parentSessionIDOf } from "@/background/session-metadata"
import { MCP } from "@/mcp"
import type { SessionID } from "@/session/schema"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { InstanceHttpApi } from "../api"

export const experimentalHandlers = HttpApiBuilder.group(InstanceHttpApi, "experimental", (handlers) =>
  Effect.gen(function* () {
    const mcp = yield* MCP.Service
    const background = yield* BackgroundJob.Service

    const capabilities = Effect.fn("ExperimentalHttpApi.capabilities")(function* () {
      return {}
    })

    const sessionBackground = Effect.fn("ExperimentalHttpApi.sessionBackground")(function* (ctx: {
      params: { sessionID: SessionID }
    }) {
      const jobs = (yield* background.list()).filter(
        (job) =>
          job.type === "task" &&
          job.status === "running" &&
          parentSessionIDOf(job.metadata) === ctx.params.sessionID &&
          job.metadata?.background !== true,
      )
      const promoted = yield* Effect.forEach(jobs, (job) => background.promote(job.id), { concurrency: "unbounded" })
      return promoted.some((job) => job !== undefined)
    })

    const resource = Effect.fn("ExperimentalHttpApi.resource")(function* () {
      return yield* mcp.resources()
    })

    return handlers
      .handle("capabilities", capabilities)
      .handle("sessionBackground", sessionBackground)
      .handle("resource", resource)
  }),
)
