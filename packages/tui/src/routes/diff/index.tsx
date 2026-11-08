/** @jsxImportSource @opentui/solid */
import type { SnapshotFileDiff, VcsFileDiff } from "@graphagent/sdk/v2"
import { TextAttributes, type BorderSides, type BoxRenderable, type ScrollBoxRenderable } from "@opentui/core"
import { LANGUAGE_EXTENSIONS } from "../../util/filetype"
import { useBindings, useCommandShortcut } from "../../keymap"
import { useTheme } from "../../context/theme"
import { useRouteData, type DiffMode } from "../../context/route"
import { useSync } from "../../context/sync"
import { useSDK } from "../../context/sdk"
import { useKV } from "../../context/kv"
import { useTuiConfig } from "../../config"
import { useDialog } from "../../ui/dialog"
import { useDiffNavigation } from "./route"
import { useRenderer, useTerminalDimensions } from "@opentui/solid"
import path from "path"
import { createEffect, createMemo, createResource, createSignal, For, Match, onCleanup, Show, Switch } from "solid-js"
import { t } from "../../i18n"
import { DiffViewerFileTree } from "./file-tree"
import { Panel, PanelGroup, Separator } from "./ui"
import { DialogSelect } from "../../ui/dialog-select"
import { getScrollAcceleration } from "../../util/scroll"
import { PatchDiff, type PatchDiffRef } from "../../component/patch-diff"
import {
  allExpandedFileTreeDirectories,
  buildFileTree,
  fileTreeFileSelection,
  type FileTreeRow,
  flattenFileTree,
  moveFileTreeSelection,
  moveFileTreeSelectionToFirstChild,
  moveFileTreeSelectionToParent,
  movePatchFileIndex,
  orderedPatchFileIndexes,
  setFileTreeDirectoryExpanded,
  showDiffViewerFileTree,
  singlePatchFileIndex,
  toggleFileTreeDirectory,
} from "./file-tree-utils"

const MIN_SPLIT_WIDTH = 100
const FILE_TREE_WIDTH = 32
const PLAIN_TEXT_FILETYPE = "opencode-plain-text"
const VCS_DIFF_CONTEXT_LINES = 12
const KV_SHOW_FILE_TREE = "diff_viewer_show_file_tree"
const KV_SINGLE_PATCH = "diff_viewer_single_patch"
const KV_VIEW = "diff_viewer_view"
type DiffViewerFocus = "patches" | "files"
type DiffView = "split" | "unified"
type SelectedHunk = { readonly fileIndex: number; readonly hunkIndex: number; readonly scrollTop: number }

type DiffFile = {
  readonly file: string
  readonly patch?: string
  readonly additions: number
  readonly deletions: number
  readonly status: "added" | "deleted" | "modified"
}

const normalizeDiffs = (diffs: readonly (VcsFileDiff | SnapshotFileDiff)[]): DiffFile[] =>
  diffs.flatMap((item) =>
    item.file
      ? [
          {
            file: item.file,
            patch: item.patch,
            additions: item.additions,
            deletions: item.deletions,
            status: item.status ?? "modified",
          } satisfies DiffFile,
        ]
      : [],
  )

function filetype(input?: string) {
  if (!input) return "none"
  const language = LANGUAGE_EXTENSIONS[path.extname(input)]
  if (["typescriptreact", "javascriptreact", "javascript"].includes(language)) return "typescript"
  return language
}

function storedView(value: unknown): DiffView | undefined {
  if (value === "split" || value === "unified") return value
}

function diffSourceLabel(mode: DiffMode) {
  if (mode === "last-turn") return t("diff.source.lastTurn")
  if (mode === "branch") return t("diff.source.branch")
  return t("diff.source.git")
}

