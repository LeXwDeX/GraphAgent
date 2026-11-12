import { describe, expect, test } from "bun:test"
import { displayCharAt, displaySlice, mentionTriggerIndex, promptOffsetWidth } from "../../src/prompt/display"
import { cursorWidth } from "../../src/ui/width"

describe("prompt display", () => {
  test("uses display-width offsets for mentions", () => {
    expect(mentionTriggerIndex("@")).toBe(0)
    expect(mentionTriggerIndex("test @")).toBe(5)
    expect(mentionTriggerIndex("中文 @")).toBe(5)
    expect(mentionTriggerIndex("こんにちは @")).toBe(11)
    expect(mentionTriggerIndex("한국어 @")).toBe(7)
    expect(mentionTriggerIndex("🙂 @")).toBe(3)
    expect(mentionTriggerIndex("中文 @src file", Bun.stringWidth("中文 @src"))).toBe(5)
    expect(displayCharAt("中文 @src", Bun.stringWidth("中文 @"))).toBe("s")
    expect(displaySlice("中文 @src", 5, Bun.stringWidth("中文 @src"))).toBe("@src")
    expect(displaySlice("中文 @src", 6, Bun.stringWidth("中文 @src"))).toBe("src")
    expect(mentionTriggerIndex("👨‍👩‍👧‍👦 @src", Bun.stringWidth("👨‍👩‍👧‍👦 @src"))).toBe(3)
    expect(displayCharAt("👨‍👩‍👧‍👦 @src", Bun.stringWidth("👨‍👩‍👧‍👦 @"))).toBe("s")
    expect(displaySlice("👨‍👩‍👧‍👦 @src", 3, Bun.stringWidth("👨‍👩‍👧‍👦 @src"))).toBe("@src")
    expect(mentionTriggerIndex("@file1\n@file2", 13)).toBe(7)
    expect(displayCharAt("@file1\n@file2", 6)).toBe("\n")
    expect(displaySlice("@file1\n@file2", 8, 13)).toBe("file2")
    expect(mentionTriggerIndex("@file1\nfoo @file2", 17)).toBe(11)
    expect(mentionTriggerIndex("中文 @one\n@two", 14)).toBe(10)
    expect(displaySlice("中文 @one\n@two", 11, 14)).toBe("two")
    expect(mentionTriggerIndex("中文@")).toBeUndefined()
    expect(mentionTriggerIndex("こんにちは@")).toBeUndefined()
    expect(mentionTriggerIndex("한국어@")).toBeUndefined()
    expect(mentionTriggerIndex("🙂@")).toBeUndefined()
    expect(mentionTriggerIndex("hello@")).toBeUndefined()
    expect(mentionTriggerIndex("foo@bar.com")).toBeUndefined()
    expect(mentionTriggerIndex("中文 @src file")).toBeUndefined()
  })
})

