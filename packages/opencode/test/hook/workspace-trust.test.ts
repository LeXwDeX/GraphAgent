import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import * as fs from "fs"
import * as os from "os"
import path from "path"
import { SettingsHook } from "@/hook/settings"
import { SessionHooks } from "@/hook/session-hooks"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Database } from "@opencode-ai/core/database/database"
import { dispatchTrust, isTrusted, isTrustedDir, loadTrustedList } from "@/hook/workspace-trust"
import { testEffect } from "../lib/effect"

// WP-6B workspace-trust gate. Two layers of tests:
//  - pure predicate + file-IO degradation (no Global.Path dependency)
//  - real SettingsHook trigger integration (enforcement on/off, allowUntrusted)

describe("isTrustedDir — path-segment-boundary matching", () => {
  test("exact match → trusted", () => {
    expect(isTrustedDir("/home/u/proj", ["/home/u/proj"])).toBe(true)
  })
  test("subdirectory inherits trust", () => {
    expect(isTrustedDir("/home/u/proj/packages/a", ["/home/u/proj"])).toBe(true)
  })
  test("same-prefix sibling does NOT piggyback (/proj-evil vs /proj)", () => {
    expect(isTrustedDir("/home/u/proj-evil", ["/home/u/proj"])).toBe(false)
  })
  test("empty trust list → untrusted", () => {
    expect(isTrustedDir("/any/dir", [])).toBe(false)
  })
  test("multiple entries — any match trusts", () => {
    expect(isTrustedDir("/opt/other", ["/home/u/proj", "/opt"])).toBe(true)
  })
})

