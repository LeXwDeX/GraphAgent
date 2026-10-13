import { describe, expect, spyOn } from "bun:test"
import { Effect, Layer } from "effect"
import * as fs from "fs/promises"
import os from "os"
import path from "path"
import { SettingsHook, HOOK_REWAKE_SENTINEL } from "@/hook/settings"
import { HookRewake } from "@/hook/rewake"
import { SessionHooks } from "@/hook/session-hooks"
import { InstanceState } from "@/effect/instance-state"
import { InstanceStore } from "@/project/instance-store"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Database } from "@opencode-ai/core/database/database"
import { SessionID } from "@/session/schema"
import * as Log from "@/util/log"
import { testEffect, pollWithTimeout } from "../lib/effect"

// ── Test layer ──────────────────────────────────────────────────
const rewakeCalls: { sessionID: string; text: string; stopChain?: unknown }[] = []
const mockHookRewakeLayer = Layer.succeed(
  HookRewake.Service,
  HookRewake.Service.of({
    rewake: (input) =>
      Effect.sync(() => {
        rewakeCalls.push(input)
      }),
  }),
)

const testLayer = SettingsHook.layer.pipe(
  Layer.provide(EventV2Bridge.defaultLayer),
  Layer.provide(Database.defaultLayer),
  Layer.provideMerge(SessionHooks.defaultLayer),
  Layer.provideMerge(mockHookRewakeLayer),
)

const it = testEffect(testLayer)

const writeSettingsTo = (hooksJson: object) => (dir: string) =>
  Effect.promise(() =>
    fs
      .mkdir(path.join(dir, ".opencode"), { recursive: true })
      .then(() => fs.writeFile(path.join(dir, ".opencode", "hooks.json"), JSON.stringify(hooksJson))),
  )

const tmp = (name: string) => path.join(os.tmpdir(), `opencode-test-${name}`)

const observeDiscardedCallback = (sessionID: string) =>
  Effect.gen(function* () {
    let discarded = false
    const original = Log.Default.debug.bind(Log.Default)
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        spyOn(Log.Default, "debug").mockImplementation((message, meta) => {
          if (message === "async Stop callback discarded: chain invalidated" && meta?.sessionID === sessionID) {
            discarded = true
          }
          original(message, meta)
        }),
      ),
      (spy) => Effect.sync(() => spy.mockRestore()),
    )
    return pollWithTimeout(
      Effect.sync(() => (discarded ? true : undefined)),
      "pending hook callback was never discarded",
    )
  })

