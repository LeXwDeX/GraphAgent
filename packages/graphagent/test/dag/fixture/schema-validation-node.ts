import { strict as assert } from "node:assert"
import { pathToFileURL } from "node:url"
import { validateInWorker } from "../../../src/dag/runtime/schema-validation.ts"

const target = process.argv[2] ? pathToFileURL(process.argv[2]) : undefined
const validate = (schema: Record<string, unknown>, payload: unknown, signal: AbortSignal) =>
  validateInWorker(schema, payload, signal, 250, target)

assert.equal(typeof globalThis.Worker, "undefined", "this regression must use actual Node worker_threads")
for (const [schema, payload, ok] of [
  [{ type: "null" }, null, true],
  [{ pattern: "^(?=a)(a+)\\1$" }, "aaaa", true],
  [{ pattern: "[" }, "a", false],
  [{ type: "object", required: ["n"] }, '{"n":1}', true],
] as const)
  assert.equal((await validate(schema, payload, new AbortController().signal)).ok, ok)

const slow = { pattern: "^(a|a?)+$" }
const payload = "a".repeat(99_999) + "!"
let beats = 0
const heartbeat = setInterval(() => beats++, 10)
const timed = await validate(slow, payload, new AbortController().signal)
clearInterval(heartbeat)
assert.equal(timed.ok, false)
assert.ok(!timed.ok && timed.error.includes("host resource budget"))
assert.ok(beats >= 5)
const abort = new AbortController()
const pending = validate(slow, payload, abort.signal)
setTimeout(() => abort.abort(), 30)
assert.deepEqual(await pending, { ok: false, error: "schema validation cancelled" })
assert.deepEqual(await validate({ type: "null" }, null, new AbortController().signal), { ok: true, payload: null })
console.log(JSON.stringify({ runtime: process.version, normal: true, deadline: true, cancelled: true, beats }))