describe("prompt display offsets", () => {
  test("measures newlines, combining marks, emoji sequences and zero-width text in textarea offsets", () => {
    expect(promptOffsetWidth("")).toBe(0)
    expect(promptOffsetWidth("a\nb")).toBe(3)
    expect(promptOffsetWidth("e\u0301")).toBe(1)
    expect(promptOffsetWidth("한국어")).toBe(6)
    expect(promptOffsetWidth("\u1100\u1161\u11a8")).toBe(2)
    expect(promptOffsetWidth("🙂")).toBe(2)
    expect(promptOffsetWidth("👨\u200d👩\u200d👧\u200d👦")).toBe(2)
    expect(promptOffsetWidth("🇺🇸")).toBe(2)
    expect(promptOffsetWidth("👋🏽")).toBe(2)
    expect(promptOffsetWidth("1\ufe0f\u20e3")).toBe(2)
    expect(promptOffsetWidth("क\u094dष")).toBe(2)
    expect(promptOffsetWidth("\u200b")).toBe(0)
    expect(promptOffsetWidth("a\u200bb")).toBe(2)
    for (const text of ["", "plain", "中文 👨\u200d👩\u200d👧\u200d👦\n🇺🇸 e\u0301"]) {
      expect(promptOffsetWidth(text)).toBe(
        [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].reduce(
          (width, part) => width + (part.segment === "\n" ? 1 : cursorWidth(part.segment)),
          0,
        ),
      )
    }
  })

  test("finds the trigger after combining marks, emoji sequences, newlines and separators", () => {
    expect(mentionTriggerIndex("e\u0301 @")).toBe(2)
    expect(mentionTriggerIndex("🇺🇸 @x")).toBe(3)
    expect(mentionTriggerIndex("👋🏽 @f")).toBe(3)
    expect(mentionTriggerIndex("1\ufe0f\u20e3 @f")).toBe(3)
    expect(mentionTriggerIndex("क\u094dष @f")).toBe(3)
    expect(mentionTriggerIndex("가\u1100\u1161 @")).toBe(5)
    expect(mentionTriggerIndex("한국어\n@")).toBe(7)
    expect(mentionTriggerIndex("ab\n@x")).toBe(3)
    expect(mentionTriggerIndex("a\t@")).toBe(1)
    expect(mentionTriggerIndex("\u3000@x")).toBe(2)
    expect(mentionTriggerIndex("x\u00a0@y")).toBe(2)
  })

  test("needs whitespace or the start of the text before the trigger and none after it", () => {
    expect(mentionTriggerIndex("a\u200b@")).toBeUndefined()
    expect(mentionTriggerIndex("@a@b")).toBeUndefined()
    expect(mentionTriggerIndex("x @a@b")).toBeUndefined()
    expect(mentionTriggerIndex("@a b")).toBeUndefined()
    expect(mentionTriggerIndex("@a\u3000b")).toBeUndefined()
    expect(mentionTriggerIndex("")).toBeUndefined()
    expect(mentionTriggerIndex("no trigger here")).toBeUndefined()
  })

  test("reads the text before the cursor, wherever the cursor sits", () => {
    // Before the end of the text, and inside a wide grapheme.
    expect(mentionTriggerIndex("@ab cd", 3)).toBe(0)
    expect(mentionTriggerIndex("@ab cd", 4)).toBeUndefined()
    expect(mentionTriggerIndex("中 @a", 3)).toBeUndefined()
    expect(mentionTriggerIndex("中 @a", 4)).toBe(3)
    expect(mentionTriggerIndex("中 @a", 5)).toBe(3)
    expect(mentionTriggerIndex("中@", 1)).toBeUndefined()
    expect(mentionTriggerIndex("中@", 2)).toBeUndefined()
    expect(mentionTriggerIndex("中@", 3)).toBeUndefined()
    expect(mentionTriggerIndex("@", 0)).toBeUndefined()
    expect(mentionTriggerIndex("@", -1)).toBeUndefined()
    expect(mentionTriggerIndex("@", 99)).toBe(0)
    expect(displaySlice("中文", 1, 3)).toBe("中")
    expect(displaySlice("e\u0301x", 0, 1)).toBe("e\u0301")
    expect(displaySlice("e\u0301x", 1)).toBe("x")
    expect(displaySlice("abc", 2, 1)).toBe("")
    expect(displaySlice("\u200b")).toBe("")
    expect(displaySlice("\u200bab")).toBe("\u200bab")
    expect(displayCharAt("中文", 1)).toBe("中")
    expect(displayCharAt("中文", 4)).toBeUndefined()
    expect(displayCharAt("a\u200b", 1)).toBe("\u200b")
  })

  test("answers the same for a text and for the text it was edited into", () => {
    // The same offsets read from the previous text, from an unrelated one, and again.
    expect(mentionTriggerIndex("中文 @")).toBe(5)
    expect(mentionTriggerIndex("中文 @s")).toBe(5)
    expect(mentionTriggerIndex("中文 @")).toBe(5)
    expect(mentionTriggerIndex("e @a")).toBe(2)
    expect(mentionTriggerIndex("中文 @s")).toBe(5)
    expect(mentionTriggerIndex("中文 @s ")).toBeUndefined()
    expect(mentionTriggerIndex("中文 @s\u0301", 7)).toBe(5)
    // A combining mark typed after the last character joins it, so the old boundary is gone.
    expect(displaySlice("e", 0, 1)).toBe("e")
    expect(displaySlice("e\u0301", 0, 1)).toBe("e\u0301")
    expect(displaySlice("e\u0301\u0301", 0, 1)).toBe("e\u0301\u0301")
    expect(displaySlice("🇺", 0, 2)).toBe("🇺")
    expect(displaySlice("🇺🇸", 0, 1)).toBe("")
    expect(displaySlice("🇺🇸", 0, 2)).toBe("🇺🇸")
  })
})

/**
 * The implementation as it was before #1261, unchanged. It segments the whole text before the cursor and
 * every grapheme again to measure it, which is why it is slow, but its answers define the behavior. The
 * current functions have to give exactly the same ones.
 */
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })

function legacyWidth(value: string) {
  let width = 0
  for (const part of graphemes.segment(value)) {
    width += part.segment === "\n" ? 1 : cursorWidth(part.segment)
  }
  return width
}

function legacyIndex(value: string, offset: number) {
  if (offset <= 0) return 0

  let width = 0
  for (const part of graphemes.segment(value)) {
    const next = width + legacyWidth(part.segment)
    if (next > offset) return part.index
    width = next
  }

  return value.length
}

