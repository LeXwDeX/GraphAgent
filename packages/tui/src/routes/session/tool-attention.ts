// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

type ToolState = {
  status: string
  metadata?: Record<string, unknown>
  output?: string
}

export function toolAttention(tool: string, state: ToolState): string | undefined {
  if (state.status !== "completed") return
  if (state.metadata?.blocked === true) {
    return typeof state.metadata.diagnosticSummary === "string"
      ? state.metadata.diagnosticSummary
      : "Tool execution blocked"
  }
  // Older workflow validation results persisted no metadata and looked successful.
  if (tool !== "workflow" || !state.output) return
  try {
    const result = JSON.parse(state.output)
    if (result?.valid !== false || !Array.isArray(result.errors)) return
    return (
      result.errors
        .filter(
          (error: unknown): error is { code: string; message: string } =>
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            typeof error.code === "string" &&
            "message" in error &&
            typeof error.message === "string",
        )
        .map((error: { code: string; message: string }) => `[${error.code}] ${error.message}`)
        .join("; ") || "Workflow validation failed"
    )
  } catch {
    return
  }
}

export function hideToolDetails(tool: string, state: ToolState, showDetails: boolean) {
  return !showDetails && state.status === "completed" && toolAttention(tool, state) === undefined
}
