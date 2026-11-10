// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/**
 * Agents whose requests are internal one-shots: they run in a temporary or
 * background context and never continue the conversation. The OpenAI WebSocket
 * pool keys connections by session, so such a request would open a connection
 * that never serves a follow-up request. Route them over plain HTTP instead.
 */
const INTERNAL_ONE_SHOT_AGENTS: ReadonlySet<string> = new Set(["title", "btw"])

export function isInternalOneShot(agentName: string): boolean {
  return INTERNAL_ONE_SHOT_AGENTS.has(agentName)
}

export * as InternalOneShot from "./internal-one-shot"
