import { strict as assert } from "node:assert"
import {
  clearCaptureSlot,
  registerCaptureSlot,
  validatePayloadAsync,
  isCaptureValidationCurrent,
  settleCapturedOutput,
} from "../../../src/dag/runtime/capture"

const session = "node-capture"
const signal = () => new AbortController().signal
registerCaptureSlot(session, { type: "null" })
assert.deepEqual((await validatePayloadAsync(session, null, signal())).ok, true)
const review = { verdict: "ACCEPT", implementation_fingerprint: "sha256:expected" }
registerCaptureSlot(session, {
  required: ["verdict", "implementation_fingerprint"],
  properties: { verdict: { enum: ["ACCEPT", "REJECT"] }, implementation_fingerprint: { type: "string" } },
})
assert.equal((await validatePayloadAsync(session, JSON.stringify(review), signal())).ok, true)
assert.equal(settleCapturedOutput(review, "sha256:expected").kind, "complete")
const staleReview = settleCapturedOutput(review, "sha256:changed")
assert.ok(staleReview.kind === "fail" && staleReview.reason.includes("fingerprint"))
const slow = { pattern: "^(a|a?)+$" }
const payload = "a".repeat(99_999) + "!"
registerCaptureSlot(session, slow)
let beats = 0
const heartbeat = setInterval(() => beats++, 10)
const timed = await validatePayloadAsync(session, payload, signal())
clearInterval(heartbeat)
assert.ok(!timed.ok && timed.error.includes("host resource budget"))
assert.ok(beats >= 5)
const abort = new AbortController()
const pending = validatePayloadAsync(session, payload, abort.signal)
setTimeout(() => abort.abort(), 30)
assert.deepEqual(await pending, { ok: false, error: "schema validation cancelled" })
const old = validatePayloadAsync(session, payload, signal())
clearCaptureSlot(session)
registerCaptureSlot(session, slow)
assert.equal((await old).ok, false)
const valid = await validatePayloadAsync(session, "a", signal())
assert.ok(valid.ok)
assert.equal(isCaptureValidationCurrent(session, valid), true)
clearCaptureSlot(session)
registerCaptureSlot(session, slow)
assert.equal(isCaptureValidationCurrent(session, valid), false)
clearCaptureSlot(session)
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
