import escapeHtmlLib from "escape-html"

// Delegates to the escape-html package (issue #443): identical output to the
// previous hand-rolled replaceAll chain, but CodeQL models this library as a
// sanitizer, so js/reflected-xss stops flagging the OAuth error pages that
// render through it.
export function escapeHtml(value: string) {
  return escapeHtmlLib(value)
}
