/** @jsxImportSource @opentui/solid */
import {
  BoxRenderable,
  CodeRenderable,
  DiffRenderable,
  getTreeSitterClient,
  LineNumberRenderable,
  TextBuffer,
  TextBufferView,
  type Renderable,
  type ScrollBoxRenderable,
  type SimpleHighlight,
  type TreeSitterClient,
} from "@opentui/core"
import { useRenderer, type JSX } from "@opentui/solid"
import { batch, createMemo, createSignal, For, onCleanup, Show, splitProps } from "solid-js"
import { splitAddedPatch, type AddedPatchChunk } from "../util/added-patch"

export interface PatchDiffRef {
  hunks(): { node: Renderable; offset: number }[]
}

type DiffProps = Omit<JSX.IntrinsicElements["diff"], "ref" | "treeSitterClient"> & {
  treeSitterClient?: TreeSitterClient
}
type Props = DiffProps & { scroll?: () => ScrollBoxRenderable | undefined; ref?: (ref: PatchDiffRef) => void }
const CHUNK_LINES = 128
const MIN_LINES = 3000

export function PatchDiff(props: Props) {
  const [local, diffProps] = splitProps(props, ["scroll", "ref"])
  const chunks = createMemo(() => {
    if (!local.scroll) return undefined
    const result = splitAddedPatch(diffProps.diff ?? "", CHUNK_LINES)
    return result && result.reduce((sum, chunk) => sum + chunk.rows, 0) > MIN_LINES ? result : undefined
  })
  let full: DiffRenderable | undefined
  let virtual: BoxRenderable | undefined
  local.ref?.({
    hunks: () => {
      if (chunks()) return virtual && !virtual.isDestroyed ? [{ node: virtual, offset: 0 }] : []
      return full && !full.isDestroyed ? full.getHunkRowOffsets().map((offset) => ({ node: full!, offset })) : []
    },
  })
  return (
    <Show when={chunks()} fallback={<diff {...diffProps} ref={(node: DiffRenderable) => (full = node)} />}>
      {(items) => (
        <VirtualAddedPatch
          chunks={items()}
          scroll={local.scroll!}
          diffProps={diffProps}
          ref={(node) => (virtual = node)}
        />
      )}
    </Show>
  )
}

