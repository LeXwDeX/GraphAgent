import { createMemo } from "solid-js"
import { useCommandShortcut } from "../../keymap"
import { t } from "../../i18n"
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
    if (focus()) hints.push({ key: focus(), label: t("diff.footer.focusFileTree") })
    if (nextFile()) hints.push({ key: nextFile(), label: t("diff.footer.nextFile") })
    if (nextHunk()) hints.push({ key: nextHunk(), label: t("diff.footer.nextHunk") })
    if (previousHunk()) hints.push({ key: previousHunk(), label: t("diff.footer.previousHunk") })
    if (previousFile()) hints.push({ key: previousFile(), label: t("diff.footer.previousFile") })
    if (switchSource()) hints.push({ key: switchSource(), label: t("diff.footer.switchSource") })
    if (markReviewed()) hints.push({ key: markReviewed(), label: t("diff.footer.markReviewed") })
    if (help()) hints.push({ key: help(), label: t("diff.footer.all") })
    return hints
  })
}
