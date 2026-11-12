import { createStore } from "solid-js/store"
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { useRenderer, useTerminalDimensions } from "@opentui/solid"
import type { TextareaRenderable } from "@opentui/core"
import { tint, useTheme } from "../../context/theme"
import type { QuestionAnswer, QuestionRequest } from "@graphagent/sdk"
import { useSDK, locationHeaders } from "../../context/sdk"
import { useSync } from "../../context/sync"
import { useTuiConfig } from "../../config"
import { EscapePriority, GRAPHAGENT_BASE_MODE, useBindings } from "../../keymap"
import { useToast } from "../../ui/toast"
import { truncateCells } from "../../ui/width"
import { useTicker } from "../../context/ticker-context"
import { PanelShell, type PanelHint, type PanelTab } from "../../panel/shell"
import { t } from "../../i18n"
import { askSourceLabel } from "../../ask/ask-queue"

const INTERACTION_HEARTBEAT_MILLIS = 250
const CONFIRM_TAB = "confirm"

export interface QuestionPromptProps {
  request: QuestionRequest
  /** Session being viewed; decides whether a source label is shown. */
  currentSessionID: string
  /** Root of the queue's session tree; only its own questions accept free text. */
  rootSessionID: string
  /** 1-based position in the shared ask queue. */
  position: number
  total: number
  /** Directory of the requesting session, not the session being viewed. */
  directory?: string
}