function legacySlice(value: string, start = 0, end = legacyWidth(value)) {
  return value.slice(legacyIndex(value, start), legacyIndex(value, end))
}

function legacyCharAt(value: string, offset: number) {
  let width = 0
  for (const part of graphemes.segment(value)) {
    const next = width + legacyWidth(part.segment)
    if (offset === width || offset < next) return part.segment
    width = next
  }
  return undefined
}

function legacyMention(value: string, offset = legacyWidth(value)) {
  const text = legacySlice(value, 0, offset)
  const index = text.lastIndexOf("@")
  if (index === -1) return undefined

  const before = index === 0 ? undefined : text[index - 1]
  const query = text.slice(index)
  if ((before === undefined || /\s/.test(before)) && !/\s/.test(query)) {
    return legacyWidth(text.slice(0, index))
  }
  return undefined
}

const reference = {
  width: legacyWidth,
  slice: legacySlice,
  charAt: legacyCharAt,
  mention: legacyMention,
}

/** Everything that decides where a grapheme ends or how wide it is: joiners, marks, jamo, surrogates, escapes. */
const AWKWARD = [
  // ASCII, whitespace, the trigger
  "a",
  "b",
  "0",
  " ",
  "\n",
  "\t",
  "@",
  "/",
  // wide, fullwidth and halfwidth
  "中",
  "文",
  "，",
  "こ",
  "ｱ",
  "Ａ",
  // Hangul syllables and conjoining jamo (leading, vowel, trailing)
  "한",
  "\u1100",
  "\u1161",
  "\u11a8",
  // emoji bases, joiner, skin tone, variation selectors, keycap, regional indicators, tags
  "😀",
  "👨",
  "\u200d",
  "👩",
  "\u{1f3fb}",
  "\ufe0f",
  "\ufe0e",
  "\u20e3",
  "1",
  "🇺",
  "🇸",
  "❤",
  "\u{e0067}",
  "\u{e007f}",
  // combining and spacing marks, Indic conjuncts, Thai, an Arabic prepended mark
  "\u0301",
  "\u3099",
  "क",
  "\u094d",
  "ष",
  "ก",
  "\u0e31",
  "\u0e48",
  "\u0600",
  "ب",
  "\u0903",
  "\u093e",
  "க",
  "\u0bcd",
  "ஷ",
  // zero-width and format characters, control characters, escape sequences
  "\u200b",
  "\u200c",
  "\ufeff",
  "\u00ad",
  "\r",
  "\r\n",
  "\x1b[31m",
  "\x1b",
  "\u0085",
  "\u2028",
  // other whitespace
  "\u00a0",
  "\u3000",
  "\u2003",
  // ambiguous width, lone surrogates
  "◆",
  "\ud83d",
  "\ude00",
]

/** A few of each kind, enough for every pair and triple to be tried. */
const SHORT = ["a", " ", "\n", "@", "中", "😀", "\u200d", "\u0301", "\ufe0f", "🇺", "\u200b", "\u1161"]