function VirtualAddedPatch(props: {
  chunks: readonly AddedPatchChunk[]
  scroll: () => ScrollBoxRenderable | undefined
  diffProps: DiffProps
  ref: (root: BoxRenderable) => void
}) {
  const renderer = useRenderer()
  const [width, setWidth] = createSignal(0)
  const [first, setFirst] = createSignal(0)
  const [last, setLast] = createSignal(0)
  const mounted = new Map<DiffRenderable, () => void>()
  const count = createMemo(() => props.chunks.reduce((sum, chunk) => sum + chunk.rows, 0))
  const source = createMemo(() => props.chunks.map((chunk) => chunk.content).join("\n"))
  const highlights = createMemo(() => {
    const filetype = props.diffProps.filetype
    return filetype
      ? (props.diffProps.treeSitterClient ?? getTreeSitterClient())
          .highlightOnce(source(), filetype)
          .then((result) => result.highlights)
          .catch(() => undefined)
      : undefined
  })
  // Use OpenTUI's own wrapping engine so placeholders preserve tabs, wide characters and word wrapping.
  // This buffer measures text only; it never mounts offscreen diff/code renderables.
  const buffer = TextBuffer.create(renderer.widthMethod)
  const view = TextBufferView.create(buffer)
  onCleanup(() => {
    view.destroy()
    buffer.destroy()
  })
  const layout = createMemo(() => {
    const gutter = props.diffProps.showLineNumbers === false ? 0 : String(count()).length + 4
    const columns = Math.max(1, Math.floor(width() / (props.diffProps.view === "split" ? 2 : 1)) - gutter)
    const wrapMode = props.diffProps.wrapMode ?? "none"
    view.setWrapMode(wrapMode)
    let top = 0
    const positions = props.chunks.map((chunk) => {
      buffer.setText(chunk.content)
      const height = width()
        ? Math.max(chunk.rows, view.measureForDimensions(columns, 0)?.lineCount ?? chunk.rows)
        : chunk.rows
      const item = { top, height }
      top += height
      return item
    })
    return { columns, wrapMode, positions }
  })
  let previous: ReturnType<typeof layout> | undefined
  let previousChunks: readonly AddedPatchChunk[] | undefined
  let previousOffset = 0
  const lineSources = (chunk: AddedPatchChunk, geometry: ReturnType<typeof layout>) => {
    buffer.setText(chunk.content)
    view.setWrapMode(geometry.wrapMode)
    view.setWrapWidth(geometry.columns)
    return view.getLineSources(0, view.getVirtualLineCount())
  }
  const register = (node: DiffRenderable, chunk: AddedPatchChunk) => {
    let alive = true
    const configured = new WeakSet<CodeRenderable>()
    onCleanup(() => {
      alive = false
      mounted.delete(node)
    })
    const configure = () => {
      if (!alive || node.isDestroyed) return
      for (const side of node.getChildren()) {
        if (!(side instanceof LineNumberRenderable)) continue
        if (side.getLineNumbers().get(-1) !== count()) {
          const numbers = new Map(side.getLineNumbers())
          numbers.set(-1, count())
          side.setLineNumbers(numbers)
        }
        if (side.getLineSigns().get(-1)?.after !== "  ") {
          const signs = new Map(side.getLineSigns())
          signs.set(-1, { after: "  " })
          side.setLineSigns(signs)
        }
      }
      for (const code of codes(node)) {
        if (!code.content || configured.has(code)) continue
        configured.add(code)
        code.onHighlight = async () => {
          const pending = highlights()
          const all = await pending
          if (!alive || code.isDestroyed || pending !== highlights() || !all) return undefined
          const start = chunk.offset
          const end = start + chunk.content.length
          return all.flatMap((highlight): SimpleHighlight[] =>
            highlight[0] < end && highlight[1] > start
              ? [
                  [
                    Math.max(highlight[0], start) - start,
                    Math.min(highlight[1], end) - start,
                    highlight[2],
                    highlight[3],
                  ],
                ]
              : [],
          )
        }
      }
    }
    mounted.set(node, configure)
    queueMicrotask(configure)
  }
  return (
    <box
      width="100%"
      ref={(root: BoxRenderable) => {
        props.ref(root)
        root.onLifecyclePass = () => {
          const scroll = props.scroll()
          if (!scroll || root.width <= 0) return
          // View changes rebuild DiffRenderable's sides without re-running its Solid ref.
          for (const configure of mounted.values()) configure()
          setWidth(root.width)
          const geometry = layout()
          if (previousChunks !== props.chunks) previous = undefined
          const offset = root.y - scroll.content.y
          let top = scroll.scrollTop - offset
          if (previous && (previous.columns !== geometry.columns || previous.wrapMode !== geometry.wrapMode)) {
            const oldTop = scroll.scrollTop - previousOffset
            const index = previous.positions.findIndex((item) => item.top + item.height > oldTop)
            if (oldTop >= 0 && index !== -1) {
              // Preserve the source line at the viewport edge when wrapping changes above it.
              const line = lineSources(props.chunks[index], previous)[
                Math.max(0, Math.floor(oldTop - previous.positions[index].top))
              ]
              const row = lineSources(props.chunks[index], geometry).indexOf(line)
              if (row !== -1) {
                const nextTop = geometry.positions[index].top + row
                scroll.scrollBy(nextTop - top)
                top = nextTop
              }
            }
          }
          previous = geometry
          previousChunks = props.chunks
          previousOffset = offset
          const bottom = top + scroll.viewport.height
          const positions = geometry.positions
          batch(() => {
            const start = positions.findIndex((item) => item.top + item.height > top)
            setFirst(start === -1 ? positions.length - 1 : start)
            const end = positions.findIndex((item) => item.top >= bottom)
            setLast(end === -1 ? positions.length - 1 : Math.max(0, end - 1))
          })
        }
        renderer.registerLifecyclePass(root)
        onCleanup(() => renderer.unregisterLifecyclePass(root))
      }}
    >
      <For each={props.chunks}>
        {(chunk, index) => (
          <Show
            when={index() >= first() - 1 && index() <= last() + 1}
            fallback={<box height={layout().positions[index()].height} />}
          >
            <diff
              {...props.diffProps}
              ref={(node: DiffRenderable) => register(node, chunk)}
              diff={chunk.patch}
              height={layout().positions[index()].height}
            />
          </Show>
        )}
      </For>
    </box>
  )
}

function codes(node: Renderable): CodeRenderable[] {
  return node instanceof CodeRenderable ? [node] : node.getChildren().flatMap(codes)
}