export function Diff() {
  const renderer = useRenderer()
  const dimensions = useTerminalDimensions()
  const themeState = useTheme()
  const theme = () => themeState.theme
  const route = useRouteData("diff")
  const navigation = useDiffNavigation()
  const sync = useSync()
  const sdk = useSDK()
  const kv = useKV()
  const tuiConfig = useTuiConfig()
  const dialog = useDialog()
  const params = () => route.params
  const mode = () => params()?.mode ?? "git"
  const diffInput = createMemo(() => {
    const sessionID = params()?.sessionID
    return {
      mode: mode(),
      sessionID,
      messageID: params()?.messageID,
      directory: sessionID ? sync.session.get(sessionID)?.directory : undefined,
    }
  })
  const [diff] = createResource(diffInput, async (input) => {
    if (input.mode === "last-turn") {
      const sessionID = input.sessionID
      if (!sessionID) return []
      const result = await sdk.client.session.diff(
        { sessionID, messageID: input.messageID },
        { throwOnError: true },
      )
      return normalizeDiffs(result.data ?? [])
    }

    const result = await sdk.client.vcs.diff(
      { directory: input.directory, mode: input.mode, context: VCS_DIFF_CONTEXT_LINES },
      { throwOnError: true },
    )
    return normalizeDiffs(result.data ?? [])
  })
  const files = createMemo(() => diff() ?? [])
  const [focus, setFocus] = createSignal<DiffViewerFocus>("patches")
  const [fileTreeEnabled, setFileTreeEnabled] = createSignal(
    kv.get(KV_SHOW_FILE_TREE, true) !== false,
  )
  const showFileTree = createMemo(() => showDiffViewerFileTree(fileTreeEnabled(), files().length))
  const [singlePatch, setSinglePatch] = createSignal(kv.get(KV_SINGLE_PATCH, false) === true)
  const patchPaneWidth = createMemo(() => dimensions().width - (showFileTree() ? 33 : 0) - 4)
  const patchLeftBorder = createMemo<BorderSides[]>(() => (showFileTree() ? ["left"] : []))
  const splitAvailable = createMemo(() => patchPaneWidth() >= MIN_SPLIT_WIDTH)
  const defaultView = createMemo(() => {
    if (tuiConfig.diff_style === "stacked") return "unified"
    return splitAvailable() ? "split" : "unified"
  })
  const [viewOverride, setViewOverride] = createSignal<DiffView | undefined>(storedView(kv.get(KV_VIEW)))
  const view = createMemo(() => (splitAvailable() ? (viewOverride() ?? defaultView()) : "unified"))
  const fileTree = createMemo(() => buildFileTree(files()))
  const [expandedFileNodes, setExpandedFileNodes] = createSignal<ReadonlySet<number>>(new Set())
  const [highlightedFileNode, setHighlightedFileNode] = createSignal<number | undefined>()
  const [lastHighlightedFileNode, setLastHighlightedFileNode] = createSignal<number | undefined>()
  const [activePatchFileIndex, setActivePatchFileIndex] = createSignal<number | undefined>()
  const [selectedFileIndex, setSelectedFileIndex] = createSignal<number | undefined>()
  const [reviewedFileNames, setReviewedFileNames] = createSignal<ReadonlySet<string>>(new Set())
  const patchScrollAcceleration = createMemo(() => getScrollAcceleration(tuiConfig))
  const fileRows = createMemo(() => flattenFileTree(fileTree(), expandedFileNodes()))
  const patchFileIndexes = createMemo(() => orderedPatchFileIndexes(flattenFileTree(fileTree())))
  const focusRunner = (input: Record<DiffViewerFocus, () => void>) => () => input[focus()]()
  let scroll: ScrollBoxRenderable | undefined
  const patchNodeByFileIndex = new Map<number, BoxRenderable>()
  const diffNodeByFileIndex = new Map<number, PatchDiffRef>()
  const [selectedHunk, setSelectedHunk] = createSignal<SelectedHunk | undefined>()
  const [pendingPatchScrollFileIndex, setPendingPatchScrollFileIndex] = createSignal<number | undefined>()
  const [patchFillerHeight, setPatchFillerHeight] = createSignal(0)

  onCleanup(() => dialog.clear())

  createEffect(() => {
    setExpandedFileNodes(allExpandedFileTreeDirectories(fileTree()))
    setHighlightedFileNode(undefined)
    setLastHighlightedFileNode(undefined)
    setActivePatchFileIndex(undefined)
    setSelectedFileIndex(undefined)
    setSelectedHunk(undefined)
    setReviewedFileNames(new Set<string>())
  })

  const ensureHighlightedFileNode = () => {
    const highlighted = highlightedFileNode()
    if (highlighted !== undefined && fileRows().some((row) => row.id === highlighted)) return
    const lastHighlighted = lastHighlightedFileNode()
    const next =
      lastHighlighted !== undefined && fileRows().some((row) => row.id === lastHighlighted)
        ? lastHighlighted
        : fileRows().find((row) => row.fileIndex !== undefined)?.id
    setHighlightedFileNode(next)
  }

  const setHighlighted = (node: number | undefined) => {
    setHighlightedFileNode(node)
    if (node !== undefined) setLastHighlightedFileNode(node)
  }

  const moveFileSelection = (offset: number) =>
    setHighlighted(moveFileTreeSelection(fileRows(), highlightedFileNode(), offset))

  const clearFileTreePatchState = () => {
    setHighlightedFileNode(undefined)
    setActivePatchFileIndex(undefined)
    setSelectedHunk(undefined)
  }

  const scrollPatchNodeToTop = (patchNode: BoxRenderable) => {
    renderer.requestAnimationFrame(() => {
      if (!scroll) return
      const scrollDelta = patchNode.y - scroll.viewport.y
      const contentY = scroll.scrollTop + scrollDelta
      const offset = contentY === 0 ? 0 : 1
      scroll.scrollBy(scrollDelta + offset)
    })
  }

  const revealFileTreeFile = (fileIndex: number) => {
    const selection = fileTreeFileSelection(fileTree(), fileIndex)
    if (!selection) return
    setExpandedFileNodes((expanded) => {
      const next = new Set(expanded)
      selection.expandedNodes.forEach((node) => next.add(node))
      return next
    })
    setHighlighted(selection.highlightedNode)
  }

  const selectPatchFile = (fileIndex: number) => {
    revealFileTreeFile(fileIndex)
    setActivePatchFileIndex(fileIndex)
    setSelectedFileIndex(fileIndex)
  }

  const scrollToFileIndex = (fileIndex: number | undefined) => {
    if (fileIndex === undefined) return
    selectPatchFile(fileIndex)
    const patchNode = patchNodeByFileIndex.get(fileIndex)
    if (patchNode) scrollPatchNodeToTop(patchNode)
  }

  const jumpToFileIndex = (fileIndex: number | undefined) => {
    if (fileIndex === undefined) return
    setSelectedHunk(undefined)
    scrollToFileIndex(fileIndex)
  }

  const currentPatchFileIndex = () => {
    if (!scroll) return undefined
    const viewportContentY = scroll.scrollTop + 1
    const entries = patchFileIndexes()
      .map((fileIndex) => ({
        fileIndex,
        node: patchNodeByFileIndex.get(fileIndex),
      }))
      .filter((entry): entry is { fileIndex: number; node: BoxRenderable } => Boolean(entry.node))
      .map((entry) => ({
        ...entry,
        contentY: scroll!.scrollTop + entry.node.y - scroll!.viewport.y,
      }))
      .sort((left, right) => left.contentY - right.contentY)
    return entries.findLast((entry) => entry.contentY <= viewportContentY)?.fileIndex ?? entries[0]?.fileIndex
  }

  const jumpRelativePatchFile = (offset: number) => {
    setSelectedHunk(undefined)
    const next = movePatchFileIndex(patchFileIndexes(), selectedFileIndex() ?? activePatchFileIndex(), offset)
    if (singlePatch()) {
      if (next === undefined) return
      selectPatchFile(next)
      scrollSinglePatchToTop()
      return
    }
    scrollToFileIndex(next)
  }

  const jumpRelativeHunk = (offset: -1 | 1) => {
    const patchScroll = scroll
    if (!patchScroll) return
    const hunks = visiblePatchFiles()
      .flatMap((entry) => {
        return (diffNodeByFileIndex.get(entry.fileIndex)?.hunks() ?? []).map(({ node, offset }, hunkIndex) => ({
          fileIndex: entry.fileIndex,
          hunkIndex,
          contentY: patchScroll.scrollTop + node.y - patchScroll.viewport.y + offset,
        }))
      })
      .sort((left, right) => left.contentY - right.contentY)
    const selected = selectedHunk()
    const selectedIndex =
      selected?.scrollTop === patchScroll.scrollTop
        ? hunks.findIndex((hunk) => hunk.fileIndex === selected.fileIndex && hunk.hunkIndex === selected.hunkIndex)
        : -1
    const next =
      selectedIndex !== -1
        ? hunks[selectedIndex + offset]
        : offset === 1
          ? hunks.find((hunk) => hunk.contentY > patchScroll.scrollTop)
          : hunks.findLast((hunk) => hunk.contentY < patchScroll.scrollTop)
    if (!next) return
    selectPatchFile(next.fileIndex)
    patchScroll.scrollTo(next.contentY)
    setSelectedHunk({ fileIndex: next.fileIndex, hunkIndex: next.hunkIndex, scrollTop: patchScroll.scrollTop })
  }

  const highlightedPatchFileIndex = () => fileRows().find((row) => row.id === highlightedFileNode())?.fileIndex
  const firstPatchFileIndex = () => fileRows().find((row) => row.fileIndex !== undefined)?.fileIndex
  const visiblePatchFiles = createMemo(() => {
    if (!singlePatch()) {
      return patchFileIndexes().flatMap((fileIndex) => {
        const file = files()[fileIndex]
        return file ? [{ file, fileIndex }] : []
      })
    }
    const fileIndex = singlePatchFileIndex(
      selectedFileIndex(),
      activePatchFileIndex(),
      currentPatchFileIndex(),
      firstPatchFileIndex(),
    )
    const file = fileIndex === undefined ? undefined : files()[fileIndex]
    return file && fileIndex !== undefined ? [{ file, fileIndex }] : []
  })

  const ensureHighlightedPatchFile = () => {
    const fileIndex = currentPatchFileIndex() ?? activePatchFileIndex() ?? firstPatchFileIndex()
    if (fileIndex === undefined) return
    selectPatchFile(fileIndex)
  }

  const scrollToPatchFileIndexAfterRender = (fileIndex: number) => {
    setPendingPatchScrollFileIndex(fileIndex)
    renderer.requestAnimationFrame(() => {
      const patchNode = patchNodeByFileIndex.get(fileIndex)
      if (patchNode) scrollPatchNodeToTop(patchNode)
      renderer.requestAnimationFrame(() => {
        const patchNode = patchNodeByFileIndex.get(fileIndex)
        if (patchNode) scrollPatchNodeToTop(patchNode)
        setPendingPatchScrollFileIndex(undefined)
      })
    })
  }

  const scrollSinglePatchToTop = () => {
    renderer.requestAnimationFrame(() => {
      scroll?.scrollTo(0)
      renderer.requestAnimationFrame(() => scroll?.scrollTo(0))
    })
  }

  const measurePatchFiller = () => {
    renderer.requestAnimationFrame(() => {
      if (!scroll) return
      const entries = visiblePatchFiles()
        .map((entry) => patchNodeByFileIndex.get(entry.fileIndex))
        .filter((node): node is BoxRenderable => Boolean(node))
      if (entries.length === 0) {
        setPatchFillerHeight(0)
        return
      }
      const contentHeight = Math.max(
        ...entries.map((node) => scroll!.scrollTop + node.y - scroll!.viewport.y + node.height),
      )
      setPatchFillerHeight(Math.max(0, scroll.viewport.height - contentHeight))
    })
  }

  const registerPatchNode = (fileIndex: number, element: BoxRenderable) => {
    patchNodeByFileIndex.set(fileIndex, element)
    measurePatchFiller()
    if (pendingPatchScrollFileIndex() !== fileIndex) return
    renderer.requestAnimationFrame(() => {
      scrollPatchNodeToTop(element)
      renderer.requestAnimationFrame(() => {
        scrollPatchNodeToTop(element)
        setPendingPatchScrollFileIndex(undefined)
      })
    })
  }

  createEffect(() => {
    visiblePatchFiles()
    dimensions()
    view()
    measurePatchFiller()
  })

  const toggleSelectedFileTreeRow = () => {
    const highlighted = fileRows().find((row) => row.id === highlightedFileNode())
    if (highlighted?.fileIndex !== undefined) {
      jumpToFileIndex(highlighted.fileIndex)
      return
    }
    setExpandedFileNodes((expanded) => toggleFileTreeDirectory(fileTree(), expanded, highlightedFileNode()))
  }

  const clickFileTreeRow = (row: FileTreeRow) => {
    setFocus("files")
    setHighlighted(row.id)
    if (row.fileIndex !== undefined) {
      jumpToFileIndex(row.fileIndex)
      return
    }
    setExpandedFileNodes((expanded) => toggleFileTreeDirectory(fileTree(), expanded, row.id))
  }

  const toggleSelectedFileReviewed = () => {
    const fileIndex =
      focus() === "files"
        ? fileRows().find((row) => row.id === highlightedFileNode())?.fileIndex
        : (selectedFileIndex() ?? activePatchFileIndex() ?? currentPatchFileIndex())
    const file = fileIndex === undefined ? undefined : files()[fileIndex]?.file
    if (!file) return
    setReviewedFileNames((reviewed) => {
      const next = new Set(reviewed)
      if (next.has(file)) next.delete(file)
      else next.add(file)
      return next
    })
  }

  const commands = [
    {
      name: "diff.close",
      title: t("diff.command.close"),
      category: "VCS",
      run() {
        dialog.clear()
        navigation.close()
      },
    },
    {
      name: "diff.down",
      title: t("diff.command.down"),
      category: "VCS",
      run: focusRunner({
        files() {
          moveFileSelection(1)
        },
        patches() {
          clearFileTreePatchState()
          scroll?.scrollBy(1)
        },
      }),
    },
    {
      name: "diff.up",
      title: t("diff.command.up"),
      category: "VCS",
      run: focusRunner({
        files() {
          moveFileSelection(-1)
        },
        patches() {
          clearFileTreePatchState()
          scroll?.scrollBy(-1)
        },
      }),
    },
    {
      name: "diff.page.down",
      title: t("diff.command.page.down"),
      category: "VCS",
      run: focusRunner({
        files() {
          moveFileSelection(8)
        },
        patches() {
          clearFileTreePatchState()
          if (scroll) scroll.scrollBy(scroll.height)
        },
      }),
    },
    {
      name: "diff.page.up",
      title: t("diff.command.page.up"),
      category: "VCS",
      run: focusRunner({
        files() {
          moveFileSelection(-8)
        },
        patches() {
          clearFileTreePatchState()
          if (scroll) scroll.scrollBy(-scroll.height)
        },
      }),
    },
    {
      name: "diff.toggle",
      title: t("diff.command.toggle"),
      category: "VCS",
      run: focusRunner({
        files() {
          toggleSelectedFileTreeRow()
        },
        patches() {},
      }),
    },
    {
      name: "diff.expand",
      title: t("diff.command.expand"),
      category: "VCS",
      run: focusRunner({
        files() {
          const highlighted = highlightedFileNode()
          if (highlighted !== undefined && expandedFileNodes().has(highlighted)) {
            setHighlighted(moveFileTreeSelectionToFirstChild(fileRows(), highlighted))
            return
          }
          setExpandedFileNodes((expanded) =>
            setFileTreeDirectoryExpanded(fileTree(), expanded, highlightedFileNode(), true),
          )
        },
        patches() {},
      }),
    },
    {
      name: "diff.expand_all",
      title: t("diff.command.expandAll"),
      category: "VCS",
      run: focusRunner({
        files() {
          setExpandedFileNodes(allExpandedFileTreeDirectories(fileTree()))
        },
        patches() {},
      }),
    },
    {
      name: "diff.collapse",
      title: t("diff.command.collapse"),
      category: "VCS",
      run: focusRunner({
        files() {
          const highlighted = highlightedFileNode()
          const node = highlighted === undefined ? undefined : fileTree().nodes[highlighted]
          if (node?.kind !== "directory" || !expandedFileNodes().has(node.id)) {
            setHighlighted(moveFileTreeSelectionToParent(fileRows(), highlighted))
            return
          }
          setExpandedFileNodes((expanded) =>
            setFileTreeDirectoryExpanded(fileTree(), expanded, highlightedFileNode(), false),
          )
        },
        patches() {},
      }),
    },
    {
      name: "diff.next_hunk",
      title: t("diff.command.nextHunk"),
      category: "VCS",
      run() {
        jumpRelativeHunk(1)
      },
    },
    {
      name: "diff.previous_hunk",
      title: t("diff.command.previousHunk"),
      category: "VCS",
      run() {
        jumpRelativeHunk(-1)
      },
    },
    {
      name: "diff.next_file",
      title: t("diff.command.nextFile"),
      category: "VCS",
      run() {
        jumpRelativePatchFile(1)
      },
    },
    {
      name: "diff.previous_file",
      title: t("diff.command.previousFile"),
      category: "VCS",
      run() {
        jumpRelativePatchFile(-1)
      },
    },
    {
      name: "diff.mark_reviewed",
      title: t("diff.command.markReviewed"),
      category: "VCS",
      run() {
        toggleSelectedFileReviewed()
      },
    },
    {
      name: "diff.switch_focus",
      title: t("diff.command.switchFocus"),
      category: "VCS",
      run() {
        if (!showFileTree()) return
        setFocus((current) => {
          if (current === "files") return "patches"
          ensureHighlightedFileNode()
          return "files"
        })
      },
    },
    {
      name: "diff.toggle_file_tree",
      title: t("diff.command.toggleFileTree"),
      category: "VCS",
      run() {
        const next = !fileTreeEnabled()
        if (!next) setFocus("patches")
        setFileTreeEnabled(next)
        kv.set(KV_SHOW_FILE_TREE, next)
      },
    },
    {
      name: "diff.single_patch",
      title: t("diff.command.singlePatch"),
      category: "VCS",
      run() {
        setSelectedHunk(undefined)
        if (!singlePatch()) {
          ensureHighlightedPatchFile()
          setSinglePatch(true)
          kv.set(KV_SINGLE_PATCH, true)
          scrollSinglePatchToTop()
          return
        }
        const fileIndex =
          visiblePatchFiles()[0]?.fileIndex ??
          singlePatchFileIndex(
            selectedFileIndex(),
            activePatchFileIndex(),
            currentPatchFileIndex(),
            firstPatchFileIndex(),
          )
        if (fileIndex !== undefined) selectPatchFile(fileIndex)
        setSinglePatch(false)
        kv.set(KV_SINGLE_PATCH, false)
        if (fileIndex !== undefined) scrollToPatchFileIndexAfterRender(fileIndex)
      },
    },
    {
      name: "diff.switch_source",
      title: t("diff.command.switchSource"),
      category: "VCS",
      run() {
        openSwitchDiffDialog()
      },
    },
    {
      name: "diff.toggle_view",
      title: t("diff.command.toggleView"),
      category: "VCS",
      run() {
        if (!splitAvailable()) return
        setSelectedHunk(undefined)
        const next = view() === "split" ? "unified" : "split"
        setViewOverride(next)
        kv.set(KV_VIEW, next)
      },
    },
    {
      name: "diff.help",
      title: t("diff.command.help"),
      category: "VCS",
      run() {
        openHelpDialog()
      },
    },
  ]

  const switchDiffOptions = createMemo(() => {
    const vcs = sync.data.vcs
    return [
      {
        title: t("diff.switch.git.title"),
        value: "git" as const,
        description: t("diff.switch.git.description"),
      },
      ...(vcs?.branch && vcs.default_branch && vcs.branch !== vcs.default_branch
        ? [
            {
              title: t("diff.switch.branch.title"),
              value: "branch" as const,
              description: t("diff.switch.branch.description"),
            },
          ]
        : []),
      {
        title: t("diff.switch.lastTurn.title"),
        value: "last-turn" as const,
        description: t("diff.switch.lastTurn.description"),
      },
    ]
  })

  const openSwitchDiffDialog = () => {
    dialog.replace(() => (
      <DialogSelect
        title={t("diff.switch.title")}
        skipFilter={true}
        renderFilter={false}
        current={mode()}
        options={switchDiffOptions().map((option) => ({
          ...option,
          onSelect(dialog) {
            dialog.clear()
            navigation.open({
              mode: option.value,
              sessionID: params()?.sessionID,
              messageID: params()?.messageID,
            })
          },
        }))}
      />
    ))
  }

  const openHelpDialog = () => {
    dialog.replace(() => <DiffViewerHelpDialog />)
    dialog.setSize("large")
  }

  useBindings(() => ({
    commands,
    bindings: [
      { key: "j,down", cmd: "diff.down", desc: t("diff.binding.down") },
      { key: "k,up", cmd: "diff.up", desc: t("diff.binding.up") },
      { key: "pagedown,ctrl+f", cmd: "diff.page.down", desc: t("diff.binding.pageDown") },
      { key: "pageup,ctrl+b", cmd: "diff.page.up", desc: t("diff.binding.pageUp") },
      { key: "m", cmd: "diff.mark_reviewed", desc: t("diff.binding.markReviewed") },
      ...tuiConfig.keybinds.gather(
        "diff",
        commands.map((command) => command.name),
      ),
    ],
  }))

  return (
    <box flexGrow={1} minHeight={0} flexDirection="column">
      <PanelGroup axis="y" width="100%" height="100%">
        <Panel border="none" flexShrink={0} padding={0} paddingLeft={1}>
          <text fg={theme().text}>{t("diff.title")} </text>
          <text fg={theme().textMuted}>{diffSourceLabel(mode())}</text>
          <box flexGrow={1} />
          <text fg={theme().textMuted}>
            {t(files().length === 1 ? "diff.fileCount.one" : "diff.fileCount.other", { count: files().length })}
          </text>
        </Panel>

        <box flexGrow={1} minHeight={0}>
          <Switch>
            <Match when={diff.loading}>
              <Separator axis="x" />
              <box flexGrow={1} paddingLeft={1}>
                <text fg={theme().textMuted}>{t("diff.loading")}</text>
              </box>
            </Match>
            <Match when={!diff.loading && files().length === 0}>
              <Separator axis="x" />
              <box flexGrow={1} paddingLeft={1}>
                <text fg={theme().textMuted}>{t("diff.empty")}</text>
              </box>
            </Match>
            <Match when={!diff.loading && diff.error}>
              <Separator axis="x" />
              <box flexGrow={1} paddingLeft={1}>
                <text fg={theme().error}>{t("diff.error")}</text>
              </box>
            </Match>
            <Match when={!diff.loading}>
              <PanelGroup axis="x">
                <Show when={showFileTree()}>
                  <DiffViewerFileTree
                    files={files()}
                    loading={diff.loading}
                    error={diff.error}
                    theme={theme()}
                    focused={focus() === "files"}
                    width={FILE_TREE_WIDTH}
                    highlightedNode={highlightedFileNode()}
                    selectedFileIndex={selectedFileIndex()}
                    reviewedFileNames={reviewedFileNames()}
                    expandedNodes={expandedFileNodes()}
                    onRowClick={clickFileTreeRow}
                  />
                </Show>

                <Panel flexGrow={1} minHeight={0} border="none">
                  <Separator axis="x" start={showFileTree() ? "edge-out" : undefined} />
                  <scrollbox
                    ref={(element: ScrollBoxRenderable) => (scroll = element)}
                    flexGrow={1}
                    minHeight={0}
                    scrollAcceleration={patchScrollAcceleration()}
                    verticalScrollbarOptions={{ visible: false }}
                    horizontalScrollbarOptions={{ visible: false }}
                  >
                    <For each={visiblePatchFiles()}>
                      {(entry, index) => {
                        const reviewed = () => reviewedFileNames().has(entry.file.file)
                        return (
                          <box ref={(element: BoxRenderable) => registerPatchNode(entry.fileIndex, element)}>
                            {index() !== 0 ? <Separator axis="x" start={showFileTree() ? "edge" : undefined} /> : null}
                            <box
                              flexDirection="row"
                              gap={1}
                              flexShrink={0}
                              paddingLeft={1}
                              paddingRight={1}
                              border={patchLeftBorder()}
                              borderColor={theme().border}
                            >
                              <text fg={reviewed() ? theme().textMuted : theme().text}>{entry.file.file}</text>
                              <box flexGrow={1} />
                              <text fg={reviewed() ? theme().textMuted : theme().diffAdded}>
                                +{entry.file.additions}
                              </text>
                              <text fg={reviewed() ? theme().textMuted : theme().diffRemoved}>
                                -{entry.file.deletions}
                              </text>
                            </box>
                            <Separator axis="x" start={showFileTree() ? "edge" : undefined} />
                            <Show
                              when={entry.file.patch}
                              fallback={<text fg={theme().textMuted}>{t("diff.noPatch")}</text>}
                            >
                              {(patch) => (
                                <box border={patchLeftBorder()} borderColor={theme().border}>
                                  <PatchDiff
                                    ref={(element) => diffNodeByFileIndex.set(entry.fileIndex, element)}
                                    scroll={() => scroll}
                                    diff={patch()}
                                    view={view()}
                                    filetype={reviewed() ? PLAIN_TEXT_FILETYPE : filetype(entry.file.file)}
                                    syntaxStyle={themeState.syntax()}
                                    showLineNumbers={true}
                                    width="100%"
                                    wrapMode="char"
                                    fg={reviewed() ? theme().textMuted : theme().text}
                                    addedBg={reviewed() ? theme().backgroundElement : theme().diffAddedBg}
                                    removedBg={reviewed() ? theme().backgroundElement : theme().diffRemovedBg}
                                    addedSignColor={reviewed() ? theme().textMuted : theme().diffHighlightAdded}
                                    removedSignColor={reviewed() ? theme().textMuted : theme().diffHighlightRemoved}
                                    lineNumberFg={theme().diffLineNumber}
                                    addedLineNumberBg={
                                      reviewed() ? theme().backgroundElement : theme().diffAddedLineNumberBg
                                    }
                                    removedLineNumberBg={
                                      reviewed() ? theme().backgroundElement : theme().diffRemovedLineNumberBg
                                    }
                                  />
                                </box>
                              )}
                            </Show>
                          </box>
                        )
                      }}
                    </For>
                    <Show when={patchFillerHeight() > 0}>
                      <box height={patchFillerHeight()} border={patchLeftBorder()} borderColor={theme().border} />
                    </Show>
                  </scrollbox>
                  <Separator axis="x" start={showFileTree() ? "edge-in" : undefined} />
                </Panel>
              </PanelGroup>
            </Match>
          </Switch>
        </box>

      </PanelGroup>
    </box>
  )
}

