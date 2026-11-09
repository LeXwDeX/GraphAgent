// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { ParentProps } from "solid-js"

/**
 * Bottom zone slot: input box, panel, or ask queue (F3). The frame keeps it
 * below the main area and above the footer; the slot itself does not own
 * priority rules.
 */
export function BottomZone(props: ParentProps) {
  return (
    <box flexShrink={0} flexDirection="column">
      {props.children}
    </box>
  )
}