describe("hook-async-rewake", () => {
  // ── 4.1: Async hook does not block the trigger ───────────────
  const marker41 = tmp("async-4-1.txt")
  it.instance(
    "async hook does not delay trigger — marker file appears after trigger returns",
    () =>
      Effect.gen(function* () {
        rewakeCalls.length = 0
        const hook = yield* SettingsHook.Service
        yield* Effect.promise(() => fs.rm(marker41, { force: true }))

        const r = yield* hook.trigger(
          { event: "SessionStart", source: "startup" },
          { sessionID: "sess-4-1", transcriptPath: "" },
        )

        expect(r.additionalContexts).toEqual([])
        expect(r.systemMessages).toEqual([])
        expect(r.blocked).toBeUndefined()

        yield* pollWithTimeout(
          Effect.promise(() =>
            fs
              .access(marker41)
              .then(() => true as const)
              .catch(() => undefined),
          ),
          "async hook marker file never appeared",
        )
      }),
    {
      init: writeSettingsTo({
        SessionStart: [
          {
            hooks: [
              {
                type: "command",
                command: `sleep 0.3 && touch ${JSON.stringify(marker41)}`,
                async: true,
              },
            ],
          },
        ],
      }),
    },
  )

  // ── 4.2: Async output cannot gate a decision ─────────────────
  it.instance(
    "async PreToolUse hook exit-2 does not block",
    () =>
      Effect.gen(function* () {
        rewakeCalls.length = 0
        const hook = yield* SettingsHook.Service

        const r = yield* hook.trigger(
          { event: "PreToolUse", toolName: "Write", toolInput: {} },
          { sessionID: "sess-4-2", transcriptPath: "" },
        )

        expect(r.blocked).toBeUndefined()
        expect(r.permissionDecision).toBeUndefined()
      }),
    {
      init: writeSettingsTo({
        PreToolUse: [
          {
            matcher: "Write",
            hooks: [{ type: "command", command: "echo blocked >&2 && exit 2", async: true }],
          },
        ],
      }),
    },
  )

  // ── 4.3: Rewake end-to-end ───────────────────────────────────
  it.instance(
    "async+asyncRewake exit-2 admits a steer prompt with sentinel + stderr",
    () =>
      Effect.gen(function* () {
        rewakeCalls.length = 0
        const hook = yield* SettingsHook.Service

        const r = yield* hook.trigger(
          { event: "PostToolUse", toolName: "Write", toolInput: {}, toolResponse: {} },
          { sessionID: "sess-4-3", transcriptPath: "" },
        )

        expect(r.blocked).toBeUndefined()

        yield* pollWithTimeout(
          Effect.sync(() => rewakeCalls[0]),
          "rewake was never called",
        )
        expect(rewakeCalls[0].sessionID).toBe("sess-4-3")
        expect(rewakeCalls[0].text.startsWith(HOOK_REWAKE_SENTINEL)).toBe(true)
        expect(rewakeCalls[0].text).toContain("rewake-payload-4-3")
        expect(rewakeCalls[0].text).toContain("</system-reminder>")
      }),
    {
      init: writeSettingsTo({
        PostToolUse: [
          {
            matcher: "Write",
            hooks: [
              {
                type: "command",
                command: "echo rewake-payload-4-3 >&2 && exit 2",
                async: true,
                asyncRewake: true,
              },
            ],
          },
        ],
      }),
    },
  )

  // ── 4.4a: exit-0 admits nothing ──────────────────────────────
  // Readiness signal: hook writes a marker when its shell command finishes.
  // runEntry resolve → onAsyncComplete is a synchronous flatMap continuation,
  // so marker-visible == onAsyncComplete's early-return already executed.
  // Asserting after marker is deterministic, not a time-window guess.
  const marker44a = tmp("async-4-4a.txt")
  it.instance(
    "exit-0 asyncRewake hook admits nothing",
    () =>
      Effect.gen(function* () {
        rewakeCalls.length = 0
        const hook = yield* SettingsHook.Service
        yield* Effect.promise(() => fs.rm(marker44a, { force: true }))

        yield* hook.trigger({ event: "Stop", stopHookActive: false }, { sessionID: "sess-4-4a", transcriptPath: "" })

        yield* pollWithTimeout(
          Effect.promise(() =>
            fs
              .access(marker44a)
              .then(() => true as const)
              .catch(() => undefined),
          ),
          "4.4a hook marker never appeared — fiber did not reach onAsyncComplete",
        )
        // Marker visible ⇒ runEntry done ⇒ onAsyncComplete (sync flatMap) already
        // hit the parts.length === 0 early return. Deterministic.
        expect(rewakeCalls.length).toBe(0)
      }),
    {
      init: writeSettingsTo({
        Stop: [
          {
            hooks: [
              {
                type: "command",
                command: `echo ok && touch ${JSON.stringify(marker44a)}`,
                async: true,
                asyncRewake: true,
              },
            ],
          },
        ],
      }),
    },
  )

  // ── 4.4b: SessionEnd never rewakes ───────────────────────────
  const marker44b = tmp("async-4-4b.txt")
  it.instance(
    "SessionEnd asyncRewake hook never rewakes",
    () =>
      Effect.gen(function* () {
        rewakeCalls.length = 0
        const hook = yield* SettingsHook.Service
        yield* Effect.promise(() => fs.rm(marker44b, { force: true }))

        yield* hook.trigger({ event: "SessionEnd", reason: "other" }, { sessionID: "sess-4-4b", transcriptPath: "" })

        yield* pollWithTimeout(
          Effect.promise(() =>
            fs
              .access(marker44b)
              .then(() => true as const)
              .catch(() => undefined),
          ),
          "4.4b hook marker never appeared — fiber did not reach onAsyncComplete",
        )
        // Marker visible ⇒ onAsyncComplete already hit the `event === "SessionEnd"` early return.
        expect(rewakeCalls.length).toBe(0)
      }),
    {
      init: writeSettingsTo({
        SessionEnd: [
          {
            hooks: [
              {
                type: "command",
                // touch BEFORE exit 2 so the marker is written despite the non-zero exit
                command: `touch ${JSON.stringify(marker44b)} && echo ending >&2 && exit 2`,
                async: true,
                asyncRewake: true,
              },
            ],
          },
        ],
      }),
    },
  )

  // ── 4.4c: missing sessionID skips rewake ─────────────────────
  const marker44c = tmp("async-4-4c.txt")
  it.instance(
    "missing sessionID skips rewake",
    () =>
      Effect.gen(function* () {
        rewakeCalls.length = 0
        const hook = yield* SettingsHook.Service
        yield* Effect.promise(() => fs.rm(marker44c, { force: true }))

        yield* hook.trigger({ event: "Stop", stopHookActive: false }, { sessionID: "", transcriptPath: "" })

        yield* pollWithTimeout(
          Effect.promise(() =>
            fs
              .access(marker44c)
              .then(() => true as const)
              .catch(() => undefined),
          ),
          "4.4c hook marker never appeared — fiber did not reach onAsyncComplete",
        )
        // Marker visible ⇒ onAsyncComplete already hit the `!sessionID` early return.
        expect(rewakeCalls.length).toBe(0)
      }),
    {
      init: writeSettingsTo({
        Stop: [
          {
            hooks: [
              {
                type: "command",
                command: `touch ${JSON.stringify(marker44c)} && echo nosession >&2 && exit 2`,
                async: true,
                asyncRewake: true,
              },
            ],
          },
        ],
      }),
    },
  )

  // ── 4.5: asyncRewake without async is inert ──────────────────
  it.instance(
    "asyncRewake:true without async:true runs synchronously",
    () =>
      Effect.gen(function* () {
        rewakeCalls.length = 0
        const hook = yield* SettingsHook.Service

        yield* hook.trigger({ event: "Stop", stopHookActive: false }, { sessionID: "sess-4-5", transcriptPath: "" })
        expect(rewakeCalls.length).toBe(0)
      }),
    {
      init: writeSettingsTo({
        Stop: [{ hooks: [{ type: "command", command: "echo ok", asyncRewake: true }] }],
      }),
    },
  )

  // ── 4.6: Loop guard — sentinel prefix ────────────────────────
  it.instance("HOOK_REWAKE_SENTINEL is a stable prefix of rewake prompts", () =>
    Effect.gen(function* () {
      expect(typeof HOOK_REWAKE_SENTINEL).toBe("string")
      expect(HOOK_REWAKE_SENTINEL.length).toBeGreaterThan(0)
      expect(HOOK_REWAKE_SENTINEL.startsWith("<system-reminder>")).toBe(true)
    }),
  )

  // ── 4.7: once async session entry removed at fork time ───────
  const marker47 = tmp("once-4-7.txt")
  it.instance("once:true async session hook fires only once across two triggers", () =>
    Effect.gen(function* () {
      rewakeCalls.length = 0
      const hook = yield* SettingsHook.Service
      const sessionHooks = yield* SessionHooks.Service
      yield* Effect.promise(() => fs.rm(marker47, { force: true }))

      yield* sessionHooks.add(SessionID.make("sess-4-7"), {
        event: "Stop",
        once: true,
        hooks: [
          {
            type: "command",
            command: `sleep 0.2 && touch ${JSON.stringify(marker47)}`,
            async: true,
          },
        ],
      })

      // First trigger — forks the hook, removes entry at fork time
      yield* hook.trigger({ event: "Stop", stopHookActive: false }, { sessionID: "sess-4-7", transcriptPath: "" })

      // Second trigger immediately — entry already removed
      const r2 = yield* hook.trigger(
        { event: "Stop", stopHookActive: false },
        { sessionID: "sess-4-7", transcriptPath: "" },
      )
      expect(r2.additionalContexts).toEqual([])

      // Verify the first hook's marker appeared
      yield* pollWithTimeout(
        Effect.promise(() =>
          fs
            .access(marker47)
            .then(() => true as const)
            .catch(() => undefined),
        ),
        "once-marker never appeared",
      )

      const remaining = yield* sessionHooks.list(SessionID.make("sess-4-7"), "Stop")
      expect(remaining.length).toBe(0)
    }),
  )
})

