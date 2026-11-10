// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import type { ProviderAuthAuthorization, ProviderAuthMethod } from "@graphagent/sdk"
import { createMemo, createSignal, Match, onCleanup, onMount, Switch } from "solid-js"
import { useConnected } from "../component/use-connected"
import { useClipboard } from "../context/clipboard"
import { useSDK } from "../context/sdk"
import { useSync } from "../context/sync"
import { useTheme } from "../context/theme"
import { t } from "../i18n"
import { useBindings } from "../keymap"
import { Link } from "../ui/link"
import { useToast } from "../ui/toast"
import { DetailPanel } from "./detail"
import { usePanelHost, type PanelHostApi } from "./host"
import { ListPanel, type ListItem } from "./list"
import type { PanelHint } from "./shell"

const PROVIDER_PRIORITY: Record<string, number> = {
  openai: 2,
  "github-copilot": 3,
  anthropic: 4,
  google: 5,
}

const CUSTOM_PROVIDER_OPTION = "__graphagent_custom_provider__"
const CUSTOM_PROVIDER_ID = /^[a-z0-9][a-z0-9-_]*$/

type ProviderEntry = { kind: "provider"; id: string; name: string } | { kind: "custom" }

export interface ProviderPanelProps {
  onConnected?(providerID: string): void
}