/** Deterministic pseudo-random numbers (mulberry32), so a failure can be replayed. */
function random(seed: number) {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let value = Math.imul(state ^ (state >>> 15), 1 | state)
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

function pick(next: () => number, atoms: readonly string[]) {
  return atoms[Math.floor(next() * atoms.length)]
}

function text(next: () => number, atoms: readonly string[], max: number) {
  let result = ""
  for (let count = Math.floor(next() * (max + 1)); count > 0; count--) result += pick(next, atoms)
  return result
}

/** Offsets worth asking about: out of range, at both ends, inside the text, not whole numbers. */
function offsetsOf(value: string, next: () => number, extra = 3) {
  const width = reference.width(value)
  const offsets = new Set([-1, 0, 1, width - 1, width, width + 1, 2.5, NaN, Infinity, -Infinity])
  for (let count = 0; count < extra; count++) offsets.add(Math.floor(next() * (width + 2)))
  return [...offsets]
}

/** Every disagreement between the current functions and the reference for `value`; empty when they agree. */
function disagreements(value: string, offsets: readonly number[], pairs = true) {
  const found: string[] = []
  const check = (call: string, actual: unknown, expected: unknown) => {
    if (!Object.is(actual, expected)) {
      found.push(`${call} on ${JSON.stringify(value)}: ${String(actual)} instead of ${String(expected)}`)
    }
  }
  check("promptOffsetWidth()", promptOffsetWidth(value), reference.width(value))
  check("displaySlice()", displaySlice(value), reference.slice(value))
  check("mentionTriggerIndex()", mentionTriggerIndex(value), reference.mention(value))
  for (const start of offsets) {
    check(`displaySlice(${start})`, displaySlice(value, start), reference.slice(value, start))
    check(`displayCharAt(${start})`, displayCharAt(value, start), reference.charAt(value, start))
    check(`mentionTriggerIndex(${start})`, mentionTriggerIndex(value, start), reference.mention(value, start))
    if (!pairs) continue
    for (const end of offsets) {
      check(`displaySlice(${start}, ${end})`, displaySlice(value, start, end), reference.slice(value, start, end))
    }
  }
  return found
}

describe("prompt display against the reference implementation", () => {
  test("agrees on every short combination of the awkward characters", () => {
    const next = random(1)
    const found: string[] = []
    const visit = (prefix: string, depth: number) => {
      for (const atom of SHORT) {
        const value = prefix + atom
        found.push(...disagreements(value, offsetsOf(value, next, 1)))
        if (depth > 1) visit(value, depth - 1)
      }
    }
    visit("", 3)
    expect(found.slice(0, 10)).toEqual([])
  })

  test("agrees on random text", () => {
    const next = random(20260314)
    const found: string[] = []
    for (let round = 0; round < 1200; round++) {
      const value = text(next, AWKWARD, 24)
      found.push(...disagreements(value, offsetsOf(value, next), round % 4 === 0))
    }
    expect(found.slice(0, 10)).toEqual([])
  })

  test("agrees after every edit of a text that is edited in place", () => {
    // The functions remember the text they saw last; this is how the prompt uses them, one edit at a time.
    const next = random(7)
    const found: string[] = []
    let value = ""
    for (let step = 0; step < 3000; step++) {
      const choice = next()
      const at = Math.floor(next() * (value.length + 1))
      if (choice < 0.3) value += pick(next, AWKWARD)
      else if (choice < 0.4) value = value.slice(0, Math.max(0, value.length - 1 - Math.floor(next() * 3)))
      else if (choice < 0.6) value = value.slice(0, at) + pick(next, AWKWARD) + value.slice(at)
      else if (choice < 0.7) value = value.slice(0, at) + value.slice(at + 1 + Math.floor(next() * 2))
      else if (choice < 0.75) value = value.slice(0, at) + text(next, AWKWARD, 3) + value.slice(at)
      else if (choice < 0.8) value = text(next, AWKWARD, 30)
      else if (choice < 0.85) value = pick(next, AWKWARD) + value
      else if (choice < 0.9) value = value.slice(0, Math.max(0, value.length - 1)) + pick(next, AWKWARD)
      if (value.length > 60) value = value.slice(0, 40)

      const width = reference.width(value)
      const offsets = [Math.floor(next() * (width + 2)), width, Math.max(0, width - 1)]
      found.push(...disagreements(value, offsets, false))
    }
    expect(found.slice(0, 10)).toEqual([])
  })

  test("graphemes can be segmented from any boundary, and a boundary does not depend on what follows it", () => {
    // The functions keep the boundaries of the text they saw last and segment on from the last one that is still
    // certain: from a boundary in the middle of a text, and after the text changed behind that boundary.
    const next = random(4242)
    const boundaries = (value: string) => [
      0,
      ...[...graphemes.segment(value)].map((part) => part.index + part.segment.length),
    ]
    const found: string[] = []
    for (let round = 0; round < 3000; round++) {
      const value = text(next, AWKWARD, 14)
      const all = boundaries(value)
      for (const start of all) {
        const restarted = boundaries(value.slice(start)).map((end) => end + start)
        if (restarted.join() !== all.filter((end) => end >= start).join()) {
          found.push(`from ${start} in ${JSON.stringify(value)}`)
        }
      }

      const changed = value.slice(0, Math.floor(next() * (value.length + 1))) + text(next, AWKWARD, 6)
      let shared = 0
      while (
        shared < Math.min(value.length, changed.length) &&
        value.charCodeAt(shared) === changed.charCodeAt(shared)
      ) {
        shared++
      }
      // A boundary is decided by the character after it, which is two UTF-16 units when it is supplementary.
      const certain = (end: number) => end <= Math.max(0, shared - 2)
      if (all.filter(certain).join() !== boundaries(changed).filter(certain).join()) {
        found.push(`${JSON.stringify(value)} edited into ${JSON.stringify(changed)}`)
      }
    }
    expect(found.slice(0, 5)).toEqual([])
  })

  test("a grapheme is measured the same on its own as inside the text", () => {
    // The reference measures every grapheme by segmenting it again; the current code does not, which only
    // holds while a grapheme is always a single segment of its own.
    const next = random(99)
    const split: string[] = []
    for (let round = 0; round < 3000; round++) {
      for (const part of graphemes.segment(text(next, AWKWARD, 16))) {
        const inner = [...graphemes.segment(part.segment)].map((item) => item.segment)
        if (inner.length !== 1 || inner[0] !== part.segment) split.push(JSON.stringify(part.segment))
      }
    }
    expect(split).toEqual([])
  })
})