for (const event of ["Stop", "StopFailure"] as const) {
  for (const boundary of ["UserPromptSubmit", "SessionEnd", "InstanceDispose"] as const) {
    const release = tmp(`stale-${event}-${boundary}-${crypto.randomUUID()}`)
    const completed = `${release}.completed`
    it.instance(`pending async ${event} callback is invalidated by ${boundary}`, () =>
      Effect.gen(function* () {
        rewakeCalls.length = 0
        const hook = yield* SettingsHook.Service
        const hooks = yield* SessionHooks.Service
        const sessionID = SessionID.make(`ses-stale-${event}-${boundary}`)
        const discarded = yield* observeDiscardedCallback(sessionID)
        yield* hooks.add(sessionID, {
          event,
          once: true,
          hooks: [
            {
              type: "command",
              async: true,
              asyncRewake: true,
              command: `while [ ! -f ${JSON.stringify(release)} ]; do sleep 0.01; done; printf '%s' '{"systemMessage":"stale result"}'; touch ${JSON.stringify(completed)}`,
            },
          ],
        })
        yield* hook.trigger(
          event === "StopFailure"
            ? { event, stopHookActive: false, error: "provider failure" }
            : { event, stopHookActive: false },
          { sessionID, transcriptPath: "" },
        )
        if (boundary === "InstanceDispose") {
          const store = yield* InstanceStore.Service
          yield* store.dispose(yield* InstanceState.context)
        } else {
          yield* hook.trigger(
            boundary === "SessionEnd"
              ? { event: "SessionEnd", reason: "other" }
              : { event: "UserPromptSubmit", prompt: "new input" },
            { sessionID, transcriptPath: "" },
          )
        }
        yield* Effect.promise(() => fs.writeFile(release, "go"))
        yield* pollWithTimeout(
          Effect.promise(() =>
            fs
              .access(completed)
              .then(() => true as const)
              .catch(() => undefined),
          ),
          "pending hook did not complete",
        )
        yield* discarded
        expect(rewakeCalls).toEqual([])
        yield* Effect.promise(() => Promise.all([fs.rm(release), fs.rm(completed)]))
      }),
    )
  }
}

