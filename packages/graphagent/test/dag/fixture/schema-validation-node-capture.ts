// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { strict as assert } from "node:assert"
import {
  closeCaptureSlot,
  createCaptureSlot,
  validatePayloadAsync,
  isCaptureValidationCurrent,
  settleCapturedOutput,
} from "../../../src/dag/runtime/capture"

const signal = () => new AbortController().signal
const nullSlot = createCaptureSlot({ type: "null" })
assert.deepEqual((await validatePayloadAsync(nullSlot, null, signal())).ok, true)
const review = { verdict: "ACCEPT", implementation_fingerprint: "sha256:expected" }
const reviewSlot = createCaptureSlot({
  required: ["verdict", "implementation_fingerprint"],
  properties: { verdict: { enum: ["ACCEPT", "REJECT"] }, implementation_fingerprint: { type: "string" } },
})
assert.equal((await validatePayloadAsync(reviewSlot, JSON.stringify(review), signal())).ok, true)
assert.equal(settleCapturedOutput(review, "sha256:expected").kind, "complete")
const staleReview = settleCapturedOutput(review, "sha256:changed")
assert.ok(staleReview.kind === "fail" && staleReview.reason.includes("fingerprint"))
const slowSlot = createCaptureSlot({ pattern: "^(a|a?)+$" })
const payload = "a".repeat(99_999) + "!"
let beats = 0
const heartbeat = setInterval(() => beats++, 10)
const timed = await validatePayloadAsync(slowSlot, payload, signal())
clearInterval(heartbeat)
assert.ok(!timed.ok && timed.error.includes("host resource budget"))
assert.ok(beats >= 5)
const abort = new AbortController()
const pending = validatePayloadAsync(slowSlot, payload, abort.signal)
setTimeout(() => abort.abort(), 30)
assert.deepEqual(await pending, { ok: false, error: "schema validation cancelled" })
const old = validatePayloadAsync(slowSlot, payload, signal())
closeCaptureSlot(slowSlot)
const nextSlot = createCaptureSlot({ pattern: "^(a|a?)+$" })
assert.equal((await old).ok, false)
const valid = await validatePayloadAsync(nextSlot, "a", signal())
assert.ok(valid.ok)
assert.equal(isCaptureValidationCurrent(nextSlot, valid), true)
closeCaptureSlot(nextSlot)
assert.equal(isCaptureValidationCurrent(nextSlot, valid), false)
console.log(
  JSON.stringify({
    runtime: process.version,
    normal: true,
    deadline: true,
    cancelled: true,
    aba: true,
    review: true,
    beats,
  }),
)
