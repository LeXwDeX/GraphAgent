import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { globSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { readToolchain, assertRuntimeVersions, resolveDependencyVersion } from "./toolchain.mjs"

const root = fileURLToPath(new URL("../", import.meta.url))
const read = (path) => readFileSync(join(root, path), "utf8")

void test("Turbo schedules every workspace that declares a test script", () => {
  const pkg = JSON.parse(read("package.json"))
  const turbo = JSON.parse(read("turbo.json"))
  const manifests = globSync(
    pkg.workspaces.packages.map((pattern) => `${pattern}/package.json`),
    { cwd: root },
  )
  const missing = manifests
    .map((path) => JSON.parse(read(path)))
    .filter((pkg) => pkg.scripts?.test && !turbo.tasks[`${pkg.name}#test`] && !turbo.tasks.test)
    .map((pkg) => pkg.name)
  assert.deepEqual(missing, [], `CI omits workspace test scripts: ${missing.join(", ")}`)
})

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "opencode-toolchain-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  mkdirSync(join(dir, "config_assistant"))
  mkdirSync(join(dir, "packages/containers"), { recursive: true })
  const pkg = {
    packageManager: "bun@1.4.2",
    devDependencies: { turbo: "catalog:" },
    workspaces: { catalog: { turbo: "2.11.5" } },
  }
  const writePackage = () => writeFileSync(join(dir, "package.json"), JSON.stringify(pkg))
  writePackage()
  writeFileSync(join(dir, ".node-version"), "24.21.0\n")
  writeFileSync(join(dir, "config_assistant/go.mod"), "module example.com/test\n\ngo 1.27.1\n")
  writeFileSync(join(dir, "packages/containers/rust-toolchain.toml"), '[toolchain]\nchannel = "1.98.1"\n')
  return { dir, pkg, writePackage }
}

void test("central versions resolve exact pins, including catalog Turbo", (t) => {
  const { dir } = fixture(t)
  assert.deepEqual(readToolchain(dir), { bun: "1.4.2", node: "24.21.0", go: "1.27.1", turbo: "2.11.5", rust: "1.98.1" })
})

void test("build dependency versions resolve default and named catalogs without changing declarations", (t) => {
  const { dir, pkg, writePackage } = fixture(t)
  pkg.workspaces.catalogs = { native: { "@opentui/core": "0.5.12" } }
  writePackage()
  assert.equal(resolveDependencyVersion("turbo", "catalog:", dir), "2.11.5")
  assert.equal(resolveDependencyVersion("@opentui/core", "catalog:native", dir), "0.5.12")
  assert.equal(resolveDependencyVersion("@parcel/watcher", "2.5.6", dir), "2.5.6")
  assert.throws(() => resolveDependencyVersion("missing", "catalog:", dir), /exact/)
  assert.throws(() => resolveDependencyVersion("turbo", "^2.11.5", dir), /exact/)
  assert.equal(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).devDependencies.turbo, "catalog:")
})

void test("central pins reject floating ranges and conflicting Go toolchain directives", (t) => {
  const { dir, pkg, writePackage } = fixture(t)
  pkg.packageManager = "bun@^1.4.2"
  writePackage()
  assert.throws(() => readToolchain(dir), /exact/)
  pkg.packageManager = "bun@1.4.2"
  writePackage()
  writeFileSync(join(dir, ".node-version"), "24\n")
  assert.throws(() => readToolchain(dir), /exact/)
  writeFileSync(join(dir, ".node-version"), "24.21.0\n")
  writeFileSync(join(dir, "config_assistant/go.mod"), "module example.com/test\ngo 1.27.1\ntoolchain go1.27.2\n")
  assert.throws(() => readToolchain(dir), /toolchain/)
  writeFileSync(join(dir, "config_assistant/go.mod"), "module example.com/test\ngo 1.27.1\n")
  writeFileSync(join(dir, "packages/containers/rust-toolchain.toml"), '[toolchain]\nchannel = "stable"\n')
  assert.throws(() => readToolchain(dir), /exact/)
})