export function normalizeCustomProviderID(value: string) {
  const providerID = value.trim().replace(/^@ai-sdk\//, "")
  if (!CUSTOM_PROVIDER_ID.test(providerID)) return
  return providerID
}

function providerDescription(providerID: string) {
  if (providerID === "anthropic") return t("panel.provider.description.anthropic")
  if (providerID === "openai") return t("panel.provider.description.openai")
  return undefined
}

function providerGroup(providerID: string) {
  return providerID in PROVIDER_PRIORITY ? t("panel.provider.group.popular") : t("panel.provider.group.providers")
}

export function sortedProviders(list: readonly { id: string; name: string }[]) {
  return [...list].toSorted((left, right) => {
    const priority = (PROVIDER_PRIORITY[left.id] ?? 99) - (PROVIDER_PRIORITY[right.id] ?? 99)
    if (priority !== 0) return priority
    const name = left.name.toLowerCase().localeCompare(right.name.toLowerCase())
    if (name !== 0) return name
    return left.id.localeCompare(right.id)
  })
}

/** Opens the provider connection flow in the bottom-zone host. */
export function openProviderPanel(input: { host: PanelHostApi; onConnected?: (providerID: string) => void }) {
  if (input.host.stack().some((entry) => entry.id === "provider" || entry.id === "provider-flow")) return
  input.host.push({
    id: "provider",
    render: () => <ProviderPanel onConnected={input.onConnected} />,
  })
}

/**
 * `/connect`: provider list and the credential flow. The flow keeps method
 * selection and credential input in one host entry so it also fits beside an
 * open panel within MAX_PANEL_DEPTH.
 */
export function ProviderPanel(props: ProviderPanelProps) {
  const host = usePanelHost()
  const sync = useSync()
  const { theme } = useTheme()
  const connected = useConnected()
  const rootDepth = host.depth()

  const closeFlow = () => {
    while (host.depth() > 0 && host.depth() >= rootDepth) host.close()
  }

  const items = createMemo<ListItem<ProviderEntry>[]>(() => [
    ...sortedProviders(sync.data.provider_next.all).map((provider) => {
      const authenticated = sync.data.provider_next.connected.includes(provider.id)
      return {
        id: provider.id,
        value: { kind: "provider" as const, id: provider.id, name: provider.name },
        title: provider.name,
        description: providerDescription(provider.id),
        group: providerGroup(provider.id),
        lead: authenticated && connected() ? <text fg={theme.success}>✓</text> : undefined,
      }
    }),
    {
      id: CUSTOM_PROVIDER_OPTION,
      value: { kind: "custom" as const },
      title: t("panel.provider.custom.title"),
      description: t("panel.provider.custom.summary"),
      group: t("panel.provider.group.providers"),
    },
  ])

  function openFlow(providerID: string | undefined, methods: ProviderAuthMethod[], custom?: boolean) {
    host.push({
      id: "provider-flow",
      render: () => (
        <ProviderFlowPanel
          providerID={providerID}
          methods={methods}
          custom={custom}
          closeFlow={closeFlow}
          onConnected={props.onConnected}
        />
      ),
    })
  }

  function selectProvider(item: ListItem<ProviderEntry>) {
    const value = item.value
    if (value.kind === "custom") {
      openFlow(undefined, [{ type: "api", label: t("panel.provider.apiKey") }], true)
      return
    }

    const methods = sync.data.provider_auth[value.id] ?? []
    const list: ProviderAuthMethod[] =
      methods.length > 0 ? methods : [{ type: "api", label: t("panel.provider.apiKey") }]
    openFlow(value.id, list)
  }

  return <ListPanel title={t("panel.provider.title")} command="/connect" items={items()} onSelect={selectProvider} />
}

function AuthMethodPanel(props: { methods: readonly ProviderAuthMethod[]; onSelect(index: number): void }) {
  const items = createMemo<ListItem<number>[]>(() =>
    props.methods.map((method, index) => ({
      id: String(index),
      value: index,
      title: method.label,
    })),
  )

  return (
    <ListPanel
      title={t("panel.provider.method.title")}
      command="/connect"
      items={items()}
      onSelect={(item) => props.onSelect(item.value)}
    />
  )
}

function CustomProviderForm(props: { onSubmit(providerID: string): void }) {
  const toast = useToast()
  const { theme } = useTheme()

  return (
    <DetailPanel
      title={t("panel.provider.custom.title")}
      command="/connect"
      body={<text fg={theme.textMuted}>{t("panel.provider.custom.description")}</text>}
      input={{
        placeholder: t("panel.provider.custom.placeholder"),
        onSubmit(value) {
          const providerID = normalizeCustomProviderID(value)
          if (!providerID) {
            toast.show({
              text: t("panel.provider.custom.invalid"),
              level: "error",
            })
            return
          }
          props.onSubmit(providerID)
        },
      }}
      hints={[]}
    />
  )
}

/**
 * One host entry for method selection and credential input. Escape closes the
 * whole flow back to the provider list, and completion closes every flow layer.
 */
function ProviderFlowPanel(props: {
  providerID?: string
  methods: readonly ProviderAuthMethod[]
  custom?: boolean
  closeFlow(): void
  onConnected?(providerID: string): void
}) {
  const [customProviderID, setCustomProviderID] = createSignal<string>()
  const [methodIndex, setMethodIndex] = createSignal<number | undefined>(
    props.custom || props.methods.length === 1 ? 0 : undefined,
  )
  const providerID = () => customProviderID() ?? props.providerID
  const method = () => {
    const index = methodIndex()
    return index === undefined ? undefined : props.methods[index]
  }

  return (
    <Switch>
      <Match when={props.custom && !customProviderID()}>
        <CustomProviderForm onSubmit={setCustomProviderID} />
      </Match>
      <Match when={!props.custom && props.methods.length > 1 && methodIndex() === undefined}>
        <AuthMethodPanel methods={props.methods} onSelect={(index) => setMethodIndex(index)} />
      </Match>
      <Match when={method()} keyed>
        {(method) => (
          <MethodPanel
            providerID={providerID()!}
            method={method}
            index={methodIndex()!}
            custom={props.custom}
            closeFlow={props.closeFlow}
            onConnected={props.onConnected}
          />
        )}
      </Match>
    </Switch>
  )
}

type MethodStage = "prompt" | "authorizing" | "api" | "code" | "auto"

interface MethodPanelProps {
  providerID: string
  method: ProviderAuthMethod
  index: number
  custom?: boolean
  closeFlow(): void
  onConnected?(providerID: string): void
}

/** Collects auth prompts, then stores an API key or completes an OAuth handshake. */
function MethodPanel(props: MethodPanelProps) {
  const sdk = useSDK()
  const sync = useSync()
  const toast = useToast()
  const clipboard = useClipboard()
  const { theme } = useTheme()

  const prompts = () => props.method.prompts ?? []
  const firstPrompt = findPrompt(0, {})
  const [stage, setStage] = createSignal<MethodStage>(
    firstPrompt ? "prompt" : props.method.type === "api" ? "api" : "authorizing",
  )
  const [promptIndex, setPromptIndex] = createSignal(firstPrompt?.index ?? 0)
  const [inputs, setInputs] = createSignal<Record<string, string>>({})
  const [authorization, setAuthorization] = createSignal<ProviderAuthAuthorization>()
  const [codeError, setCodeError] = createSignal(false)
  let disposed = false

  onCleanup(() => {
    disposed = true
  })

  onMount(() => {
    if (stage() === "authorizing") void authorize({})
  })

  function findPrompt(start: number, values: Record<string, string>) {
    for (let index = start; index < prompts().length; index++) {
      const prompt = prompts()[index]!
      if (prompt.when) {
        const value = values[prompt.when.key]
        if (value === undefined) continue
        const matches = prompt.when.op === "eq" ? value === prompt.when.value : value !== prompt.when.value
        if (!matches) continue
      }
      return { prompt, index }
    }
    return undefined
  }

  function answer(key: string, value: string, index: number) {
    const next = { ...inputs(), [key]: value }
    setInputs(next)
    const prompt = findPrompt(index + 1, next)
    if (prompt) {
      setPromptIndex(prompt.index)
      setStage("prompt")
      return
    }
    if (props.method.type === "api") {
      setStage("api")
      return
    }
    setStage("authorizing")
    void authorize(next)
  }

  async function authorize(values: Record<string, string>) {
    const result = await sdk.client.provider.oauth.authorize({
      providerID: props.providerID,
      method: props.index,
      inputs: Object.keys(values).length > 0 ? values : undefined,
    })
    if (disposed) return
    if (result.error) {
      toast.show({
        text: JSON.stringify(result.error),
        level: "error",
      })
      props.closeFlow()
      return
    }
    const data = result.data
    if (!data) return
    setAuthorization(data)
    if (data.method === "code") {
      setStage("code")
      return
    }
    setStage("auto")
    void waitForAuto()
  }

  async function waitForAuto() {
    const result = await sdk.client.provider.oauth.callback({
      providerID: props.providerID,
      method: props.index,
    })
    if (disposed) return
    if (result.error) {
      const failed = "name" in result.error && result.error.name === "ProviderAuthOauthCallbackFailed"
      toast.show({
        text: failed ? t("panel.provider.oauth.failed") : JSON.stringify(result.error),
        level: "error",
      })
      props.closeFlow()
      return
    }
    await complete()
  }

  async function submitCode(value: string) {
    const result = await sdk.client.provider.oauth.callback({
      providerID: props.providerID,
      method: props.index,
      code: value,
    })
    if (disposed) return
    if (result.error) {
      setCodeError(true)
      return
    }
    await complete()
  }

  async function submitApiKey(value: string) {
    await sdk.client.auth.set({
      providerID: props.providerID,
      auth: {
        type: "api",
        key: value,
        ...(Object.keys(inputs()).length > 0 ? { metadata: inputs() } : {}),
      },
    })
    await complete()
  }

  async function complete() {
    await sdk.client.instance.dispose()
    await sync.bootstrap()
    if (disposed) return
    if (props.custom && !sync.data.provider_next.all.some((provider) => provider.id === props.providerID)) {
      toast.show({
        text: t("panel.provider.custom.saved", { providerID: props.providerID }),
        level: "info",
      })
      props.closeFlow()
      return
    }
    props.closeFlow()
    props.onConnected?.(props.providerID)
  }

  function copyCode() {
    const current = authorization()
    if (!current) return
    const code = current.instructions.match(/[A-Z0-9]{4}-[A-Z0-9]{4,5}/)?.[0] ?? current.url
    void clipboard
      .write?.(code)
      .then(() =>
        toast.show({
          text: t("panel.provider.copied"),
          level: "info",
        }),
      )
      .catch(toast.error)
  }

  useBindings(() => ({
    enabled: stage() === "auto" && authorization() !== undefined,
    commands: [
      {
        name: "provider.copy_code",
        title: t("panel.provider.copy"),
        category: "Panel",
        run: copyCode,
      },
    ],
    bindings: [{ key: "c", cmd: "provider.copy_code", desc: t("panel.provider.copy"), group: "Panel" }],
  }))

  const prompt = () => prompts()[promptIndex()]
  const autoHints = (): PanelHint[] => [{ key: "provider.copy_code", label: t("panel.provider.copy") }]

  return (
    <Switch>
      <Match when={stage() === "prompt" ? prompt() : undefined} keyed>
        {(current) =>
          current.type === "select" ? (
            <ListPanel
              title={current.message}
              command="/connect"
              items={current.options.map((option) => ({
                id: option.value,
                value: option.value,
                title: option.label,
                description: option.hint,
              }))}
              onSelect={(item) => answer(current.key, item.value, promptIndex())}
            />
          ) : (
            <DetailPanel
              title={current.message}
              command="/connect"
              input={{
                placeholder: current.placeholder ?? t("panel.provider.prompt.placeholder"),
                onSubmit: (value) => answer(current.key, value, promptIndex()),
              }}
              hints={[]}
            />
          )
        }
      </Match>
      <Match when={stage() === "authorizing"}>
        <DetailPanel
          title={props.method.label}
          command="/connect"
          body={<text fg={theme.textMuted}>{t("panel.provider.authorizing")}</text>}
          hints={[]}
        />
      </Match>
      <Match when={stage() === "api"}>
        <DetailPanel
          title={props.method.label}
          command="/connect"
          input={{ placeholder: t("panel.provider.apiKey.placeholder"), onSubmit: (value) => void submitApiKey(value) }}
          hints={[]}
        />
      </Match>
      <Match when={stage() === "code" ? authorization() : undefined} keyed>
        {(authorization) => (
          <DetailPanel
            title={props.method.label}
            command="/connect"
            body={
              <box gap={1}>
                <text fg={theme.textMuted}>{authorization.instructions}</text>
                <Link href={authorization.url} fg={theme.primary} />
                {codeError() ? <text fg={theme.error}>{t("panel.provider.code.invalid")}</text> : null}
              </box>
            }
            input={{
              placeholder: t("panel.provider.code.placeholder"),
              onSubmit: (value) => void submitCode(value),
            }}
            hints={[]}
          />
        )}
      </Match>
      <Match when={stage() === "auto" ? authorization() : undefined} keyed>
        {(authorization) => (
          <DetailPanel
            title={props.method.label}
            command="/connect"
            body={
              <box gap={1}>
                <Link href={authorization.url} fg={theme.primary} />
                <text fg={theme.textMuted}>{authorization.instructions}</text>
                <text fg={theme.textMuted}>{t("panel.provider.waiting")}</text>
              </box>
            }
            hints={autoHints()}
          />
        )}
      </Match>
    </Switch>
  )
}
