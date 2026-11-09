// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

export * as MemoryPaths from "./paths"

/**
 * Project memory policy is the `memory` section of the product-owned local
 * settings file. It is never a standalone `memory.json(c)` any more.
 */
export const PROJECT_LOCAL_SETTINGS = ".agents/settings.local.json"

/** Worktree-local paths containing durable project data that `git clean`
 * must preserve. Entries are relative to the git repository root. */
export const LOCAL_PATHS = [PROJECT_LOCAL_SETTINGS] as const
