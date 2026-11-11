// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { useRenderer } from "@opentui/solid"
import { createContext, createSignal, onCleanup, useContext, type ParentProps } from "solid-js"
import { useKV } from "./kv"
import { createTicker, type Ticker } from "./ticker"

const TickerContext = createContext<Ticker>()

/**
 * Provides the TUI's single time source. Tests may inject a ticker with a fake
 * clock. Frame ticks pause while the terminal window is not focused and stay at
 * 0 while animations are disabled.
 */
export function TickerProvider(props: ParentProps<{ ticker?: Ticker }>) {
  const kv = useKV()
  const renderer = useRenderer()
  const [focused, setFocused] = createSignal(true)
  const onFocus = () => setFocused(true)
  const onBlur = () => setFocused(false)
  renderer.on("focus", onFocus)
  renderer.on("blur", onBlur)
  onCleanup(() => {
    renderer.off("focus", onFocus)
    renderer.off("blur", onBlur)
  })
  const ticker =
    props.ticker ??
    createTicker({
      animationsEnabled: () => kv.get("animations_enabled", true),
      focused,
    })
  return <TickerContext.Provider value={ticker}>{props.children}</TickerContext.Provider>
}

export function useTicker(): Ticker {
  const ticker = useContext(TickerContext)
  if (!ticker) throw new Error("useTicker must be used within a TickerProvider")
  return ticker
}

/** Ticker access for components that also work outside the provider (run mode). */
export function useOptionalTicker(): Ticker | undefined {
  return useContext(TickerContext)
}