// Session-cancel invalidation (issue 774): SessionPrompt.cancel invalidates
// the pending stop chain; a callback completing afterwards must be refused.
// These unit cases drive the SettingsHook side directly (the real service
// method the cancel path calls).
for (const event of ["Stop", "StopFailure"] as const) {
  const release = tmp(`cancel-${event}-${crypto.randomUUID()}`)
  const completed = `${release}.completed`
  it.instance(`pending async ${event} callback is invalidated by session cancel`, () =>
    Effect.gen(function* () {
      rewakeCalls.length = 0
      const hook = yield* SettingsHook.Service
      const hooks = yield* SessionHooks.Service
      const sessionID = SessionID.make(`ses-cancel-${event}`)
      const discarded = yield* observeDiscardedCallback(sessionID)
      yield* hooks.add(sessionID, {
        event,
        once: true,
        hooks: [
          {
            type: "command",
            async: true,
            asyncRewake: true,
            command: `while [ ! -f ${JSON.stringify(release)} ]; do sleep 0.01; done; printf '%s' '{"systemMessage":"result after cancel"}'; touch ${JSON.stringify(completed)}`,
          },
        ],
      })
      yield* hook.trigger(
        event === "StopFailure"
          ? { event, stopHookActive: false, error: "provider failure" }
          : { event, stopHookActive: false },
        { sessionID, transcriptPath: "" },
      )
      if (hook.invalidateStopRewakeChain) yield* hook.invalidateStopRewakeChain(sessionID)
      yield* Effect.promise(() => fs.writeFile(release, "go"))
      yield* pollWithTimeout(
        Effect.promise(() =>
          fs
            .access(completed)
            .then(() => true as const)
            .catch(() => undefined),
        ),
        "pending hook did not complete",
      )
      yield* discarded
      expect(rewakeCalls).toEqual([])
      yield* Effect.promise(() => Promise.all([fs.rm(release), fs.rm(completed)]))
    }),
  )
}