describe("loadTrustedList — file degradation", () => {
  const tmp = () => path.join(os.tmpdir(), `opencode-trust-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)

  test("missing file → empty list (no throw)", () => {
    expect(loadTrustedList(tmp())).toEqual([])
  })
  test("invalid JSON → empty list (no throw)", () => {
    const f = tmp()
    fs.writeFileSync(f, "{not valid json")
    expect(loadTrustedList(f)).toEqual([])
  })
  test("non-array payload → empty list", () => {
    const f = tmp()
    fs.writeFileSync(f, JSON.stringify({ not: "an array" }))
    expect(loadTrustedList(f)).toEqual([])
  })
  test("valid string array → returned, non-string entries dropped", () => {
    const f = tmp()
    fs.writeFileSync(f, JSON.stringify(["/a", "/b", 3, null, { x: 1 }]))
    expect(loadTrustedList(f)).toEqual(["/a", "/b"])
  })
})

// ── trigger integration: the cwd (s.cwd) is the per-test instance tmpdir,
// which is never on the real trust list, so the default gate → untrusted →
// settings-file hooks are skipped. No need to touch Global.Path.data.
// The suite preload disables the gate with OPENCODE_HOOKS_REQUIRE_TRUST=0 so
// unrelated hook tests keep working; each test here selects the gate state it
// exercises and afterEach restores the preload value.

const testLayer = SettingsHook.layer.pipe(
  Layer.provide(EventV2Bridge.defaultLayer),
  Layer.provide(Database.defaultLayer),
  Layer.provideMerge(SessionHooks.defaultLayer),
)
const trustIt = testEffect(testLayer)

const CONTEXT = "trust-gate-hook-fired"

const writeHooks = (json: unknown) => (dir: string) =>
  Effect.promise(() =>
    fs.promises.mkdir(path.join(dir, ".opencode"), { recursive: true }).then(() =>
      fs.promises.writeFile(path.join(dir, ".opencode", "hooks.json"), JSON.stringify(json)),
    ),
  )

const sessionStartHook = (extra: Record<string, unknown>) => ({
  ...extra,
  SessionStart: [{ hooks: [{ type: "command", command: `printf '%s' '${CONTEXT}'` }] }],
})

describe("SettingsHook workspace-trust gate (WP-6B)", () => {
  afterEach(() => {
    // Restore the suite preload default (see test/preload.ts).
    process.env.OPENCODE_HOOKS_REQUIRE_TRUST = "0"
  })

  trustIt.instance(
    "explicit requireTrust:true + untrusted cwd → hooks silently skipped (empty result)",
    () =>
      Effect.gen(function* () {
        process.env.OPENCODE_HOOKS_REQUIRE_TRUST = "1"
        const hook = yield* SettingsHook.Service
        const r = yield* hook.trigger(
          { event: "SessionStart", source: "startup" },
          { sessionID: "ses-trust-skip", transcriptPath: "" },
        )
        // Hook command never ran → no context injected.
        expect(r.additionalContexts).toEqual([])
        expect(r.blocked).toBeUndefined()
      }),
    { init: writeHooks(sessionStartHook({ requireTrust: true })) },
  )

  trustIt.instance(
    "untrusted cwd → gate is ON by default, hooks skipped without any requireTrust key",
    () =>
      Effect.gen(function* () {
        delete process.env.OPENCODE_HOOKS_REQUIRE_TRUST
        const hook = yield* SettingsHook.Service
        const r = yield* hook.trigger(
          { event: "SessionStart", source: "startup" },
          { sessionID: "ses-trust-default", transcriptPath: "" },
        )
        expect(r.additionalContexts).toEqual([])
        expect(r.blocked).toBeUndefined()
      }),
    { init: writeHooks(sessionStartHook({})) },
  )

  trustIt.instance(
    "explicit requireTrust:true + project-layer allowUntrusted:true → still skipped (no self-escape)",
    () =>
      Effect.gen(function* () {
        process.env.OPENCODE_HOOKS_REQUIRE_TRUST = "1"
        const hook = yield* SettingsHook.Service
        const r = yield* hook.trigger(
          { event: "SessionStart", source: "startup" },
          { sessionID: "ses-trust-allow", transcriptPath: "" },
        )
        // The project .opencode/hooks.json is authored by the untrusted repo
        // itself — its allowUntrusted opt-out is stripped by readChain, so the
        // gate still silently skips all hooks.
        expect(r.additionalContexts).toEqual([])
        expect(r.blocked).toBeUndefined()
      }),
    { init: writeHooks(sessionStartHook({ requireTrust: true, allowUntrusted: true })) },
  )

  trustIt.instance(
    "OPENCODE_HOOKS_REQUIRE_TRUST=0 → gate disabled, hooks execute",
    () =>
      Effect.gen(function* () {
        process.env.OPENCODE_HOOKS_REQUIRE_TRUST = "0"
        const hook = yield* SettingsHook.Service
        const r = yield* hook.trigger(
          { event: "SessionStart", source: "startup" },
          { sessionID: "ses-trust-off", transcriptPath: "" },
        )
        expect(r.additionalContexts).toEqual([CONTEXT])
      }),
    { init: writeHooks(sessionStartHook({})) },
  )
})

// ── /trust command dispatch (D3) ───────────────────────────────────
// dispatchTrust takes an optional trust-file param (defaulting to the real
// trustFilePath()), so every test here points it at an isolated temp file —
// no save/restore of the real `<Global.Path.data>/trusted-workspaces.json`
// needed. Gate-source assertions target the deterministic paths (env var and
// the project hooks.json we write) rather than the global hooks.json, which
// this machine may or may not have set.

describe("dispatchTrust (/trust command) — D3", () => {
  beforeEach(() => {
    delete process.env.OPENCODE_HOOKS_REQUIRE_TRUST
  })

  const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), "trust-cmd-"))
  const tmpTrustFile = () => path.join(tmpdir(), "trusted-workspaces.json")

  test("/trust 追加目录到信任列表（含目录路径）", () => {
    const dir = tmpdir()
    const file = tmpTrustFile()
    const r = dispatchTrust(dir, "", undefined, file)
    expect(r.text).toContain(dir)
    expect(isTrusted(dir, file)).toBe(true)
  })

  test("/trust 幂等（重复不重复追加）", () => {
    const dir = tmpdir()
    const file = tmpTrustFile()
    dispatchTrust(dir, "", undefined, file)
    dispatchTrust(dir, "", undefined, file)
    // exactly one entry for dir
    expect(loadTrustedList(file).filter((d) => d === dir).length).toBe(1)
    // confirmation text notes already-trusted
    expect(dispatchTrust(dir, "", undefined, file).text).toContain("已在信任列表")
  })

  test("/trust status 显示信任判定 + 信任文件路径", () => {
    const dir = tmpdir()
    const file = tmpTrustFile()
    const r = dispatchTrust(dir, "status", undefined, file)
    expect(r.text).toContain("未信任")
    expect(r.text).toContain(file)
    expect(r.text).toContain("requireTrust 门禁")
    // No env / hooks.json override → the gate defaults ON.
    expect(r.text).toContain("已启用")
    expect(r.text).toContain("默认")
  })

  test("/trust status — hooks.json requireTrust 来源", () => {
    const dir = tmpdir()
    fs.mkdirSync(path.join(dir, ".opencode"), { recursive: true })
    fs.writeFileSync(path.join(dir, ".opencode", "hooks.json"), JSON.stringify({ requireTrust: true }))
    const r = dispatchTrust(dir, "status", undefined, tmpTrustFile())
    expect(r.text).toContain("hooks.json requireTrust")
  })

  test("/trust status — OPENCODE_HOOKS_REQUIRE_TRUST 来源", () => {
    const dir = tmpdir()
    process.env.OPENCODE_HOOKS_REQUIRE_TRUST = "1"
    try {
      const r = dispatchTrust(dir, "status", undefined, tmpTrustFile())
      expect(r.text).toContain("OPENCODE_HOOKS_REQUIRE_TRUST=1")
    } finally {
      delete process.env.OPENCODE_HOOKS_REQUIRE_TRUST
    }
  })

  test("/trust 写入失败 → 不 throw 且回显失败信息（含信任文件路径）", () => {
    const dir = tmpdir()
    // Force the write to fail: a DIRECTORY sits where the trust file should
    // be, so addTrusted's writeFileSync hits EISDIR and swallows it
    // (never-throw). dispatchTrust must detect the entry never landed and
    // echo a failure instead of a false success.
    const file = path.join(tmpdir(), "trusted-workspaces.json")
    fs.mkdirSync(file, { recursive: true })
    const r = dispatchTrust(dir, "", undefined, file)
    expect(r.text).toContain("失败")
    expect(r.text).toContain(file)
    expect(r.text).not.toContain("已将")
    expect(isTrusted(dir, file)).toBe(false)
  })

  test("/trust 写入成功时文案不受失败分支影响", () => {
    const dir = tmpdir()
    const file = tmpTrustFile()
    const r = dispatchTrust(dir, "", undefined, file)
    expect(r.text).toContain("已将")
    expect(r.text).not.toContain("失败")
  })
})
