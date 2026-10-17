import { isRecord } from "@/util/record"
export * as HookTurnContext from "./turn-context"

import { Effect } from "effect"
import type { BackgroundJob } from "@/background/job"
import type { DagStore } from "@opencode-ai/core/dag/store"

const clipped = (value: string) =>
  value.length <= 1000 ? value : `${value.slice(0, 1000)}… [+${value.length - 1000} chars]`
const record = (value: unknown): Record<string, unknown> | undefined => (isRecord(value) ? value : undefined)

/** Read current registries; never infer active tasks from historical messages. */
export const backgroundTasks = Effect.fn("HookTurnContext.backgroundTasks")(function* (
  sessionID: string,
  services: { jobs: BackgroundJob.Interface; workflows?: DagStore.Interface },
) {
  const jobs = yield* services.jobs.list()
  const workflows = services.workflows ? yield* services.workflows.listBySession(sessionID) : []
  return [
    ...jobs
      .filter(
        (job) =>
          job.status === "running" &&
          (job.metadata?.sessionId === sessionID ||
            job.metadata?.parentSessionId === sessionID ||
            job.metadata?.sessionID === sessionID ||
            job.metadata?.parentSessionID === sessionID),
      )
      .map((job) => ({
        id: job.id,
        type: job.type === "task" ? "subagent" : job.type === "bash" ? "shell" : job.type,
        status: job.status,
        ...(job.title ? { description: clipped(job.title) } : {}),
        ...((job.type === "bash" || job.type === "shell") && typeof job.metadata?.command === "string"
          ? { command: clipped(job.metadata.command) }
          : {}),
        ...((job.type === "task" || job.type === "subagent") && typeof job.metadata?.agent === "string"
          ? { agent_type: job.metadata.agent }
          : {}),
        ...(["monitor", "mcp", "MCP task"].includes(job.type) && typeof job.metadata?.server === "string"
          ? { server: job.metadata.server }
          : {}),
        ...(["monitor", "mcp", "MCP task"].includes(job.type) && typeof job.metadata?.tool === "string"
          ? { tool: job.metadata.tool }
          : {}),
      })),
    ...workflows
      .filter((workflow) => ["pending", "running", "paused", "stepping"].includes(workflow.status))
      .map((workflow) => ({
        id: workflow.id,
        type: "workflow",
        status: workflow.status,
        name: workflow.title,
        description: clipped(workflow.title),
      })),
  ]
})

/** Normalize host API failures to the hook protocol's matcher vocabulary. */
export function failure(value: unknown, displayedError?: string) {
  const outer = record(value)
  const data = record(outer?.reason) ?? record(outer?.data) ?? outer
  const text =
    typeof data?.message === "string"
      ? data.message
      : value instanceof Error
        ? value.message
        : typeof value === "string"
          ? value
          : "Unknown API error"
  const http = record(data?.http)
  const response = record(http?.response)
  const status =
    typeof data?.statusCode === "number"
      ? data.statusCode
      : typeof data?.status === "number"
        ? data.status
        : typeof response?.status === "number"
          ? response.status
          : undefined
  const tag = data?._tag
  const lower = text.toLowerCase()
  const error = lower.includes("oauth_org_not_allowed")
    ? "oauth_org_not_allowed"
    : lower.includes("account_on_hold") || lower.includes("account is on hold")
      ? "account_on_hold"
      : lower.includes("cloud_credential")
        ? "cloud_credential_error"
        : lower.includes("max_output_tokens")
          ? "max_output_tokens"
          : tag === "RateLimit" || status === 429 || /rate.?limit|too many requests/.test(lower)
            ? "rate_limit"
            : status === 529 || /overload/.test(lower)
              ? "overloaded"
              : tag === "Authentication" || status === 401 || /authentication|invalid api.?key|unauthorized/.test(lower)
                ? "authentication_failed"
                : tag === "QuotaExceeded" || status === 402 || /billing|insufficient (?:credit|balance)/.test(lower)
                  ? "billing_error"
                  : /model.{0,80}(?:not found|does not exist)|model_not_found/.test(lower)
                    ? "model_not_found"
                    : tag === "InvalidRequest" ||
                        status === 400 ||
                        status === 413 ||
                        outer?.name === "ContextOverflowError"
                      ? "invalid_request"
                      : tag === "ProviderInternal" || (status !== undefined && status >= 500)
                        ? "server_error"
                        : "unknown"
  return {
    error,
    ...(displayedError === undefined ? {} : { errorDetails: displayedError, lastAssistantMessage: displayedError }),
  }
}