it.instance("session cancel invalidation is per-session — other pending callbacks still rewake", () =>
  Effect.gen(function* () {
    rewakeCalls.length = 0
    const hook = yield* SettingsHook.Service
    const hooks = yield* SessionHooks.Service
    const a = SessionID.make("ses-cancel-iso-a")
    const discarded = yield* observeDiscardedCallback(a)
    const b = SessionID.make("ses-cancel-iso-b")
    const releaseA = tmp(`cancel-iso-a-${crypto.randomUUID()}`)
    const releaseB = tmp(`cancel-iso-b-${crypto.randomUUID()}`)
    const completedB = `${releaseB}.completed`
    for (const [sid, release] of [
      [a, releaseA],
      [b, releaseB],
    ] as const) {
      yield* hooks.add(sid, {
        event: "Stop",
        once: true,
        hooks: [
          {
            type: "command",
            async: true,
            asyncRewake: true,
            command: `while [ ! -f ${JSON.stringify(release)} ]; do sleep 0.01; done; printf '%s' '{"systemMessage":"verdict ${sid}"}'; touch ${JSON.stringify(`${release}.completed`)}`,
          },
        ],
      })
      yield* hook.trigger({ event: "Stop", stopHookActive: false }, { sessionID: sid, transcriptPath: "" })
    }
    // Cancel session A only: B's pending chain must stay valid.
    if (hook.invalidateStopRewakeChain) yield* hook.invalidateStopRewakeChain(a)
    yield* Effect.promise(() => Promise.all([fs.writeFile(releaseA, "go"), fs.writeFile(releaseB, "go")]))
    yield* pollWithTimeout(
      Effect.promise(() =>
        fs
          .access(completedB)
          .then(() => true as const)
          .catch(() => undefined),
      ),
      "session B callback did not complete",
    )
    yield* pollWithTimeout(
      Effect.promise(() =>
        fs
          .access(`${releaseA}.completed`)
          .then(() => true as const)
          .catch(() => undefined),
      ),
      "session A callback did not complete",
    )
    yield* discarded
    yield* pollWithTimeout(
      Effect.sync(() => (rewakeCalls.some((call) => call.sessionID === b) ? true : undefined)),
      "session B callback never rewake",
    )
    expect(rewakeCalls).toHaveLength(1)
    expect(rewakeCalls[0].sessionID).toBe(b)
    yield* Effect.promise(() =>
      Promise.all([fs.rm(releaseA), fs.rm(releaseB), fs.rm(`${releaseA}.completed`), fs.rm(`${completedB}`)]),
    )
  }),
)