function DiffViewerHelpDialog() {
  const { theme } = useTheme()
  const rows = [
    {
      shortcut: useCommandShortcut("diff.close"),
      action: t("diff.help.close.action"),
      description: t("diff.help.close.description"),
    },
    {
      shortcut: useCommandShortcut("diff.switch_focus"),
      action: t("diff.help.switchFocus.action"),
      description: t("diff.help.switchFocus.description"),
    },
    {
      shortcut: useCommandShortcut("diff.next_hunk"),
      action: t("diff.help.nextHunk.action"),
      description: t("diff.help.nextHunk.description"),
    },
    {
      shortcut: useCommandShortcut("diff.previous_hunk"),
      action: t("diff.help.previousHunk.action"),
      description: t("diff.help.previousHunk.description"),
    },
    {
      shortcut: useCommandShortcut("diff.next_file"),
      action: t("diff.help.nextFile.action"),
      description: t("diff.help.nextFile.description"),
    },
    {
      shortcut: useCommandShortcut("diff.previous_file"),
      action: t("diff.help.previousFile.action"),
      description: t("diff.help.previousFile.description"),
    },
    {
      shortcut: useCommandShortcut("diff.toggle_file_tree"),
      action: t("diff.help.toggleFileTree.action"),
      description: t("diff.help.toggleFileTree.description"),
    },
    {
      shortcut: useCommandShortcut("diff.single_patch"),
      action: t("diff.help.singlePatch.action"),
      description: t("diff.help.singlePatch.description"),
    },
    {
      shortcut: useCommandShortcut("diff.switch_source"),
      action: t("diff.help.switchSource.action"),
      description: t("diff.help.switchSource.description"),
    },
    {
      shortcut: useCommandShortcut("diff.toggle_view"),
      action: t("diff.help.toggleView.action"),
      description: t("diff.help.toggleView.description"),
    },
    {
      shortcut: useCommandShortcut("diff.expand_all"),
      action: t("diff.help.expandAll.action"),
      description: t("diff.help.expandAll.description"),
    },
    {
      shortcut: useCommandShortcut("diff.mark_reviewed"),
      action: t("diff.help.markReviewed.action"),
      description: t("diff.help.markReviewed.description"),
    },
  ]

  return (
    <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {t("diff.help.title")}
        </text>
        <text fg={theme.textMuted}>esc</text>
      </box>
      <box flexDirection="row">
        <text fg={theme.textMuted} width={5} wrapMode="none">
          {t("diff.help.key")}
        </text>
        <text fg={theme.textMuted} width={22} wrapMode="none">
          {t("diff.help.action")}
        </text>
        <text fg={theme.textMuted}>{t("diff.help.description")}</text>
      </box>
      <For each={rows}>
        {(row) => (
          <box flexDirection="row">
            <text fg={theme.text} width={5} wrapMode="none">
              {row.shortcut() || "-"}
            </text>
            <text fg={theme.text} width={22} wrapMode="none">
              {row.action}
            </text>
            <text fg={theme.textMuted}>{row.description}</text>
          </box>
        )}
      </For>
    </box>
  )
}

