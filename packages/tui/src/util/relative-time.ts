// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { t } from "../i18n"
import { Locale } from "./locale"

/** How long ago a timestamp was, in the words the stash list uses. */
export function getRelativeTime(timestamp: number): string {
  const now = Date.now()
  const diff = now - timestamp
  const seconds = Math.floor(diff / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)

  if (seconds < 60) return t("panel.stash.time.justNow")
  if (minutes < 60) return t("panel.stash.time.minutes", { count: minutes })
  if (hours < 24) return t("panel.stash.time.hours", { count: hours })
  if (days < 7) return t("panel.stash.time.days", { count: days })
  return Locale.datetime(timestamp)
}
