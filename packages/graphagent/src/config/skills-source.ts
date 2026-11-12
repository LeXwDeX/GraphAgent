// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

export * as ConfigSkillsSource from "./skills-source"

/**
 * Which config layer declared `skills.paths` / `skills.urls` on a merged
 * `Info` (#1040). `mergeDeep` replaces an array key wholesale rather than
 * concatenating it (verified empirically), so after the full merge each key
 * is attributable to exactly one layer: whichever source last set it. A
 * project declaration wins over a user one for that key; a key no layer set
 * stays `undefined` (unused by any discovery path).
 */
export type SkillsSourceLayer = "project" | "user"

export interface SkillsSource {
  paths?: SkillsSourceLayer
  urls?: SkillsSourceLayer
}

const sources = new WeakMap<object, SkillsSource>()

export function skillsSource(config: object): SkillsSource | undefined {
  return sources.get(config)
}

export function setSkillsSource(config: object, value: SkillsSource) {
  sources.set(config, value)
}