void test("runtime validation rejects another patch and reports every mismatch", () => {
  const expected = { bun: "1.4.2", node: "24.21.0", go: "1.27.1", rust: "1.98.1" }
  assert.doesNotThrow(() => assertRuntimeVersions(expected, expected))
  assert.throws(() => assertRuntimeVersions(expected, { bun: "1.4.3" }), /bun@1\.4\.2.*bun@1\.4\.3/)
  assert.throws(
    () => assertRuntimeVersions(expected, { node: "24.21.1", go: "1.27.2" }),
    (error) => {
      assert.match(error.message, /node@24\.21\.0.*node@24\.21\.1/)
      assert.match(error.message, /go@1\.27\.1.*go@1\.27\.2/)
      return true
    },
  )
  assert.throws(() => assertRuntimeVersions(expected, { bun: undefined }), /bun.*unavailable/)
  assert.throws(() => assertRuntimeVersions(expected, { rust: "1.98.2" }), /rust@1\.98\.1.*rust@1\.98\.2/)
})

void test("CLI reads the same central versions from a different working directory", () => {
  const actual = execFileSync(process.execPath, [join(root, "script/toolchain.mjs"), "get", "node"], {
    cwd: tmpdir(),
    encoding: "utf8",
  }).trim()
  assert.equal(actual, readToolchain(root).node)
})

void test("Nix's copied source includes every shared policy input and the GitHub workspace", (t) => {
  const source = read("nix/node_modules.nix")
  const fileset = source.match(/lib\.fileset\.unions \[([\s\S]*?)\]/)?.[1]
  assert.ok(fileset)
  const entries = [...fileset.matchAll(/\.\.\/([A-Za-z0-9_./-]+)/g)].map((match) => match[1])
  const dir = mkdtempSync(join(tmpdir(), "opencode-nix-source-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  for (const path of [
    "script/toolchain.mjs",
    "package.json",
    ".node-version",
    "config_assistant/go.mod",
    "packages/containers/rust-toolchain.toml",
    "github/package.json",
    "bun.lock",
  ]) {
    assert.ok(
      entries.some((entry) => path === entry || path.startsWith(`${entry}/`)),
      `Nix source omits ${path}`,
    )
    mkdirSync(join(dir, path, ".."), { recursive: true })
    writeFileSync(join(dir, path), read(path))
  }
  const actual = execFileSync(process.execPath, [join(dir, "script/toolchain.mjs"), "get", "node"], {
    cwd: tmpdir(),
    encoding: "utf8",
  }).trim()
  assert.equal(actual, readToolchain(root).node)
  for (const path of ["nix/node_modules.nix", "nix/opencode.nix", "nix/desktop.nix"]) {
    const derivation = read(path)
    assert.match(derivation, /toolchain\.requireVersion "bun" bun/)
    assert.match(derivation, /toolchain\.requireVersion "node" nodejs_24/)
    assert.match(derivation, /node script\/toolchain\.mjs check/)
    assert.doesNotMatch(derivation, /Relax Bun version|expectedBunVersionRange/)
  }
  assert.doesNotMatch(read("flake.nix"), /nodejs_20/)
})

void test("CI installs the central Node pin before evidence or repository scripts", () => {
  const nodeAction = read(".github/actions/setup-node/action.yml")
  assert.match(nodeAction, /uses: actions\/setup-node@[a-f0-9]{40}/)
  assert.match(nodeAction, /node-version-file: \.node-version/)
  assert.doesNotMatch(nodeAction, /\bnode-version:/)
  for (const path of [".github/workflows/ci-test.yml", ".github/workflows/ci-typecheck.yml"]) {
    const workflow = read(path)
    assert.doesNotMatch(workflow, /uses: actions\/setup-node|\bnode-version:/)
    const jobs = workflow.split(/\n    steps:\n/).slice(1)
    assert.ok(jobs.length > 0)
    for (const job of jobs) {
      // Jobs without a checkout (the unit aggregate) run no repository scripts.
      if (!job.includes("uses: actions/checkout@")) continue
      const steps = job.split(/\n      - name: /).slice(1)
      const node = steps.findIndex((step) => step.includes("uses: ./.github/actions/setup-node"))
      const evidence = steps.findIndex((step) => step.includes("uses: ./.github/actions/verified-content"))
      assert.ok(node >= 0 && node < evidence, path)
      assert.doesNotMatch(steps[node], /\n        if:/)
    }
  }
  const bunAction = read(".github/actions/setup-bun/action.yml")
  assert.match(bunAction, /uses: \.\/\.github\/actions\/setup-node/)
  assert.match(bunAction, /node script\/toolchain\.mjs check/)
  assert.match(bunAction, /bun install --frozen-lockfile/)
})
