// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** User interface and default assistant reply languages. */
export type UiLanguage = "zh-CN" | "en"

export const UI_LANGUAGES = ["zh-CN", "en"] as const

/** Fallback when neither the configuration nor the system locale is conclusive. */
export const DEFAULT_LANGUAGE: UiLanguage = "en"

type Environment = Record<string, string | undefined>

function fromConfigured(configured: string | undefined): UiLanguage | undefined {
  if (configured === "zh-CN" || configured === "en") return configured
  return undefined
}

/** Accepts locale identifiers such as `zh_CN.UTF-8` or `en-US`. */
function fromLocale(locale: string | undefined): UiLanguage | undefined {
  if (!locale) return undefined
  const value = locale.trim().toLowerCase()
  if (!value) return undefined
  const language = value.split(/[._-]/)[0]
  if (language === "zh") return "zh-CN"
  if (language === "en") return "en"
  return undefined
}

function systemLocale() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale
  } catch {
    return undefined
  }
}

/**
 * Resolve the effective UI language. Priority: explicit configuration,
 * `LC_ALL`, `LC_MESSAGES`, `LANG`, the runtime locale, then `en`.
 *
 * Both the TUI and the server import this function so the inferred language
 * always matches. An unsupported configured value is ignored.
 */
export function resolveLanguage(
  configured: string | undefined,
  env: Environment = process.env,
  locale: string | undefined = systemLocale(),
): UiLanguage {
  return (
    fromConfigured(configured) ??
    fromLocale(env.LC_ALL) ??
    fromLocale(env.LC_MESSAGES) ??
    fromLocale(env.LANG) ??
    fromLocale(locale) ??
    DEFAULT_LANGUAGE
  )
}
