export * as Token from "./token"

const CHARS_PER_TOKEN = 4
// Measured English prose runs 3.0-3.3 chars per token, so 4 undercounts it by about a quarter. A reserve must not
// undercount, so `estimateReserve` counts the non-CJK part at 3; `estimate` keeps 4 for callers that want the mean.
const RESERVE_CHARS_PER_TOKEN = 3

export const estimate = (input: string) => Math.max(0, Math.round(input.length / CHARS_PER_TOKEN))

// CJK code points tokenize near one token per character on the openai-compatible relays in use, so the
// English-calibrated length/4 estimate undercounts CJK-dominant text 2-4x. That makes a token reserve built from
// `estimate` systematically undersized: a successful near-cap auxiliary call can then settle above its reserve and
// trip the over-budget paid-admission pause without exceeding any configured limit. `estimateReserve` counts CJK
// code points as one token each and the rest at 3 chars/token; it is ceil-rounded because underestimating a
// reserve is the expensive direction. Reserve/input-gating use this. Comparing two texts in different scripts (is a
// rewrite smaller than its source?) needs an unbiased estimate instead: see `estimateComparable`.
const CJK_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x3000, 0x303f], // CJK punctuation
  [0x3040, 0x30ff], // hiragana + katakana
  [0x3400, 0x4dbf], // CJK unified ideographs extension A
  [0x4e00, 0x9fff], // CJK unified ideographs
  [0xac00, 0xd7af], // hangul syllables
  [0xf900, 0xfaff], // CJK compatibility ideographs
  [0xff00, 0xffef], // fullwidth forms
  [0x20000, 0x2ffff], // CJK unified ideographs extensions B-F
]

const isCjk = (codePoint: number) => CJK_RANGES.some(([lo, hi]) => codePoint >= lo && codePoint <= hi)

export const estimateReserve = (input: string) => {
  let cjk = 0
  let other = 0
  for (const ch of input) (isCjk(ch.codePointAt(0) ?? 0) ? cjk++ : other++)
  return Math.max(0, cjk + Math.ceil(other / RESERVE_CHARS_PER_TOKEN))
}

// Calibrated on the configured relays (2026-10-08, DeepSeek and GLM tokenizers): English prose ≈3.0–3.3 chars per
// token, CJK ≈0.53–0.63 tokens per character. `estimateReserve` deliberately overstates CJK (one token per code
// point) and rounds up, so its two scripts are not on the same scale and a comparison across them is biased. Use
// this only for relative comparisons; reserves and limits keep the conservative estimators.
const COMPARABLE_CJK_TOKENS_PER_CHAR = 0.55
const COMPARABLE_CHARS_PER_TOKEN = 3

export const estimateComparable = (input: string) => {
  let cjk = 0
  let other = 0
  for (const ch of input) (isCjk(ch.codePointAt(0) ?? 0) ? cjk++ : other++)
  return Math.max(0, Math.round(cjk * COMPARABLE_CJK_TOKENS_PER_CHAR + other / COMPARABLE_CHARS_PER_TOKEN))
}
