/**
 * Provider control markup that can leak into reasoning text.
 *
 * DeepSeek models serialize tool calls as DSML when the structured tool-call channel is unavailable, and the markup can
 * leak into `content` or `reasoning_content`; a small organizer model can also emit it. Only a complete tool-call
 * envelope is rejected. A mention, a path, a command, a URL, a code sample that does not itself form the complete
 * structure, or an incomplete fragment is legitimate reasoning and must survive. A complete envelope is rejected even
 * inside a code fence or a prose listing; rejection is fail-open, so only distillation is forgone.
 */
export type ControlMarkup = "tool-call-envelope"

/** DSML tags use fullwidth bars; proxies and degraded generations render one bar, two bars, or ASCII pipes. */
const TAG = /<\s*(\/)?\s*[｜|]{1,2}\s*DSML\s*[｜|]{1,2}\s*([A-Za-z_][A-Za-z0-9_-]*)?([^>]*)>/gi
const NAMED = /\bname\s*=\s*["']/i

type Marker = Readonly<{ close: boolean; name: string; named: boolean; start: number; end: number }>

const markers = (text: string): Marker[] => {
  const found: Marker[] = []
  for (const match of text.matchAll(TAG)) {
    const start = match.index ?? 0
    found.push({
      close: match[1] === "/",
      name: (match[2] ?? "").toLowerCase().replace(/-/g, "_"),
      named: NAMED.test(match[3] ?? ""),
      start,
      end: start + match[0].length,
    })
  }
  return found
}

const isCallsWrapper = (name: string) => name === "calls" || name === "tool_calls" || name === "function_calls"

const whitespaceOnly = (text: string, from: number, to: number) => text.slice(from, to).trim() === ""

/**
 * A complete envelope is a calls wrapper holding an invoke with a name and a named parameter. The three markers must be
 * adjacent in that order with only whitespace between them, so prose that lists the tags or a generic XML sample is not
 * mistaken for leaked markup. Closing tags are not required: long-context degradation drops them while the envelope
 * still leaks, and the three opening markers are what makes the text a tool call rather than a mention.
 */
export const detectToolCallEnvelope = (text: string): ControlMarkup | undefined => {
  if (!/DSML/i.test(text)) return undefined
  const found = markers(text)
  for (let index = 0; index + 2 < found.length; index++) {
    const calls = found[index]
    if (calls.close || !isCallsWrapper(calls.name)) continue
    const invoke = found[index + 1]
    if (invoke.close || invoke.name !== "invoke" || !invoke.named) continue
    if (!whitespaceOnly(text, calls.end, invoke.start)) continue
    const parameter = found[index + 2]
    if (parameter.close || parameter.name !== "parameter" || !parameter.named) continue
    if (!whitespaceOnly(text, invoke.end, parameter.start)) continue
    return "tool-call-envelope"
  }
  return undefined
}

/** Bounded reason codes shared by the organizer, both adoption paths, and replay. */
export type RewriteControlReason = "control-markup-source" | "control-markup-output"

/**
 * The single rewrite decision both adoption paths and replay share. A source envelope is refused because distillation
 * must not consume a leaked tool call; a rewrite envelope is refused so the original reasoning survives fail-open.
 */
export const assessRewriteControl = (source: string, after: string): RewriteControlReason | undefined => {
  if (detectToolCallEnvelope(source)) return "control-markup-source"
  if (detectToolCallEnvelope(after)) return "control-markup-output"
  return undefined
}
