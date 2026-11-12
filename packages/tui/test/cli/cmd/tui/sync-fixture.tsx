/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import type { JSX } from "@opentui/solid"
import { onMount } from "solid-js"
import { ArgsProvider } from "../../../../src/context/args"
import { ExitProvider } from "../../../../src/context/exit"
import { KVProvider, useKV } from "../../../../src/context/kv"
import { ProjectProvider, useProject } from "../../../../src/context/project"
import { SDKProvider, useSDK } from "../../../../src/context/sdk"
import { SyncProvider, useSync } from "../../../../src/context/sync"
import { createEventSource, createFetch, type FetchHandler, directory } from "../../../fixture/tui-sdk"
import { TestTuiContexts } from "../../../fixture/tui-environment"
export { createEventSource, createFetch, directory, eventSource, json, worktree } from "../../../fixture/tui-sdk"

export async function wait(fn: () => boolean, timeout = 2000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

type Ctx = {
  kv: ReturnType<typeof useKV>
  project: ReturnType<typeof useProject>
  sdk: ReturnType<typeof useSDK>
  sync: ReturnType<typeof useSync>
}

export async function mount(override?: FetchHandler, state?: string, extra?: () => JSX.Element) {
  const calls = createFetch(override)
  const events = createEventSource()
  let sync!: ReturnType<typeof useSync>
  let sdk!: ReturnType<typeof useSDK>
  let project!: ReturnType<typeof useProject>
  let kv!: ReturnType<typeof useKV>
  let done!: () => void
  const ready = new Promise<void>((resolve) => {
    done = resolve
  })

  function Probe() {
    const ctx: Ctx = { kv: useKV(), project: useProject(), sdk: useSDK(), sync: useSync() }
    onMount(() => {
      sync = ctx.sync
      sdk = ctx.sdk
      project = ctx.project
      kv = ctx.kv
      done()
    })
    return <box />
  }

  const app = await testRender(() => (
    <TestTuiContexts paths={state ? { state } : undefined}>
      <ExitProvider exit={() => {}}>
        <ArgsProvider>
          <KVProvider>
            <SDKProvider url="http://test" directory={directory} fetch={calls.fetch} events={events.source}>
              <ProjectProvider>
                <SyncProvider>
                  <Probe />
                  {extra?.()}
                </SyncProvider>
              </ProjectProvider>
            </SDKProvider>
          </KVProvider>
        </ArgsProvider>
      </ExitProvider>
    </TestTuiContexts>
  ))

  await ready
  await wait(() => sync.status === "complete")
  return {
    app,
    emit: events.emit,
    reconnect: events.reconnect,
    interest: events.interest,
    kv,
    project,
    sdk,
    sync,
    session: calls.session,
  }
}
