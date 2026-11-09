// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { ParentProps } from "solid-js"

/** Status band slot: zero to two lines above the bottom zone (F4). */
export function StatusBand(props: ParentProps) {
  return (
    <box flexShrink={0} flexDirection="column">
      {props.children}
    </box>
  )
}
