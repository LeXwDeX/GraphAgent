import { createMemo } from "solid-js"
import { useCommandShortcut } from "../../keymap"
import type { FooterHint } from "../../shell/footer"

/** Footer hints owned by the diff route, shown through AppFrame's footer. */
export function useDiffFooterHints(): () => FooterHint[] {
  const focus = useCommandShortcut("diff.switch_focus")
  const nextFile = useCommandShortcut("diff.next_file")
  const nextHunk = useCommandShortcut("diff.next_hunk")
  const previousHunk = useCommandShortcut("diff.previous_hunk")
  const previousFile = useCommandShortcut("diff.previous_file")
  const switchSource = useCommandShortcut("diff.switch_source")
  const markReviewed = useCommandShortcut("diff.mark_reviewed")
  const help = useCommandShortcut("diff.help")

  return createMemo(() => {
    const hints: FooterHint[] = []
    if (focus()) hints.push({ key: focus(), label: "focus file tree" })
    if (nextFile()) hints.push({ key: nextFile(), label: "next file" })
    if (nextHunk()) hints.push({ key: nextHunk(), label: "next hunk" })
    if (previousHunk()) hints.push({ key: previousHunk(), label: "previous hunk" })
    if (previousFile()) hints.push({ key: previousFile(), label: "previous file" })
    if (switchSource()) hints.push({ key: switchSource(), label: "switch source" })
    if (markReviewed()) hints.push({ key: markReviewed(), label: "mark reviewed" })
    if (help()) hints.push({ key: help(), label: "all" })
    return hints
  })
}
