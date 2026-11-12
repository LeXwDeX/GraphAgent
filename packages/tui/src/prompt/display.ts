import { cursorWidth } from "../ui/width"

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })

/** Width of one grapheme in textarea offsets: a newline is one position, `cursorWidth` counts it as zero. */
function graphemeWidth(segment: string) {
  return segment === "\n" ? 1 : cursorWidth(segment)
}

/** Width of `value` in textarea offsets. */
export function promptOffsetWidth(value: string) {
  let width = 0
  for (const part of graphemes.segment(value)) width += graphemeWidth(part.segment)
  return width
}

/**
 * Grapheme boundaries of the text last asked about, each with the textarea offset it sits at: `ends[k]` is the
 * string index after the first `k` graphemes, `widths[k]` the offset there, and both start at 0. The table is
 * filled from the left, only as far as a query reaches.
 *
 * The prompt turns the cursor offset into a string index after every edit, and the cursor sits next to the
 * edit. Segmenting the text before the cursor each time made a keystroke cost as much as the text is long
 * (#1261). Grapheme boundaries are decided from the left: whether one falls before a character depends on that
 * character and the ones before it, never on what follows. After an edit every boundary before the first
 * changed character is therefore still valid, and typing at the cursor only segments the graphemes at the
 * edit. The answers never depend on what was asked before; the table only decides how much work they take.
 */
type Boundaries = { text: string; ends: number[]; widths: number[] }

const cache: Boundaries = { text: "", ends: [0], widths: [0] }

/** Length of the prefix the two strings share. */
function sharedPrefix(a: string, b: string) {
  const length = Math.min(a.length, b.length)
  // Typing or deleting at the end leaves one string a prefix of the other; the native comparison settles it.
  if (a.length <= b.length ? b.startsWith(a) : a.startsWith(b)) return length
  let index = 0
  while (index < length && a.charCodeAt(index) === b.charCodeAt(index)) index++
  return index
}

/** The boundaries of `value`, keeping everything the previous text shared with it. */
function boundariesFor(value: string) {
  if (cache.text === value) return cache
  // A boundary is decided by the character after it, and a supplementary character is two UTF-16 units: only
  // the boundaries at least two units before the first difference are certain to survive.
  const keep = Math.max(0, sharedPrefix(cache.text, value) - 2)
  const { ends, widths } = cache
  let low = 0
  let high = ends.length - 1
  while (low < high) {
    const middle = (low + high + 1) >> 1
    if (ends[middle] <= keep) low = middle
    else high = middle - 1
  }
  ends.length = low + 1
  widths.length = low + 1
  cache.text = value
  return cache
}

/** Grows the table until its last offset is past `offset`, or the text ends. */
function extend(table: Boundaries, offset: number) {
  const { ends, widths } = table
  const from = ends[ends.length - 1]
  let width = widths[widths.length - 1]
  if (from >= table.text.length || width > offset) return
  // `from` is a boundary of the whole text, so segmenting from there gives the same graphemes.
  for (const part of graphemes.segment(table.text.slice(from))) {
    width += graphemeWidth(part.segment)
    ends.push(from + part.index + part.segment.length)
    widths.push(width)
    if (width > offset) return
  }
}

/** String index of the first grapheme that ends past `offset`; the end of the text when none does. */
function displayOffsetIndex(value: string, offset: number) {
  if (offset <= 0) return 0

  const table = boundariesFor(value)
  extend(table, offset)

  const { widths } = table
  let low = 1
  let high = widths.length - 1
  let found = -1
  while (low <= high) {
    const middle = (low + high) >> 1
    if (widths[middle] > offset) {
      found = middle
      high = middle - 1
    } else low = middle + 1
  }
  return found === -1 ? value.length : table.ends[found - 1]
}

/** String index for an offset as wide as the whole text: its end, or 0 when it has no width at all. */
function wholeTextIndex(value: string) {
  const table = boundariesFor(value)
  extend(table, Infinity)
  return table.widths[table.widths.length - 1] > 0 ? value.length : 0
}

/** `promptOffsetWidth(value.slice(0, index))`, read off the table when `index` is a boundary. */
function offsetBefore(value: string, index: number) {
  const { ends, widths } = boundariesFor(value)
  let low = 0
  let high = ends.length - 1
  while (low <= high) {
    const middle = (low + high) >> 1
    if (ends[middle] === index) return widths[middle]
    if (ends[middle] < index) low = middle + 1
    else high = middle - 1
  }
  return promptOffsetWidth(value.slice(0, index))
}

/** The text between two textarea offsets; `end` defaults to the end of the text. */
export function displaySlice(value: string, start = 0, end?: number) {
  return value.slice(
    displayOffsetIndex(value, start),
    end === undefined ? wholeTextIndex(value) : displayOffsetIndex(value, end),
  )
}

/** The grapheme at a textarea offset, or none at the end of the text. */
export function displayCharAt(value: string, offset: number) {
  let width = 0
  for (const part of graphemes.segment(value)) {
    const next = width + graphemeWidth(part.segment)
    if (offset === width || offset < next) return part.segment
    width = next
  }
}

/**
 * The textarea offset of the `@` that starts the mention being typed at `offset` (the end of the text by
 * default), if there is one: it has to start the text or follow whitespace, with no whitespace after it.
 */
export function mentionTriggerIndex(value: string, offset?: number) {
  // The text before the cursor is `value.slice(0, end)`, and only its last token decides.
  const end = offset === undefined ? wholeTextIndex(value) : displayOffsetIndex(value, offset)
  const index = end === 0 ? -1 : value.lastIndexOf("@", end - 1)
  if (index === -1) return

  const before = index === 0 ? undefined : value[index - 1]
  const query = value.slice(index, end)
  if ((before === undefined || /\s/.test(before)) && !/\s/.test(query)) {
    return offsetBefore(value, index)
  }
}
