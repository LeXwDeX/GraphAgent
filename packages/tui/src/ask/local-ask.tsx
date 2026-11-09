// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { BottomZoneStateApi } from "../shell/bottom-zone"
import { ChoiceAskPrompt, ConfirmAskPrompt } from "./local"

let counter = 0

export interface ConfirmAskOptions {
  title: string
  body?: string
  confirmLabel: string
  cancelLabel: string
  danger?: boolean
}

export interface ChoiceAskOptions {
  title: string
  body?: string
  options: readonly { id: string; label: string }[]
}

/**
 * Enqueues a local confirm request and resolves once the user picks an
 * option. Esc resolves `false`, matching the retired DialogConfirm contract.
 */
export function askConfirm(zone: BottomZoneStateApi, options: ConfirmAskOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const id = `confirm-${++counter}`
    zone.ask({
      id,
      render: () => (
        <ConfirmAskPrompt
          ask={{
            kind: "confirm",
            id,
            title: options.title,
            body: options.body,
            confirmLabel: options.confirmLabel,
            cancelLabel: options.cancelLabel,
            danger: options.danger,
            resolve: (ok) => {
              zone.removeAsk(id)
              resolve(ok)
            },
          }}
        />
      ),
    })
  })
}

/**
 * Enqueues a local choice request and resolves with the chosen option id, or
 * `undefined` when the user cancels.
 */
export function askChoice(zone: BottomZoneStateApi, options: ChoiceAskOptions): Promise<string | undefined> {
  return new Promise((resolve) => {
    const id = `choice-${++counter}`
    zone.ask({
      id,
      render: () => (
        <ChoiceAskPrompt
          ask={{
            kind: "choice",
            id,
            title: options.title,
            body: options.body,
            options: [...options.options],
            resolve: (value) => {
              zone.removeAsk(id)
              resolve(value)
            },
          }}
        />
      ),
    })
  })
}
