// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { PromptEditRequest, PromptRef } from "../../src/component/prompt"

/** A PromptRef stand-in that records edits, prefills and focus requests. */
export function fakePromptRef() {
  const edits: PromptEditRequest[] = []
  const values: string[] = []
  let focused = 0

  const ref: PromptRef = {
    focused: false,
    current: { input: "", parts: [] },
    set(prompt) {
      ref.current = prompt
      values.push(prompt.input)
    },
    append(text) {
      ref.current = { ...ref.current, input: ref.current.input + text }
    },
    edit(request) {
      edits.push(request)
    },
    reset() {},
    blur() {},
    focus() {
      focused += 1
      ref.focused = true
    },
    submit() {},
  }

  return {
    ref,
    edits,
    values,
    get focused() {
      return focused
    },
  }
}