it.instance("a fresh Stop trigger after cancel establishes a new valid chain", () =>
  Effect.gen(function* () {
    rewakeCalls.length = 0
    const hook = yield* SettingsHook.Service
    const hooks = yield* SessionHooks.Service
    const sessionID = SessionID.make("ses-cancel-fresh")
    const discarded = yield* observeDiscardedCallback(sessionID)
    const releaseOld = tmp(`cancel-fresh-old-${crypto.randomUUID()}`)
    const releaseNew = tmp(`cancel-fresh-new-${crypto.randomUUID()}`)
    const cmd = (release: string, body: string) =>
      `while [ ! -f ${JSON.stringify(release)} ]; do sleep 0.01; done; ${body}`
    // First chain: invalidated by the cancel below.
    yield* hooks.add(sessionID, {
      event: "Stop",
      once: true,
      hooks: [
        {
          type: "command",
          async: true,
          asyncRewake: true,
          command: cmd(
            releaseOld,
            `printf '%s' '{"systemMessage":"stale"}'; touch ${JSON.stringify(`${releaseOld}.completed`)}`,
          ),
        },
      ],
    })
    yield* hook.trigger({ event: "Stop", stopHookActive: false }, { sessionID, transcriptPath: "" })
    if (hook.invalidateStopRewakeChain) yield* hook.invalidateStopRewakeChain(sessionID)
    // Second trigger after the cancel: a NEW chain — its callback must rewake.
    yield* hooks.add(sessionID, {
      event: "Stop",
      once: true,
      hooks: [
        {
          type: "command",
          async: true,
          asyncRewake: true,
          command: cmd(
            releaseNew,
            `printf '%s' '{"systemMessage":"fresh verdict"}'; touch ${JSON.stringify(`${releaseNew}.completed`)}`,
          ),
        },
      ],
    })
    yield* hook.trigger({ event: "Stop", stopHookActive: false }, { sessionID, transcriptPath: "" })
    yield* Effect.promise(() => fs.writeFile(releaseOld, "go"))
    yield* pollWithTimeout(
      Effect.promise(() =>
        fs
          .access(`${releaseOld}.completed`)
          .then(() => true as const)
          .catch(() => undefined),
      ),
      "stale callback did not complete",
    )
    yield* discarded
    expect(rewakeCalls).toEqual([])
    yield* Effect.promise(() => fs.writeFile(releaseNew, "go"))
    yield* pollWithTimeout(
      Effect.promise(async () => (rewakeCalls.length === 1 ? true : undefined)),
      "fresh chain callback never rewake",
    )
    expect(rewakeCalls[0].sessionID).toBe(sessionID)
    yield* pollWithTimeout(
      Effect.promise(() =>
        fs
          .access(`${releaseNew}.completed`)
          .then(() => true as const)
          .catch(() => undefined),
      ),
      "fresh callback marker never appeared",
    )
    yield* Effect.promise(() => fs.rm(releaseOld, { force: true }))
    yield* Effect.promise(() => fs.rm(releaseNew, { force: true }))
    yield* Effect.promise(() => fs.rm(`${releaseOld}.completed`, { force: true }))
    yield* Effect.promise(() => fs.rm(`${releaseNew}.completed`, { force: true }))
  }),
)

