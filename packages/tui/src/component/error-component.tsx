import { release } from "node:os"
import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { createSignal, For, Show } from "solid-js"
import { getScrollAcceleration } from "../util/scroll"
import { useClipboard } from "../context/clipboard"
import { InstallationVersion } from "@graphagent/core/installation/version"
import { useExit } from "../context/exit"

export function ErrorComponent(props: { error: Error; reset: () => void; mode?: "dark" | "light" }) {
  const term = useTerminalDimensions()
  const exit = useExit()
  const clipboard = useClipboard()
  const [copied, setCopied] = createSignal(false)

  // Safe fallback palette per mode (mirrors theme/assets/graphagent.json) since
  // the theme context may be the thing that crashed.
  const isLight = props.mode === "light"
  const colors = isLight
    ? {
        bg: "#f7f7f5",
        element: "#e7e6e1",
        borderSubtle: "#d9d8d2",
        text: "#1f2024",
        muted: "#62625c",
        primary: "#1f6fc4",
        onPrimary: "#f7f7f5",
        error: "#a94a38",
        success: "#6b6a64",
      }
    : {
        bg: "#17171a",
        element: "#212226",
        borderSubtle: "#2c2d31",
        text: "#d6d5cf",
        muted: "#8b8a84",
        primary: "#4fa3f0",
        onPrimary: "#17171a",
        error: "#d7826f",
        success: "#a9a8a1",
      }

  const message = props.error.message || "An unknown error occurred."
  const stack = props.error.stack || "No stack trace available."
  const issueURL = buildIssueURL(message, stack)

  const copyReport = () => {
    void clipboard.write?.(issueURL.toString()).then(() => setCopied(true))
  }

  const actions = [
    { key: "c", label: () => (copied() ? "✓ Copied" : "Copy report"), copy: true, onUse: copyReport },
    { key: "r", label: () => "Restart", onUse: props.reset },
    { key: "q", label: () => "Quit", onUse: () => exit() },
  ]
  const [selected, setSelected] = createSignal(0)
  const move = (delta: number) => setSelected((prev) => (prev + delta + actions.length) % actions.length)
  let scroll: ScrollBoxRenderable | undefined

  useKeyboard((evt) => {
    if (evt.ctrl && evt.name === "c") return exit()
    if (evt.name === "return") {
      evt.preventDefault()
      evt.stopPropagation()
      return actions[selected()].onUse()
    }
    if (evt.name === "left") {
      evt.preventDefault()
      evt.stopPropagation()
      return move(-1)
    }
    if (evt.name === "right") {
      evt.preventDefault()
      evt.stopPropagation()
      return move(1)
    }
    if (evt.name === "tab") {
      evt.preventDefault()
      evt.stopPropagation()
      return move(evt.shift ? -1 : 1)
    }
    // Vertical keys scroll the stack trace; buttons navigate horizontally.
    if (evt.name === "up") return scroll?.scrollBy(-1)
    if (evt.name === "down") return scroll?.scrollBy(1)
    if (evt.name === "pageup" && scroll) return scroll.scrollBy(-scroll.height)
    if (evt.name === "pagedown" && scroll) return scroll.scrollBy(scroll.height)
    if (evt.name === "home" && scroll) return scroll.scrollTo(0)
    if (evt.name === "end" && scroll) return scroll.scrollTo(scroll.scrollHeight)
    if (evt.name === "q") return exit()
    if (evt.name === "c") return copyReport()
    if (evt.name === "r") return props.reset()
  })

  // Responsive thresholds.
  const contentWidth = () => Math.min(84, Math.max(24, term().width - 4))
  const showSubtext = () => term().height >= 18
  const showFooter = () => term().height >= 20

  return (
    <box
      width={term().width}
      height={term().height}
      backgroundColor={colors.bg}
      flexDirection="column"
      alignItems="center"
    >
      <box width={contentWidth()} flexGrow={1} flexDirection="column" paddingTop={1} paddingBottom={1} gap={1}>
        {/* Headline */}
        <box flexDirection="column" alignItems="center" flexShrink={0}>
          <text attributes={TextAttributes.BOLD} fg={colors.text}>
            opencode crashed
          </text>
          <Show when={showSubtext()}>
            <text fg={colors.muted}>An unexpected error stopped the session.</text>
          </Show>
        </box>

        {/* Error message panel */}
        <box
          flexShrink={0}
          border
          borderStyle="rounded"
          borderColor={colors.error}
          title=" Error "
          titleColor={colors.error}
          paddingLeft={2}
          paddingRight={2}
        >
          <text fg={colors.text}>{message}</text>
        </box>

        {/* Actions */}
        <box flexDirection="row" flexWrap="wrap" justifyContent="center" gap={2} rowGap={1} flexShrink={0}>
          <For each={actions}>
            {(action, index) => {
              const isSelected = () => selected() === index()
              const isCopied = () => action.copy && copied()
              return (
                <box flexDirection="column" alignItems="center" flexShrink={0}>
                  <box
                    onMouseDown={() => setSelected(index())}
                    onMouseUp={() => action.onUse()}
                    backgroundColor={isCopied() ? colors.success : isSelected() ? colors.primary : colors.element}
                    minWidth={15}
                    alignItems="center"
                    paddingLeft={2}
                    paddingRight={2}
                  >
                    <text
                      attributes={TextAttributes.BOLD}
                      fg={isCopied() || isSelected() ? colors.onPrimary : colors.text}
                    >
                      {action.label()}
                    </text>
                  </box>
                  <text fg={isSelected() ? colors.primary : colors.muted}>{action.key}</text>
                </box>
              )
            }}
          </For>
        </box>

        {/* Stack trace */}
        <box
          flexGrow={1}
          flexBasis={0}
          minHeight={3}
          border
          borderStyle="rounded"
          borderColor={colors.borderSubtle}
          title=" Stack trace "
          titleColor={colors.muted}
          bottomTitle=" ↑↓ scroll "
          bottomTitleAlignment="right"
          paddingLeft={1}
          paddingRight={1}
        >
          <scrollbox
            ref={(element: ScrollBoxRenderable) => (scroll = element)}
            flexGrow={1}
            scrollAcceleration={getScrollAcceleration()}
          >
            <text fg={colors.muted}>{stack}</text>
          </scrollbox>
        </box>

        {/* Footer */}
        <Show when={showFooter()}>
          <box flexDirection="column" alignItems="center" flexShrink={0}>
            <text fg={colors.muted}>
              {copied()
                ? "Report copied — paste it into a new GitHub issue."
                : "Copy the report and open a GitHub issue to help us fix this."}
            </text>
            <text fg={colors.muted}>opencode {InstallationVersion}</text>
          </box>
        </Show>
      </box>
    </box>
  )
}