export function QuestionPrompt(props: QuestionPromptProps) {
  const sdk = useSDK()
  const { theme } = useTheme()
  const renderer = useRenderer()
  const dimensions = useTerminalDimensions()
  const tuiConfig = useTuiConfig()
  const toast = useToast()
  const ticker = useTicker()
  const sync = useSync()

  const questions = createMemo(() => props.request.questions)
  const single = createMemo(() => questions().length === 1 && questions()[0]?.multiple !== true)
  const own = createMemo(() => props.request.sessionID === props.rootSessionID)
  const headerBudget = createMemo(() =>
    Math.min(24, Math.max(6, Math.floor((dimensions().width - 8) / Math.max(1, questions().length + 1)))),
  )
  const [interacted, setInteracted] = createSignal(false)
  const [remaining, setRemaining] = createSignal<number | undefined>(undefined)
  const [store, setStore] = createStore({
    tab: 0,
    answers: [] as QuestionAnswer[],
    custom: [] as string[],
    selected: 0,
    editing: false,
    interacting: false,
  })

  let textarea: TextareaRenderable | undefined
  let requestID = props.request.id
  let lastInteractionSentAt = 0

  const question = createMemo(() => questions()[store.tab])
  const confirm = createMemo(() => !single() && store.tab === questions().length)
  const options = createMemo(() => question()?.options ?? [])
  const allowCustom = createMemo(() => question()?.custom !== false && own())
  const other = createMemo(() => allowCustom() && store.selected === options().length)
  const input = createMemo(() => store.custom[store.tab] ?? "")
  const multi = createMemo(() => question()?.multiple === true)
  const customPicked = createMemo(() => {
    const value = input()
    if (!value) return false
    return store.answers[store.tab]?.includes(value) ?? false
  })
  const rows = createMemo(() => options().length + (allowCustom() ? 1 : 0))

  const source = createMemo(() =>
    askSourceLabel(
      { session: sync.data.session, taskIndex: sync.data.taskIndex },
      props.request.sessionID,
      props.currentSessionID,
    ),
  )
  const title = createMemo(() => {
    const label = source() ? t("ask.title.questionSource", { source: source()! }) : t("ask.title.question")
    return `${props.position}/${props.total} · ${label}`
  })

  const questionTabs = createMemo<PanelTab[]>(() => {
    if (single()) return []
    const items: PanelTab[] = questions().map((item, index) => ({
      id: String(index),
      label: truncateCells(item.header, headerBudget()),
      badge: (store.answers[index]?.length ?? 0) > 0 ? "✓" : undefined,
    }))
    items.push({ id: CONFIRM_TAB, label: t("ask.question.confirm") })
    return items
  })
  const activeTab = createMemo(() => (confirm() ? CONFIRM_TAB : String(store.tab)))

  function notFound(error: unknown, response?: Response) {
    if (response?.status === 404) return true
    if (typeof error === "object" && error !== null && "_tag" in error) {
      return (error as { _tag?: unknown })._tag === "QuestionNotFoundError"
    }
    if (!(error instanceof Error) || typeof error.cause !== "object" || error.cause === null) return false
    return (error.cause as { status?: unknown }).status === 404
  }

  function interactionError(error: unknown) {
    if (error instanceof Error) return error
    if (typeof error === "object" && error !== null && "message" in error) {
      const message = (error as { message?: unknown }).message
      if (typeof message === "string") return new Error(message)
    }
    return new Error("Failed to cancel the question timeout")
  }

  function stopCountdown() {
    setRemaining(undefined)
  }

  async function interact() {
    const id = props.request.id
    if (store.interacting || ticker.now() - lastInteractionSentAt < INTERACTION_HEARTBEAT_MILLIS) return
    setStore("interacting", true)
    try {
      const result = await sdk.client.question.interact(
        { requestID: id },
        { headers: locationHeaders({ directory: props.directory }) },
      )
      if (props.request.id !== id) return
      if (result.error && !notFound(result.error, result.response)) {
        toast.error(interactionError(result.error))
        return
      }
      lastInteractionSentAt = ticker.now()
      setInteracted(true)
      stopCountdown()
    } catch (error) {
      if (props.request.id !== id) return
      if (notFound(error)) {
        lastInteractionSentAt = ticker.now()
        setInteracted(true)
        stopCountdown()
        return
      }
      toast.error(interactionError(error))
    } finally {
      if (props.request.id === id) setStore("interacting", false)
    }
  }

  createEffect(() => {
    const id = props.request.id
    if (requestID === id) return
    requestID = id
    lastInteractionSentAt = 0
    setInteracted(false)
    setRemaining(undefined)
    setStore({
      tab: 0,
      answers: [],
      custom: [],
      selected: 0,
      editing: false,
      interacting: false,
    })
  })

  // The question surface only exists while it is the visible ask head, so the
  // one-second subscription lives exactly as long as the countdown is on screen.
  createEffect(() => {
    const expiresAt = Number(props.request.expiresAt)
    if (!Number.isFinite(expiresAt) || interacted()) {
      setRemaining(undefined)
      return
    }
    ticker.second()
    setRemaining(Math.max(0, Math.ceil((expiresAt - ticker.now()) / 1000)))
    const off = ticker.subscribeSecond()
    onCleanup(off)
  })

  function submit() {
    const answers = questions().map((_, i) => store.answers[i] ?? [])
    void sdk.client.question.reply(
      { requestID: props.request.id, answers },
      { headers: locationHeaders({ directory: props.directory }) },
    )
  }

  function reject() {
    void sdk.client.question.reject(
      { requestID: props.request.id },
      { headers: locationHeaders({ directory: props.directory }) },
    )
  }

  function pick(answer: string, custom: boolean = false) {
    const answers = [...store.answers]
    answers[store.tab] = [answer]
    setStore("answers", answers)
    if (custom) {
      const inputs = [...store.custom]
      inputs[store.tab] = answer
      setStore("custom", inputs)
    }
    if (single()) {
      void sdk.client.question.reply(
        { requestID: props.request.id, answers: [[answer]] },
        { headers: locationHeaders({ directory: props.directory }) },
      )
      return
    }
    selectTab(Math.min(store.tab + 1, questions().length))
  }

  function toggle(answer: string) {
    const existing = store.answers[store.tab] ?? []
    const next = [...existing]
    const index = next.indexOf(answer)
    if (index === -1) next.push(answer)
    if (index !== -1) next.splice(index, 1)
    const answers = [...store.answers]
    answers[store.tab] = next
    setStore("answers", answers)
  }

  function moveTo(index: number) {
    setStore("selected", index)
  }

  function selectTab(index: number) {
    setStore("editing", false)
    setStore("tab", index)
    setStore("selected", 0)
  }

  function selectOption() {
    if (confirm()) {
      submit()
      return
    }
    if (other()) {
      if (!multi()) {
        setStore("editing", true)
        return
      }
      const value = input()
      if (value && customPicked()) {
        void interact()
        toggle(value)
        return
      }
      setStore("editing", true)
      return
    }
    const opt = options()[store.selected]
    if (!opt) return
    void interact()
    if (multi()) {
      toggle(opt.label)
      return
    }
    pick(opt.label)
  }

  function toggleSelected() {
    if (confirm() || !multi()) return
    if (other()) {
      const value = input()
      if (value) {
        void interact()
        toggle(value)
        return
      }
      setStore("editing", true)
      return
    }
    const opt = options()[store.selected]
    if (!opt) return
    void interact()
    toggle(opt.label)
  }

  const hints = createMemo<PanelHint[]>(() => {
    if (confirm()) return [{ key: "ask.question.submit", label: t("ask.hint.submit") }]
    const result: PanelHint[] = []
    if (rows() > 1) {
      result.push({ key: "ask.question.previous", label: t("ask.hint.previous") })
      result.push({ key: "ask.question.next", label: t("ask.hint.next") })
    }
    if (questionTabs().length > 0) result.push({ key: "ask.question.tab.next", label: t("ask.hint.tab") })
    if (multi()) result.push({ key: "ask.question.toggle", label: t("ask.hint.toggle") })
    result.push({ key: "ask.question.select", label: multi() ? t("ask.hint.toggle") : t("ask.hint.select") })
    result.push({ key: "ask.question.reject", label: t("ask.hint.reject") })
    return result
  })

  useBindings(() => {
    const total = rows()
    const max = Math.min(total, 9)
    return {
      mode: GRAPHAGENT_BASE_MODE,
      priority: EscapePriority.modal,
      enabled: () => !store.editing,
      commands: [
        { name: "app.exit", title: "Reject question", category: "Ask", run: reject },
        {
          name: "ask.question.previous",
          title: "Previous answer",
          category: "Ask",
          run: () => moveTo((store.selected - 1 + total) % Math.max(1, total)),
        },
        {
          name: "ask.question.next",
          title: "Next answer",
          category: "Ask",
          run: () => moveTo((store.selected + 1) % Math.max(1, total)),
        },
        { name: "ask.question.select", title: "Select answer", category: "Ask", run: selectOption },
        { name: "ask.question.submit", title: "Submit answers", category: "Ask", run: submit },
        { name: "ask.question.toggle", title: "Toggle answer", category: "Ask", run: toggleSelected },
        {
          name: "ask.question.tab.next",
          title: "Next question",
          category: "Ask",
          run: () => selectTab((store.tab + 1) % Math.max(1, questionTabs().length)),
        },
        {
          name: "ask.question.tab.previous",
          title: "Previous question",
          category: "Ask",
          run: () => selectTab((store.tab - 1 + questionTabs().length) % Math.max(1, questionTabs().length)),
        },
        { name: "ask.question.reject", title: "Reject question", category: "Ask", run: reject },
      ],
      bindings: [
        ...(confirm()
          ? [
              { key: "return", desc: "Submit answers", group: "Ask", cmd: "ask.question.submit" },
              ...tuiConfig.keybinds.get("app.exit"),
            ]
          : [
              ...Array.from({ length: max }, (_, index) => ({
                key: String(index + 1),
                desc: `Select answer ${index + 1}`,
                group: "Ask",
                cmd: () => {
                  moveTo(index)
                  selectOption()
                },
              })),
              {
                key: "up",
                desc: "Previous answer",
                group: "Ask",
                cmd: "ask.question.previous",
              },
              {
                key: "k",
                desc: "Previous answer",
                group: "Ask",
                cmd: "ask.question.previous",
              },
              { key: "down", desc: "Next answer", group: "Ask", cmd: "ask.question.next" },
              { key: "j", desc: "Next answer", group: "Ask", cmd: "ask.question.next" },
              { key: "return", desc: "Select answer", group: "Ask", cmd: "ask.question.select" },
              ...(multi() ? [{ key: "space", desc: "Toggle answer", group: "Ask", cmd: "ask.question.toggle" }] : []),
              ...tuiConfig.keybinds.get("app.exit"),
            ]),
        ...(questionTabs().length > 1
          ? [
              { key: "left", desc: "Previous question", group: "Ask", cmd: "ask.question.tab.previous" },
              { key: "h", desc: "Previous question", group: "Ask", cmd: "ask.question.tab.previous" },
              { key: "right", desc: "Next question", group: "Ask", cmd: "ask.question.tab.next" },
              { key: "l", desc: "Next question", group: "Ask", cmd: "ask.question.tab.next" },
              {
                key: "tab",
                desc: "Next question",
                group: "Ask",
                cmd: ({ event }: { event: { shift: boolean } }) => {
                  const size = questionTabs().length
                  selectTab((store.tab + (event.shift ? -1 : 1) + size) % size)
                },
              },
            ]
          : []),
      ],
    }
  })

  useBindings(() => ({
    mode: GRAPHAGENT_BASE_MODE,
    enabled: () => store.editing && !confirm(),
    priority: EscapePriority.askSub,
    commands: [
      {
        name: "prompt.clear",
        title: "Clear answer edit",
        category: "Ask",
        run() {
          const text = textarea?.plainText ?? ""
          if (!text) {
            setStore("editing", false)
            return
          }
          textarea?.setText("")
        },
      },
    ],
    bindings: [
      ...tuiConfig.keybinds.get("prompt.clear"),
      {
        key: "return",
        desc: "Submit answer edit",
        group: "Ask",
        cmd: () => {
          const text = textarea?.plainText?.trim() ?? ""
          const prev = store.custom[store.tab]

          if (!text) {
            if (prev) {
              const inputs = [...store.custom]
              inputs[store.tab] = ""
              setStore("custom", inputs)

              const answers = [...store.answers]
              answers[store.tab] = (answers[store.tab] ?? []).filter((value) => value !== prev)
              setStore("answers", answers)
            }
            setStore("editing", false)
            return
          }

          if (multi()) {
            const inputs = [...store.custom]
            inputs[store.tab] = text
            setStore("custom", inputs)

            const existing = store.answers[store.tab] ?? []
            const next = [...existing]
            if (prev) {
              const index = next.indexOf(prev)
              if (index !== -1) next.splice(index, 1)
            }
            if (!next.includes(text)) next.push(text)
            const answers = [...store.answers]
            answers[store.tab] = next
            setStore("answers", answers)
            setStore("editing", false)
            return
          }

          pick(text, true)
          setStore("editing", false)
        },
      },
    ],
  }))

  useBindings(() => ({
    enabled: () => store.editing && !confirm(),
    priority: EscapePriority.askSub,
    bindings: [
      {
        key: "escape",
        desc: "Cancel answer edit",
        group: "Ask",
        cmd: () => {
          setStore("editing", false)
        },
      },
    ],
  }))

  useBindings(() => ({
    enabled: () => !store.editing,
    priority: EscapePriority.ask,
    bindings: [{ key: "escape", desc: "Reject question", group: "Ask", cmd: "ask.question.reject" }],
  }))

  const answerContent = () => (
    <box flexDirection="column" gap={1}>
      <box paddingLeft={1}>
        <text fg={theme.text}>
          {question()?.question}
          {multi() ? t("ask.question.multi") : ""}
        </text>
      </box>
      <box>
        <For each={options()}>
          {(opt, index) => {
            const active = () => index() === store.selected
            const picked = () => store.answers[store.tab]?.includes(opt.label) ?? false
            return (
              <box
                onMouseOver={() => moveTo(index())}
                onMouseDown={() => moveTo(index())}
                onMouseUp={() => {
                  if (renderer.getSelection()?.getSelectedText()) return
                  moveTo(index())
                  selectOption()
                }}
              >
                <box flexDirection="row">
                  <box backgroundColor={active() ? theme.backgroundElement : undefined} paddingRight={1}>
                    <text fg={active() ? tint(theme.textMuted, theme.secondary, 0.6) : theme.textMuted}>
                      {`${index() + 1}.`}
                    </text>
                  </box>
                  <box backgroundColor={active() ? theme.backgroundElement : undefined}>
                    <text fg={active() ? theme.secondary : picked() ? theme.success : theme.text}>
                      {multi() ? `[${picked() ? "✓" : " "}] ${opt.label}` : opt.label}
                    </text>
                  </box>
                  <Show when={!multi()}>
                    <text fg={theme.success}>{picked() ? " ✓" : ""}</text>
                  </Show>
                </box>
                <box paddingLeft={3}>
                  <text fg={theme.textMuted}>{opt.description}</text>
                </box>
              </box>
            )
          }}
        </For>
        <Show when={allowCustom()}>
          <box
            onMouseOver={() => moveTo(options().length)}
            onMouseDown={() => moveTo(options().length)}
            onMouseUp={() => {
              if (renderer.getSelection()?.getSelectedText()) return
              moveTo(options().length)
              selectOption()
            }}
          >
            <box flexDirection="row">
              <box backgroundColor={other() ? theme.backgroundElement : undefined} paddingRight={1}>
                <text fg={other() ? tint(theme.textMuted, theme.secondary, 0.6) : theme.textMuted}>
                  {`${options().length + 1}.`}
                </text>
              </box>
              <box backgroundColor={other() ? theme.backgroundElement : undefined}>
                <text fg={other() ? theme.secondary : customPicked() ? theme.success : theme.text}>
                  {multi() ? `[${customPicked() ? "✓" : " "}] ${t("ask.question.custom")}` : t("ask.question.custom")}
                </text>
              </box>
              <Show when={!multi()}>
                <text fg={theme.success}>{customPicked() ? " ✓" : ""}</text>
              </Show>
            </box>
            <Show when={store.editing}>
              <box paddingLeft={3}>
                <textarea
                  ref={(value: TextareaRenderable) => {
                    textarea = value
                    value.traits = { status: "ANSWER" }
                    queueMicrotask(() => {
                      value.focus()
                      value.gotoLineEnd()
                      void interact()
                    })
                  }}
                  initialValue={input()}
                  onContentChange={() => void interact()}
                  placeholder={t("ask.question.placeholder")}
                  placeholderColor={theme.textMuted}
                  minHeight={1}
                  maxHeight={6}
                  textColor={theme.text}
                  focusedTextColor={theme.text}
                  cursorColor={theme.primary}
                />
              </box>
            </Show>
            <Show when={!store.editing && input()}>
              <box paddingLeft={3}>
                <text fg={theme.textMuted}>{input()}</text>
              </box>
            </Show>
          </box>
        </Show>
      </box>
      <Show when={remaining() !== undefined}>
        <box flexDirection="row" justifyContent="flex-end" paddingRight={1}>
          <text fg={theme.warning}>{t("ask.question.timeout", { seconds: remaining()! })}</text>
        </box>
      </Show>
    </box>
  )

  const confirmContent = () => (
    <box flexDirection="column" gap={1}>
      <box paddingLeft={1}>
        <text fg={theme.text}>{t("ask.question.review")}</text>
      </box>
      <For each={questions()}>
        {(item, index) => {
          const value = () => store.answers[index()]?.join(", ") ?? ""
          const answered = () => Boolean(value())
          return (
            <box paddingLeft={1}>
              <text>
                <span style={{ fg: theme.textMuted }}>{item.header}:</span>{" "}
                <span style={{ fg: answered() ? theme.text : theme.error }}>
                  {answered() ? value() : t("ask.question.unanswered")}
                </span>
              </text>
            </box>
          )
        }}
      </For>
      <Show when={remaining() !== undefined}>
        <box flexDirection="row" justifyContent="flex-end" paddingRight={1}>
          <text fg={theme.warning}>{t("ask.question.timeout", { seconds: remaining()! })}</text>
        </box>
      </Show>
    </box>
  )

  return (
    <PanelShell
      title={title()}
      tabs={questionTabs()}
      activeTab={activeTab()}
      onTab={(id) => {
        if (id === CONFIRM_TAB) selectTab(questions().length)
        else selectTab(Number(id))
      }}
      hints={hints()}
    >
      <Show when={!confirm()} fallback={confirmContent()}>
        {answerContent()}
      </Show>
    </PanelShell>
  )
}
