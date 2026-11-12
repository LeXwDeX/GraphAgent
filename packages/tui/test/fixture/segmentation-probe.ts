// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

/** What `Intl.Segmenter` was asked to do: `segment()` calls and iterator steps. */
export type Segmentation = { calls: number; steps: number }

/**
 * Counts the grapheme segmentation done while `run` executes, by any segmenter in the process. A clock tells
 * a slow keystroke from a fast one only as far as the machine is quiet; these counts do not depend on the
 * machine at all, so a test can hold a keystroke to "a few graphemes" however long the text is.
 */
export async function countSegmentation(run: () => unknown): Promise<Segmentation> {
  // oxlint-disable-next-line typescript-eslint/unbound-method -- called with the segmenter as `this` below
  const segment = Intl.Segmenter.prototype.segment
  const counted: Segmentation = { calls: 0, steps: 0 }
  Intl.Segmenter.prototype.segment = function (this: Intl.Segmenter, input: string) {
    counted.calls++
    const segments = segment.call(this, input)
    const iterate = segments[Symbol.iterator].bind(segments)
    segments[Symbol.iterator] = () => {
      const iterator = iterate()
      const next = iterator.next.bind(iterator)
      iterator.next = () => {
        counted.steps++
        return next()
      }
      return iterator
    }
    return segments
  }
  try {
    await run()
  } finally {
    Intl.Segmenter.prototype.segment = segment
  }
  return counted
}
