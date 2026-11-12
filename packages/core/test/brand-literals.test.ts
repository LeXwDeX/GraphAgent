// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "fs/promises"
import os from "os"
import path from "path"

const REPO = path.resolve(import.meta.dir, "../../..")

const GUARDED_ROOTS = [
  "packages",
  "patches",
  "script",
  "nix",
  "config_assistant",
  "oc",
  ".github",
  ".azure-pipelines",
  // B3 (#1011) scans the root configuration, docs and guidance next to the
  // package trees so the workspace rename cannot regress outside packages/.
  "package.json",
  "turbo.json",
  "tsconfig.json",
  "flake.nix",
  ".gitignore",
  "NOTICE",
  "docs",
  "AGENTS.md",
  "CONTRIBUTING.md",
  "CONTEXT.md",
  "CONTEXT-MAP.md",
]
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", ".turbo", ".artifacts"])
const SKIP_PATHS = [".github/releases"]
// The guard lists the forbidden literals as regular expressions, so it must not
// scan itself.
const SKIP_FILES = ["packages/core/test/brand-literals.test.ts"]

type Allow = { file: string; reason: string }
type Category = { id: string; stage: number; pattern: RegExp; allow: Allow[] }

const OC_ASSET_ALLOW: Allow[] = [
  { file: "oc", reason: "G1 switches the installer asset names, install name and OC_VERSION atomically" },
  {
    file: "script/oc-install-boundary.test.sh",
    reason: "boundary tests pin the current installer asset names until G1",
  },
  {
    file: "script/oc-macos-acceptance.test.sh",
    reason: "macOS acceptance pins the current installer asset names until G1",
  },
]

const OC_BINARY_PATH_ALLOW: Allow[] = [
  {
    file: "script/oc-install-boundary.test.sh",
    reason: "boundary tests pin the current install path until G1",
  },
  {
    file: "script/oc-macos-acceptance.test.sh",
    reason: "macOS acceptance pins the current install path until G1",
  },
]

// Every entry below is a closed, itemised exception from #884. The four
// retired Claude Code / external-skills disable switches were deleted together
// with their readers by B5; the remaining entries are either the G0b photon
// patch key or negative tests proving a retired name is ignored.
const LEGACY_ENV_ALLOW: Allow[] = [
  {
    file: "packages/tui/test/i18n/brand-words.test.ts",
    reason: "fixtures that prove the TUI brand guard rejects a legacy environment name",
  },
  { file: "oc", reason: "G1 switches OC_OPENCODE_NAME together with the installer assets" },
  {
    file: "script/oc-install-boundary.test.sh",
    reason: "boundary tests pin OC_OPENCODE_NAME until G1",
  },
  {
    file: "script/oc-macos-acceptance.test.sh",
    reason: "macOS acceptance pins OC_OPENCODE_NAME until G1",
  },
  {
    file: "packages/graphagent/src/image/image.ts",
    reason: "G0b: the photon-node patch reads __OPENCODE_PHOTON_WASM_PATH",
  },
  {
    file: "patches/@silvia-odwyer%2Fphoton-node@0.3.4.patch",
    reason: "G0b: the patch defines __OPENCODE_PHOTON_WASM_PATH",
  },
  {
    file: "packages/graphagent/test/hook/workspace-trust.test.ts",
    reason: "negative test: the retired HOOKS_REQUIRE_TRUST name is ignored",
  },
  {
    file: "packages/graphagent/test/hook/scoped-frontmatter.test.ts",
    reason: "negative test: legacy trust values no longer filter hooks",
  },
  {
    file: "packages/core/test/flag.test.ts",
    reason: "negative test: proves the legacy OPENCODE_ variables are not read",
  },
  {
    file: "docs/continuation-2026-09-20/s09/scripts/live-pair-driver.ts",
    reason: "dated 2026-09-20 evidence bundle records the pre-rename live-pair driver environment",
  },
  {
    file: "docs/continuation-2026-09-20/s09/scripts/live-pair-driver.integration.test.ts",
    reason: "dated evidence bundle pins the pre-rename driver environment",
  },
]