it.instance("stop-chain token validation: fresh chain validates, old tokens never do", () =>
  Effect.gen(function* () {
    rewakeCalls.length = 0
    const hook = yield* SettingsHook.Service
    const hooks = yield* SessionHooks.Service
    const sessionID = SessionID.make("ses-cancel-fence")
    const releaseOld = tmp(`fence-old-${crypto.randomUUID()}`)
    const releaseNew = tmp(`fence-new-${crypto.randomUUID()}`)
    const cmd = (release: string, marker: string) =>
      `while [ ! -f ${JSON.stringify(release)} ]; do sleep 0.01; done; printf '%s' '{"systemMessage":"verdict"}'; touch ${JSON.stringify(marker)}`
    const addStopHook = (release: string, marker: string) =>
      hooks.add(sessionID, {
        event: "Stop",
        once: true,
        hooks: [{ type: "command", async: true, asyncRewake: true, command: cmd(release, marker) }],
      })
    yield* addStopHook(releaseOld, `${releaseOld}.completed`)
    yield* hook.trigger({ event: "Stop", stopHookActive: false }, { sessionID, transcriptPath: "" })
    if (hook.validateStopRewakeChain) {
      // A token that was never issued cannot match the live chain.
      expect(yield* hook.validateStopRewakeChain(sessionID, { stale: true })).toBe(false)
    }
    if (hook.invalidateStopRewakeChain) yield* hook.invalidateStopRewakeChain(sessionID)
    // A fresh Stop trigger issues a NEW chain; its callback carries that token.
    yield* addStopHook(releaseNew, `${releaseNew}.completed`)
    yield* hook.trigger({ event: "Stop", stopHookActive: false }, { sessionID, transcriptPath: "" })
    yield* Effect.promise(() => fs.writeFile(releaseNew, "go"))
    yield* pollWithTimeout(
      Effect.promise(async () => (rewakeCalls.length === 1 ? true : undefined)),
      "fresh chain callback never rewake",
    )
    const token = rewakeCalls[0].stopChain
    expect(token).toBeDefined()
    if (hook.validateStopRewakeChain && token !== undefined) {
      expect(yield* hook.validateStopRewakeChain(sessionID, token)).toBe(true)
      // Old-token identity can never validate against a newer chain.
      expect(yield* hook.validateStopRewakeChain(sessionID, { stale: true })).toBe(false)
      if (hook.invalidateStopRewakeChain) {
        yield* hook.invalidateStopRewakeChain(sessionID)
        expect(yield* hook.validateStopRewakeChain(sessionID, token)).toBe(false)
      }
    }
    yield* Effect.promise(() =>
      Promise.all([
        fs.rm(releaseOld, { force: true }),
        fs.rm(releaseNew, { force: true }),
        fs.rm(`${releaseOld}.completed`, { force: true }),
        fs.rm(`${releaseNew}.completed`, { force: true }),
      ]),
    )
  }),
)

it.instance("concurrent SubagentStop callbacks share the continuation budget", () =>
  Effect.gen(function* () {
    rewakeCalls.length = 0
    const hook = yield* SettingsHook.Service
    const hooks = yield* SessionHooks.Service
    const sessionID = SessionID.make("ses-subagent-stop-budget")
    const completed = tmp(`subagent-stop-budget-${crypto.randomUUID()}`)
    yield* hooks.add(sessionID, {
      event: "SubagentStop",
      hooks: [
        {
          type: "command",
          async: true,
          asyncRewake: true,
          command: `printf 'done\\n' >> ${JSON.stringify(completed)}; printf '%s' '{"systemMessage":"subagent verdict"}'`,
        },
      ],
    })
    const total = SettingsHook.MAX_STOP_CONTINUATIONS + 3
    yield* Effect.forEach(
      Array.from({ length: total }),
      () => hook.trigger({ event: "SubagentStop", stopHookActive: false }, { sessionID, transcriptPath: "" }),
      { concurrency: "unbounded" },
    )
    yield* pollWithTimeout(
      Effect.promise(async () => {
        try {
          return (await fs.readFile(completed, "utf8")).trim().split("\n").length === total ? true : undefined
        } catch {
          return undefined
        }
      }),
      "concurrent callbacks did not complete",
    )
    yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 100)))
    expect(rewakeCalls).toHaveLength(SettingsHook.MAX_STOP_CONTINUATIONS)
    yield* Effect.promise(() => fs.rm(completed))
  }),
)
