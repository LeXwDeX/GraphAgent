// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** @jsxImportSource @opentui/solid */
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

export function ShellContexts(
  props: ParentProps<{
    state: string
    onReady?: () => void
    children?: JSX.Element
  }>,
) {
  return (
    <TestTuiContexts paths={{ state: props.state }}>
      <TuiConfigProvider config={createTuiResolvedConfig()}>
        <KVProvider>
          <KVReady onReady={props.onReady}>
            <ThemeProvider mode="dark">{props.children}</ThemeProvider>
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