const DATED_EVIDENCE_HEADER_ALLOW: Allow[] = [
  {
    file: "docs/continuation-2026-09-20/s09/scripts/live-pair-driver.ts",
    reason: "dated 2026-09-20 evidence bundle records the pre-rename request header",
  },
]

// #884 lands the rename in stages. A category only takes effect once its stage
// is reached, so every stage keeps the repository green while later surfaces
// still carry the upstream name.
const CATEGORIES: Category[] = [
  {
    id: "release-asset-name",
    stage: 1,
    pattern: /opencode-(linux|darwin|windows)-/,
    allow: OC_ASSET_ALLOW,
  },
  {
    id: "distribution-path",
    stage: 1,
    pattern: /dist\/opencode-|bin\/opencode\b/,
    allow: OC_BINARY_PATH_ALLOW,
  },
  {
    id: "packager-name",
    stage: 1,
    pattern: /opencode cli packager/,
    allow: [],
  },
  {
    id: "legacy-env-prefix",
    stage: 2,
    pattern: /OPENCODE_/,
    allow: LEGACY_ENV_ALLOW,
  },
  {
    id: "tui-mode-key",
    stage: 2,
    pattern: /opencode\.mode/,
    allow: [],
  },
  {
    id: "project-directory",
    stage: 3,
    pattern: /\.opencode[\/\\"'`]/,
    allow: [
      {
        file: "packages/graphagent/src/ide/index.ts",
        reason: "upstream IDE extension identity; B5 removes the IDE bridge",
      },
    ],
  },
  {
    id: "config-file-name",
    stage: 3,
    pattern: /opencode\.jsonc?/,
    allow: [],
  },
  {
    id: "database-log-name",
    stage: 3,
    pattern: /opencode\.(db|log)/,
    allow: [],
  },
  {
    id: "remote-config-path",
    stage: 3,
    pattern: /\.well-known\/opencode/,
    allow: [],
  },
  {
    id: "internal-domain",
    stage: 3,
    pattern: /opencode\.internal/,
    allow: [],
  },
  {
    id: "tui-persisted-key",
    stage: 3,
    pattern: /opencode\.(default|status)/,
    allow: [],
  },
  {
    id: "temp-identity",
    stage: 3,
    pattern: /opencode-(jdtls|oauth|debug|tmux)/,
    allow: [],
  },
  {
    id: "global-app-directory",
    stage: 3,
    pattern:
      /\.config[\/\\]opencode\b|\.local[\/\\](share|state)[\/\\]opencode\b|\.cache[\/\\]opencode\b|~\/\.opencode\b/,
    allow: [],
  },
  {
    id: "legacy-cli-spawn",
    stage: 3,
    pattern: /(?:Process\.(?:spawn|text|run)|Bun\.spawn)\(\["opencode"/,
    allow: [],
  },
  {
    id: "internal-request-header",
    stage: 4,
    pattern: /x-opencode-/,
    allow: DATED_EVIDENCE_HEADER_ALLOW,
  },
  {
    id: "user-agent-product",
    stage: 4,
    pattern: /opencode\/\$\{Installation/,
    allow: [],
  },
  {
    id: "attribution-header",
    stage: 4,
    pattern: /(?:X-Title|HTTP-Referer|X-Source|X-Cerebras-3rd-Party-Integration)[^\n]*["'`]?opencode(?:\.ai\/)?["'`]/,
    allow: [],
  },
  {
    id: "telemetry-identity",
    stage: 4,
    pattern: /["'`]opencode\.(?:client|run)\b/,
    allow: [],
  },
  {
    id: "metadata-namespace",
    stage: 4,
    pattern:
      /(?:providerMetadata|providerOptions)\.opencode\b|\bopencode\.(?:synthetic|context|cache|suppressedActivity|failedAttempt|thinkingReplay)\b/,
    allow: [],
  },
  // B3 (#1011): workspace scope, directory, service-ID and identifier rename.
  // Each category is exact enough to name the surface it guards; the identifier
  // category carries the closed PENDING_C1 exception inline so C1 can delete
  // the lookahead when it renames the SDK client symbols.
  {
    id: "package-scope",
    stage: 2,
    pattern: /@opencode-ai\//,
    allow: [],
  },
  {
    id: "service-id",
    stage: 2,
    pattern: /@opencode\//,
    allow: [],
  },
  {
    id: "reference-key",
    stage: 2,
    pattern: /~opencode\//,
    allow: [],
  },
  {
    id: "project-directory",
    stage: 2,
    pattern: /packages[\/\\]opencode\b/,
    allow: [],
  },
  {
    id: "nix-file",
    stage: 2,
    pattern: /nix[\/\\]opencode\b/,
    allow: [],
  },
  {
    id: "ci-job-name",
    stage: 2,
    pattern: /unit_opencode|UNIT_RESULT_OPENCODE/,
    allow: [],
  },
  {
    id: "package-name-literal",
    stage: 2,
    pattern: /"name"\s*:\s*"opencode"/,
    allow: [],
  },
  {
    id: "nix-node-modules-name",
    stage: 2,
    pattern: /opencode-node_modules/,
    allow: [],
  },
  {
    id: "lowercase-identifier",
    stage: 2,
    pattern: /\bopencode[A-Z][A-Za-z]*\b/,
    allow: [],
  },
  {
    id: "code-identifier",
    stage: 2,
    pattern: /\b[A-Za-z]*Opencode[A-Za-z]*\b/,
    allow: [],
  },
  {
    id: "uppercase-identifier",
    stage: 2,
    // Identifier shape only: the standalone product word "OpenCode" is B4 copy.
    pattern: /OpenCode[A-Za-z]+/,
    allow: [],
  },
]

const CURRENT_STAGE = 4

type Hit = { category: string; file: string; line: number; text: string }

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function active() {
  return CATEGORIES.filter((category) => category.stage <= CURRENT_STAGE)
}

function relative(file: string) {
  return path.relative(REPO, file).replaceAll("\\", "/")
}

describe("brand literals", () => {
  test("legacy build names are confined to the G1 installer allowlist", async () => {
    const missing: string[] = []
    for (const root of GUARDED_ROOTS) {
      try {
        await stat(path.join(REPO, root))
      } catch {
        missing.push(root)
      }
    }
    expect(missing).toEqual([])
    const files = await listFiles(GUARDED_ROOTS.map((root) => path.join(REPO, root)))
    expect(files).toContain(path.join(REPO, "packages/core/test/brand-literals.test.ts"))
    expect(files.length).toBeGreaterThan(1000)

    const violations = (await scan(files, active()))
      .filter((hit) => !SKIP_FILES.includes(relative(hit.file)))
      .filter((hit) => !allowlist(hit.category).some((entry) => entry.file === relative(hit.file)))
      .map((hit) => `[${hit.category}] ${relative(hit.file)}:${hit.line}: ${hit.text}`)
      .sort()

    expect(violations).toEqual([])
  })

  test("the allowlist stays justified and needed", async () => {
    for (const category of active()) {
      for (const entry of category.allow) {
        expect(entry.reason.length).toBeGreaterThan(0)
        const file = path.join(REPO, entry.file)
        expect(await Bun.file(file).exists()).toBe(true)
        const hits = await scan([file], [category])
        expect({ category: category.id, file: entry.file, needed: hits.length > 0 }).toEqual({
          category: category.id,
          file: entry.file,
          needed: true,
        })
      }
    }
  })

  test("the scan detects a planted violation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "brand-literals-"))
    roots.push(root)
    await mkdir(path.join(root, "script"), { recursive: true })
    await writeFile(
      path.join(root, "script", "build.ts"),
      'const out = "dist/opencode-linux-x64/bin/graphagent"\nconst rel = "bin/opencode"\nconst legacy = process.env.OPENCODE_CONFIG\nconst mode = "opencode.mode"\nconst header = "x-opencode-directory"\nconst ua = `opencode/${InstallationVersion}`\nconst meta = "providerMetadata.opencode"\nconst svc = "opencode.client"\nconst title = { "X-Title": "opencode" }\n',
    )

    const hits = await scan(await listFiles([root]), active())
    expect(hits.map((hit) => hit.category)).toContain("release-asset-name")
    expect(hits.map((hit) => hit.category)).toContain("distribution-path")
    expect(hits.map((hit) => hit.category)).toContain("legacy-env-prefix")
    expect(hits.map((hit) => hit.category)).toContain("tui-mode-key")
    expect(hits.map((hit) => hit.category)).toContain("internal-request-header")
    expect(hits.map((hit) => hit.category)).toContain("user-agent-product")
    expect(hits.map((hit) => hit.category)).toContain("metadata-namespace")
    expect(hits.map((hit) => hit.category)).toContain("telemetry-identity")
    expect(hits.map((hit) => hit.category)).toContain("attribution-header")
    // `providerMetadata.opencode"` also matches the stage-3 project-directory
    // category (`\.opencode[\/\\"'`]`), so line 7 is reported twice.
    expect(hits.map((hit) => hit.line).sort((a, b) => a - b)).toEqual([1, 1, 2, 3, 4, 5, 6, 7, 7, 8, 9])
  })

  test("the second-stage rename categories detect planted violations", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "brand-literals-"))
    roots.push(root)
    await mkdir(path.join(root, "packages", "example", "src"), { recursive: true })
    await writeFile(
      path.join(root, "packages", "example", "src", "index.ts"),
      [
        'const scope = "@opencode-ai/core"',
        'const service = "@opencode/v2/Catalog"',
        'const ref = "~opencode/Instance"',
        'const dir = "packages/opencode/src"',
        'const nix = "nix/opencode.nix"',
        'const job = "unit_opencode_1"',
        'const result = "UNIT_RESULT_OPENCODE_1"',
        'const name = `"name": "opencode"`',
        'const pname = "opencode-node_modules"',
        "const lower = opencodeGlobal",
        "const upper = OpenCodeHttpApi",
        "const plugin = OpencodeKeymapProvider",
        "const prose = 'OpenCode is a product word'",
      ].join("\n"),
    )

    const hits = await scan(await listFiles([root]), active())
    const categories = new Set(hits.map((hit) => hit.category))
    for (const id of [
      "package-scope",
      "service-id",
      "reference-key",
      "project-directory",
      "nix-file",
      "ci-job-name",
      "package-name-literal",
      "nix-node-modules-name",
      "lowercase-identifier",
      "uppercase-identifier",
      "code-identifier",
    ]) {
      expect({ category: id, detected: categories.has(id) }).toEqual({ category: id, detected: true })
    }
    // The standalone OpenCode word stays unflagged.
    expect(hits.filter((hit) => /product word/.test(hit.text))).toEqual([])
  })

  test("the scan skips immutable release notes and dependency directories", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "brand-literals-"))
    roots.push(root)
    await mkdir(path.join(root, ".github", "releases"), { recursive: true })
    await mkdir(path.join(root, "packages", "example", "node_modules"), { recursive: true })
    await writeFile(path.join(root, ".github", "releases", "v1.0.69.md"), "installed over /usr/local/bin/opencode\n")
    await writeFile(path.join(root, "packages", "example", "node_modules", "index.js"), "dist/opencode-linux-x64\n")

    expect(await scan(await listFiles([root]), active())).toEqual([])
  })
})

function allowlist(category: string) {
  return CATEGORIES.find((entry) => entry.id === category)?.allow ?? []
}

async function listFiles(input: string[]): Promise<string[]> {
  const files: string[] = []
  for (const root of input) {
    const info = await stat(root)
    if (info.isFile()) {
      files.push(root)
      continue
    }
    await walk(root, root, files)
  }
  return files.sort()
}

async function walk(root: string, dir: string, files: string[]) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      const normalized = full.replaceAll("\\", "/")
      if (SKIP_PATHS.some((skipped) => normalized.endsWith(`/${skipped}`) || normalized.includes(`/${skipped}/`)))
        continue
      await walk(root, full, files)
    } else if (entry.isFile()) {
      files.push(full)
    }
  }
}

async function scan(files: string[], categories: Category[]): Promise<Hit[]> {
  const hits: Hit[] = []
  for (const file of files) {
    const lines = (await Bun.file(file).text()).split("\n")
    for (const category of categories) {
      for (const [index, line] of lines.entries()) {
        if (category.pattern.test(line)) hits.push({ category: category.id, file, line: index + 1, text: line.trim() })
      }
    }
  }
  return hits
}
