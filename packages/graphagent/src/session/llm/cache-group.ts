// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

export * as CacheGroup from "./cache-group"

import type { Tool } from "ai"
import { serializedTools } from "../overflow"
import { digest } from "../request-cache"
import { serializedFragment } from "../tools"

/**
 * Prompt-cache group identity (Issue #1028, PR4).
 *
 * Sibling child runs of one DAG node share the same cacheable prefix: agent
 * prompt, system fragments and tool definitions. The scheduler uses this
 * digest to start those siblings one at a time so they reuse a warm provider
 * cache instead of racing to write the same prefix.
 *
 * Only the caller-provided `system` fragments are hashed. The prepared wire
 * system is deliberately excluded: a DAG child appends its node-specific
 * execution context to `user.system`, and hashing that would give every node
 * a different group even though the provider-visible cache prefix is shared.
 */

/** Bump when the hashed shape changes; a version change splits every group. */
export const VERSION = "cache-group-v1"

export interface Input {
  readonly agent: { readonly name: string; readonly prompt?: string }
  readonly system: readonly string[]
  readonly tools: Record<string, unknown>
}

/**
 * Content-addressed cache group for one request. Requests with the same agent
 * prompt, system fragments and tool definitions share it; the session id and
 * model are intentionally not part of the identity.
 *
 * The key is `cg_` plus 48 hex characters (51 total), under the 64-character
 * cap of OpenAI's `prompt_cache_key`.
 */
export function cacheGroupOf(input: Input): string {
  // Prefer the fragment `SessionTools.resolve` serialized for the wire; it is
  // byte-identical to the tools the provider receives. Plain callers (tests,
  // alternate runtimes) fall back to serializing the definitions here.
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- this boundary types tools structurally; serializedFragment only reads an attached opaque string.
  const tools = serializedFragment(input.tools as Record<string, Tool>) ?? JSON.stringify(serializedTools(input.tools))
  return `cg_${digest({
    version: VERSION,
    agent: {
      name: input.agent.name,
      ...(input.agent.prompt !== undefined ? { prompt: input.agent.prompt } : {}),
    },
    system: input.system,
    tools,
  }).slice(0, 48)}`
}
