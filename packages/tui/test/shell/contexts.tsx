// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
import type { testRender } from "@opentui/solid"
import { createEffect, Show, type JSX, type ParentProps } from "solid-js"
import path from "node:path"
import { TuiConfigProvider } from "../../src/config"
import { KVProvider, useKV } from "../../src/context/kv"
import { ThemeProvider } from "../../src/context/theme"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { tmpdir } from "../fixture/fixture"

export async function shellState(values: Record<string, unknown> = {}) {
  const tmp = await tmpdir()
  await Bun.write(path.join(tmp.path, "kv.json"), JSON.stringify(values))
  return tmp
}

type RenderedApp = Pick<Awaited<ReturnType<typeof testRender>>, "renderOnce" | "captureCharFrame">

/**
 * Renders until `ready()` holds. The providers gate their children on asynchronous
 * readiness (the kv.json read, theme discovery), so any fixed number of `renderOnce()`
 * calls can end before anything is mounted. Yield to the event loop between renders and
 * fail with the last frame instead of handing back a half-mounted app.
 */
export async function renderUntil(app: RenderedApp, ready: () => boolean, what = "condition", timeoutMs = 5_000) {
  const deadline = performance.now() + timeoutMs
  for (;;) {
    await app.renderOnce()
    if (ready()) return
    if (performance.now() >= deadline) {
      throw new Error(`${what} was not reached within ${timeoutMs}ms; last frame:\n${app.captureCharFrame()}`)
    }
    await Bun.sleep(1)
  }
}

/**
 * Renders until the first non-empty frame, then `settle` more times: content that is
 * measured on the first paint only reaches its final layout one render later.
 */
export async function renderFirstFrame(app: RenderedApp, settle = 2) {
  await renderUntil(app, () => app.captureCharFrame().trim().length > 0, "the first non-empty frame")
  for (let index = 0; index < settle; index++) await app.renderOnce()
}

export function ShellContexts(
  props: ParentProps<{
    state: string
    /** Terminal color mode handed to the theme provider; defaults to dark. */
    mode?: "dark" | "light"
    onReady?: () => void
    children?: JSX.Element
  }>,
) {
  return (
    <TestTuiContexts paths={{ state: props.state }}>
      <TuiConfigProvider config={createTuiResolvedConfig()}>
        <KVProvider>
          <KVReady onReady={props.onReady}>
            <ThemeProvider mode={props.mode ?? "dark"}>{props.children}</ThemeProvider>
          </KVReady>
        </KVProvider>
      </TuiConfigProvider>
    </TestTuiContexts>
  )
}

function KVReady(props: { onReady?: () => void; children: JSX.Element }) {
  const kv = useKV()
  createEffect(() => {
    if (kv.ready) props.onReady?.()
  })
  return (
    <Show when={kv.ready} fallback={<box width="100%" height="100%" />}>
      {props.children}
    </Show>
  )
}
