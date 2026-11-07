const boot = performance.now()
const phase = (name: string) => console.error(JSON.stringify({ phase: name, elapsed: performance.now() - boot }))
phase("boot")
process.on("exit", () => phase("exit"))
// A test-only delay demonstrates that startup is outside validation's budget.
const delay = Number(process.argv[2] ?? 0)
if (delay > 0) await Bun.sleep(delay)
const { validatePayloadAsync, registerCaptureSlot, clearCaptureSlot } = await import("../../../src/dag/runtime/capture")
phase("imports")

const session = "budget-subprocess"
registerCaptureSlot(session, { type: "string", pattern: "^(a+)\\1$" })
const normal = await validatePayloadAsync(session, "aaaa", new AbortController().signal)
if (!normal.ok || normal.payload !== "aaaa") throw new Error(`worker compatibility failed: ${JSON.stringify(normal)}`)
phase("compatibility")
registerCaptureSlot(session, { type: "null" })
const nullable = await validatePayloadAsync(session, null, new AbortController().signal)
if (!nullable.ok || nullable.payload !== null) throw new Error(`worker null failed: ${JSON.stringify(nullable)}`)
phase("null")
registerCaptureSlot(session, { type: "string", pattern: "^(a|a?)+$" })
console.log(JSON.stringify({ ready: true }))
phase("ready")
let beats = 0
const timer = setInterval(() => beats++, 10)
const start = performance.now()
const result = await validatePayloadAsync(session, "a".repeat(99_999) + "!", new AbortController().signal)
phase("validation")
clearInterval(timer)
clearCaptureSlot(session)
const elapsed = performance.now() - start
console.log(JSON.stringify({ result, beats, elapsed }))
phase("output")
if (result.ok || !result.error.includes("host resource budget") || beats < 5 || elapsed > 1_000) process.exit(1)
// The validation worker is terminated asynchronously. Exit explicitly so a slow worker teardown on a loaded host
// cannot extend the fixture beyond the test's validation/exit watchdog.
process.exit(0)
