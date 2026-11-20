// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { Config } from "@graphagent/sdk"
import { sortBy } from "remeda"

/**
 * The model IDs the configuration declares, by provider (#1666): the keys of a provider's `models` and the entries of
 * its `whitelist`. A provider the configuration does not list is not in the result and declares no model, even when it
 * has a key from the environment or a login.
 */
export function declaredModels(config: Pick<Config, "provider">): ReadonlyMap<string, ReadonlySet<string>> {
  const result = new Map<string, ReadonlySet<string>>()
  for (const [providerID, declared] of Object.entries(config.provider ?? {})) {
    result.set(providerID, new Set([...Object.keys(declared.models ?? {}), ...(declared.whitelist ?? [])]))
  }
  return result
}

/**
 * Applies the model picker ordering: provider-scoped lists are newest first,
 * while the combined list keeps free models at the top.
 */
export function sortModelOptions<T extends { footer?: string; releaseDate: string | number; title: string }>(
  options: T[],
  newestFirst: boolean,
) {
  if (newestFirst) return sortBy(options, [(option) => option.releaseDate, "desc"], (option) => option.title)
  return sortBy(
    options,
    (option) => option.footer !== "Free",
    [(option) => option.releaseDate, "desc"],
    (option) => option.title,
  )
}
