// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { createSignal } from "solid-js"
import { DEFAULT_LANGUAGE, resolveLanguage, type UiLanguage } from "@graphagent/core/config/language"
import { en } from "./en"
import { zhCN, type MessageKey } from "./zh-CN"

export type { MessageKey }
export type MessageParams = Record<string, string | number>

const TABLES: Record<UiLanguage, Record<MessageKey, string>> = { "zh-CN": zhCN, en }

const [language, setLanguageSignal] = createSignal<UiLanguage>(resolveLanguage(undefined))

/** Current interface language. Read inside a reactive scope to track switches. */
export function getLanguage(): UiLanguage {
  return language()
}

/** Apply a language chosen in the settings UI. */
export function setLanguage(next: UiLanguage) {
  setLanguageSignal(next)
}

/** Resolve and apply the startup language from configuration, environment or locale. */
export function initLanguage(configured?: string, env: Record<string, string | undefined> = process.env) {
  setLanguageSignal(resolveLanguage(configured, env))
}

/**
 * Translate a message key. Missing parameters keep their `{name}` placeholder so
 * a bad call is visible instead of producing a silently truncated sentence.
 */
export function t(key: MessageKey, params?: MessageParams): string {
  const template = TABLES[language()][key] ?? key
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (match, name) => {
    const value = params[name]
    return value === undefined ? match : String(value)
  })
}
