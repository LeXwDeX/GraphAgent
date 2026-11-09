// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { createContext, useContext, type ParentProps } from "solid-js"
import { createTicker, type Ticker } from "./ticker"

const TickerContext = createContext<Ticker>()

/** Provides the TUI's single time source. Tests may inject a ticker with a fake clock. */
export function TickerProvider(props: ParentProps<{ ticker?: Ticker }>) {
  const ticker = props.ticker ?? createTicker()
  return <TickerContext.Provider value={ticker}>{props.children}</TickerContext.Provider>
}

export function useTicker(): Ticker {
  const ticker = useContext(TickerContext)
  if (!ticker) throw new Error("useTicker must be used within a TickerProvider")
  return ticker
}
