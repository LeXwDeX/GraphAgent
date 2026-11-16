// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import type { ParentProps } from "solid-js"
import { LocalProvider } from "../../src/context/local"
import { useToast } from "../../src/ui/toast"

/**
 * `LocalProvider` wired the way `app.tsx` wires it: the notices the model and agent state raises become footer
 * toasts. Mount it under `FooterToastProvider`.
 */
export function ToastLocalProvider(props: ParentProps) {
  const toast = useToast()
  return <LocalProvider notify={(notice) => toast.show(notice)}>{props.children}</LocalProvider>
}