function buildIssueURL(message: string, stack: string) {
  // Prefill a crash report against this repository's issue tracker. No issue
  // template is published, so GitHub ignores unknown query parameters; the
  // branded fields still keep the copied report self-describing.
  const url = new URL("https://github.com/LeXwDeX/GraphAgent/issues/new")
  url.searchParams.set("title", `TUI crash: ${message}`)
  url.searchParams.set("graphagent-version", InstallationVersion)
  url.searchParams.set("os", describeOS())
  url.searchParams.set("terminal", describeTerminal())
  url.searchParams.set(
    "reproduce",
    "Reported automatically from the GraphAgent crash screen. If you can, describe what you were doing when it crashed.",
  )

  // Budget the stack against the fully URL-encoded length (not the raw length) so
  // the final link stays under GitHub's practical limit; flag truncation so a
  // clipped trace is obvious. searchParams.set handles encoding without throwing,
  // so measuring url.toString() is both correct and safe on any input.
  const MAX_URL_LENGTH = 6000
  const marker = "\n... (truncated)"
  const head = `The GraphAgent TUI crashed with an unexpected error.\n\n**Error:** ${message}\n\n**Stack trace:**\n`
  const setBody = (body: string) => url.searchParams.set("description", head + "```\n" + body + "\n```")

  setBody(stack)
  if (url.toString().length <= MAX_URL_LENGTH) return url

  // Largest raw stack prefix whose encoded URL (with the marker) still fits.
  let lo = 0
  let hi = stack.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    setBody(stack.slice(0, mid) + marker)
    if (url.toString().length <= MAX_URL_LENGTH) lo = mid
    else hi = mid - 1
  }
  setBody(stack.slice(0, lo) + marker)
  return url
}

function describeOS() {
  const name =
    process.platform === "darwin"
      ? "macOS"
      : process.platform === "win32"
        ? "Windows"
        : process.platform === "linux"
          ? "Linux"
          : process.platform
  return `${name} ${release()} (${process.arch})`
}

function describeTerminal() {
  const program = process.env.TERM_PROGRAM || process.env.TERM || "unknown"
  const version = process.env.TERM_PROGRAM_VERSION ? ` ${process.env.TERM_PROGRAM_VERSION}` : ""
  const multiplexer = process.env.TMUX ? " in tmux" : process.env.STY ? " in screen" : ""
  return `${program}${version}${multiplexer}`
}
