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

/**
 * The outer pattern is bounded and has no overlapping repetition, so scanning model text stays linear. A real opening
 * marker is short; a `<...>` body over 4096 characters cannot be an envelope header and is ignored without scanning it.
 */
const TAG = /<([^<>]{1,4096})>/g
const NAMED = /\bname\s*=\s*["']/i

type Marker = Readonly<{ close: boolean; name: string; named: boolean; start: number; end: number }>

/** ECMAScript `\s`, checked by code unit so the tag parser never backtracks. */
const isSpace = (code: number) =>
  (code >= 9 && code <= 13) ||
  code === 32 ||
  code === 0xa0 ||
  code === 0x1680 ||
  (code >= 0x2000 && code <= 0x200a) ||
  code === 0x2028 ||
  code === 0x2029 ||
  code === 0x202f ||
  code === 0x205f ||
  code === 0x3000 ||
  code === 0xfeff

const isNameStart = (code: number) => (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95
const isNamePart = (code: number) => isNameStart(code) || (code >= 48 && code <= 57) || code === 45

const skipSpace = (text: string, at: number) => {
  let i = at
  while (i < text.length && isSpace(text.charCodeAt(i))) i++
  return i
}

/** DSML tags use fullwidth bars; proxies and degraded generations render one bar, two bars, or ASCII pipes. */
const skipBars = (text: string, at: number) => {
  let i = at
  while (i < text.length && (text[i] === "｜" || text[i] === "|")) i++
  const count = i - at
  return count === 1 || count === 2 ? i : -1
}

const parseMarker = (body: string, start: number, end: number): Marker | undefined => {
  let i = skipSpace(body, 0)
  const close = body[i] === "/"
  if (close) i = skipSpace(body, i + 1)
  i = skipBars(body, i)
  if (i < 0) return undefined
  i = skipSpace(body, i)
  if (body.slice(i, i + 4).toLowerCase() !== "dsml") return undefined
  i = skipSpace(body, i + 4)
  i = skipBars(body, i)
  if (i < 0) return undefined
  i = skipSpace(body, i)
  let name = ""
  if (i < body.length && isNameStart(body.charCodeAt(i))) {
    const from = i
    i++
    while (i < body.length && isNamePart(body.charCodeAt(i))) i++
    name = body.slice(from, i).toLowerCase().replace(/-/g, "_")
  }
  return { close, name, named: NAMED.test(body.slice(i)), start, end }
}

const markers = (text: string): Marker[] => {
  const found: Marker[] = []
  for (const match of text.matchAll(TAG)) {
    const start = match.index ?? 0
    const parsed = parseMarker(match[1], start, start + match[0].length)
    if (parsed) found.push(parsed)
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
