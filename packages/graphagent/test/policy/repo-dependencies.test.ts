import { describe, expect, it } from "bun:test"
import path from "node:path"

// CI-LOCK-02 gate — the lockfile is authoritative. This test STATICALLY validates repository
// configuration only; it performs NO install (no second install flow). It fails closed when:
//   1. any git/github dependency is pinned to a mutable ref (branch/tag) instead of a full 40-char
//      commit SHA; or
//   2. any `bun install` in CI (`.github/**/*.yml`) is not frozen.
// Mutations this gate must catch (turn Red): change a full SHA back to `#main`; drop
// `--frozen-lockfile` from any CI install command.

async function findRepoRoot(): Promise<string> {
  let dir = import.meta.dir
  for (let i = 0; i < 10; i++) {
    if (await Bun.file(path.join(dir, ".github", "actions", "setup-bun", "action.yml")).exists()) return dir
    dir = path.dirname(dir)
  }
  throw new Error("repo-policy gate: could not locate repo root (setup-bun action.yml not found walking up)")
}

const GIT_SPEC = /^(github:|git\+|git:|https:\/\/[^\s"]+\.git)/i
const FULL_SHA = /^[0-9a-f]{40}$/i
const DEP_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const

describe("repository dependency + install policy (CI-LOCK-02)", () => {
  it("every git dependency is pinned to a full immutable 40-char commit SHA", async () => {
    const root = await findRepoRoot()
    const manifests = await Array.fromAsync(
      new Bun.Glob("**/package.json").scan({ cwd: root, onlyFiles: true, dot: false }),
    ).then((files) => files.filter((rel) => !rel.includes("node_modules") && !rel.includes(".turbo") && !rel.includes("dist")))
    const offenders: string[] = []
    for (const rel of manifests) {
      const pkg = (await Bun.file(path.join(root, rel)).json().catch(() => null)) as
        | Record<string, unknown>
        | null
      if (!pkg || typeof pkg !== "object") continue
      for (const field of DEP_FIELDS) {
        const deps = pkg[field] as Record<string, unknown> | undefined
        if (!deps || typeof deps !== "object") continue
        for (const [name, raw] of Object.entries(deps)) {
          if (typeof raw !== "string" || !GIT_SPEC.test(raw)) continue
          const ref = raw.split("#")[1]
          if (!ref || !FULL_SHA.test(ref))
            offenders.push(`${rel} :: ${field}.${name} = "${raw}" — git deps must use #<full-40-char-SHA>, not a branch/tag`)
        }
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([])
  })

  it("every bun install in CI (.github/**/*.yml) is frozen", async () => {
    const root = await findRepoRoot()
    const ymls = await Array.fromAsync(
      // `.github` is dot-prefixed, so `dot: true` is required to descend into it.
      new Bun.Glob(".github/**/*.yml").scan({ cwd: root, onlyFiles: true, dot: true }),
    )
    expect(ymls.length, "expected .github yml files").toBeGreaterThan(0)
    let installCount = 0
    const offenders: string[] = []
    for (const rel of ymls) {
      const text = await Bun.file(path.join(root, rel)).text()
      for (const raw of text.split("\n")) {
        const trimmed = raw.trim()
        if (trimmed.startsWith("#")) continue // comment line, not an invocation
        // Strip a leading `run:` key so both inline (`run: bun install ...`) and block
        // (`run: |` + bare `bun install` on the next line) forms reduce to the command.
        const cmd = trimmed.replace(/^run:\s*/, "").trim()
        if (!/^bun\s+install\b/.test(cmd)) continue
        installCount++
        if (!/--frozen-lockfile/.test(cmd)) offenders.push(`${rel}: "${cmd}"`)
      }
    }
    expect(installCount, "expected at least one `bun install` under .github").toBeGreaterThan(0)
    expect(offenders, `unfrozen CI installs:\n${offenders.join("\n")}`).toEqual([])
  })
})
