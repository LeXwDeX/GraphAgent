import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

const workflow = (name) => readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), "utf8")
const repositoryFile = (name) => readFileSync(new URL(`../${name}`, import.meta.url), "utf8")

const namedSteps = (source, name) => {
  const marker = `      - name: ${name}\n`
  const steps = []
  let start = source.indexOf(marker)
  while (start !== -1) {
    const next = source.indexOf("\n      - name: ", start + marker.length)
    steps.push(source.slice(start, next === -1 ? source.length : next))
    start = source.indexOf(marker, start + marker.length)
  }
  return steps
}

// The aggregate "Unit Tests (linux)" job only reads its needs' results; it has
// no checkout or evidence of its own.
const aggregate = (file) => file.slice(file.indexOf("\n  unit-tests:"), file.indexOf("\n  e2e-tests:"))

await test("active CI routes use GitHub-hosted runners and evidence labels", () => {
  for (const file of ["ci-typecheck.yml", "ci-test.yml"]) {
    const lines = workflow(file).split("\n")
    const routes = lines.filter((line) => line.trimStart().startsWith("runs-on:"))
    const labels = lines.filter((line) => line.trimStart().startsWith("runner-label:"))
    const aggregates = file === "ci-test.yml" ? 1 : 0
    assert.equal(labels.length, routes.length - aggregates, `${file}: one evidence label per verifying route`)
    assert(!lines.some((line) => line.includes("self-hosted")), `${file}: self-hosted route remains`)
    assert(!lines.some((line) => line.includes("TRUSTED")), `${file}: trusted-event routing remains`)
  }
})

await test("the typecheck job and evidence check use the same hosted Linux label", () => {
  const typecheck = workflow("ci-typecheck.yml")
  assert(typecheck.includes("runs-on: ubuntu-latest"), "typecheck hosted route")
  assert(typecheck.includes("runner-label: ubuntu-latest"), "typecheck evidence label")
})

await test("the test matrix keeps names and OS keys while routing to its hosted label", () => {
  const file = workflow("ci-test.yml")
  assert(file.includes("runs-on: \${{ matrix.settings.host }}"))
  for (const line of [
    "runner-label: \${{ matrix.settings.host }}",
    "host: ubuntu-latest",
    "host: windows-latest",
    "name: Unit Tests (linux)",
    "name: E2E Tests (${{ matrix.settings.name }})",
  ])
    assert(file.includes(line), line)
  assert(!file.includes("selfHosted:"), "self-hosted matrix labels remain")
})

await test("every main PR runs the full Linux unit and Linux/Windows E2E gates", () => {
  for (const name of ["ci-typecheck.yml", "ci-test.yml"]) {
    const file = workflow(name)
    const triggers = file.slice(file.indexOf("\non:\n"), file.indexOf("\npermissions:\n"))
    assert.match(triggers, /pull_request:[\s\S]*?branches:\n      - main(?:\n|$)/, `${name}: main PR trigger`)
    assert.match(triggers, /push:[\s\S]*?branches:\n      - main(?:\n|$)/, `${name}: main push trigger`)
    assert(!triggers.includes("      - dev"), `${name}: retired dev trigger remains`)
  }

  const file = workflow("ci-test.yml")
  const unit = file.slice(file.indexOf("\n  unit-workspace:"), file.indexOf("\n  e2e-tests:"))
  const e2e = file.slice(file.indexOf("\n  e2e-tests:"))
  for (const step of [
    "GITHUB_ACTIONS=false bun turbo test --concurrency=1 --filter='!opencode'",
    "go test ./...",
    "shard: [1, 2, 3, 4]",
    "--shard=${{ matrix.shard }}/4 --timings=test/ci-timings.json",
    "bun run test:httpapi:ci",
  ])
    assert(unit.includes(step), `unit gate: ${step}`)
  for (const job of ["unit-workspace", "unit-opencode", "unit-httpapi"]) {
    const header = file.slice(file.indexOf(`\n  ${job}:`)).split("\n    steps:")[0]
    assert(!/^    if:/m.test(header), `${job} must run on every triggered event`)
  }

  const required = aggregate(file)
  assert(required.includes("name: Unit Tests (linux)"), "Linux unit status check")
  assert(required.includes("needs: [unit-workspace, unit-opencode, unit-httpapi]"), "aggregate covers every unit gate")
  assert(required.includes("if: always()"), "aggregate reports failed or cancelled gates")
  assert(required.includes('if [ "$result" != "success" ]; then'), "aggregate requires success")
  assert(required.includes('if [ "$count" -ne 3 ]; then'), "aggregate requires every result")
  assert(!required.includes("actions/checkout"), "aggregate must not check out repository code")
  assert(!/^    if:/m.test(e2e.slice(0, e2e.indexOf("    strategy:"))), "E2E job must run on every triggered PR")
  for (const name of ["linux", "windows"]) assert(e2e.includes(`- name: ${name}\n`), `${name} E2E matrix entry`)
  assert(e2e.includes("run: bun --cwd packages/app test:e2e:local"), "Playwright E2E gate")
})

await test("hosted Linux jobs install missing prerequisites and Playwright dependencies", () => {
  const file = workflow("ci-test.yml")
  const ripgrep = repositoryFile(".github/actions/setup-ripgrep/action.yml")
  assert(ripgrep.includes("if command -v rg >/dev/null 2>&1; then"), "ripgrep prerequisite check")
  assert(ripgrep.includes("sudo apt-get update && sudo apt-get install -y ripgrep"), "hosted ripgrep install")
  assert.equal(file.split("uses: ./.github/actions/setup-ripgrep").length - 1, 3, "every Linux unit gate has ripgrep")
  assert(!file.includes("RUNNER_ENVIRONMENT"), "self-hosted prerequisite branch remains")
  assert(
    file.includes("steps.evidence.outputs.reused != 'true' && (runner.os == 'Linux')"),
    "Linux Playwright dependencies are installed",
  )
  assert(!file.includes("runner.environment == 'self-hosted'"), "self-hosted Chromium check remains")
})

await test("manual release routes every platform to GitHub-hosted runners", () => {
  const file = workflow("release-fork.yml")

  assert(!file.includes("pull_request:"), "release workflow must not accept pull request code")
  assert(file.includes("if: github.event_name == 'workflow_dispatch'"), "release work is not dispatch-gated")
  assert(file.includes("runner: ubuntu-latest"), "Linux build route")
  assert(file.includes("runner: windows-latest"), "Windows build route")
  assert(file.includes("runner: macos-latest"), "macOS build route")
  assert.equal(file.split("runs-on: ubuntu-latest").length - 1, 5, "Linux jobs use hosted runners")
  assert(!file.includes("self-hosted"), "self-hosted release route remains")
})

await test("manual releases reject non-main refs and publish stable artifacts only", () => {
  const file = workflow("release-fork.yml")
  const triggers = file.slice(file.indexOf("\non:\n"), file.indexOf("\npermissions:\n"))
  const version = file.slice(file.indexOf("\n  version:"), file.indexOf("\n  package-templates:"))
  const publish = file.slice(file.indexOf("\n  publish-release:"), file.indexOf("\n  # No-op job"))

  assert.match(triggers, /push:[\s\S]*?branches:\n      - main(?:\n|$)/, "main registration trigger")
  assert(!triggers.includes("      - dev"), "retired dev registration trigger")
  assert(version.includes("if: github.ref != 'refs/heads/main'"), "non-main dispatch rejection")
  assert(version.includes("exit 1"), "non-main dispatch must fail")
  assert(file.includes("OPENCODE_CHANNEL: latest"), "stable binary channel")
  assert(publish.includes("if: inputs.create_release && github.ref == 'refs/heads/main'"), "main publish guard")
  assert(publish.includes("--latest"), "stable Latest publication")
  assert(!publish.includes("--prerelease"), "retired prerelease publication")
})

await test("release checkout credentials and third-party action versions are fixed", () => {
  const file = workflow("release-fork.yml")
  const checkout = "actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5"
  const download = "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093"
  const upload = "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02"

  assert.equal(file.split(checkout).length - 1, 5, "pinned checkout steps")
  assert.equal(file.split("persist-credentials: false").length - 1, 5, "credential-free checkout steps")
  assert.equal(file.split(download).length - 1, 3, "pinned download steps")
  assert.equal(file.split(upload).length - 1, 3, "pinned upload steps")
  assert(!/actions\/(?:checkout|download-artifact|upload-artifact)@v\d/.test(file), "mutable action tag remains")
})

await test("release candidate preparation is read-only and publication owns the only write token", () => {
  const file = workflow("release-fork.yml")
  const prepare = file.slice(file.indexOf("\n  prepare-release:"), file.indexOf("\n  publish-release:"))
  const publish = file.slice(file.indexOf("\n  publish-release:"), file.indexOf("\n  # No-op job"))

  assert(file.includes("default: false"), "publishing must be opt-in")
  assert(file.includes("permissions:\n  contents: read"), "workflow default permissions")
  assert(prepare.includes("Generate SHA256SUMS"), "candidate checksum preparation")
  assert(prepare.includes("Render Release Notes (fail closed)"), "candidate notes validation")
  assert(prepare.includes("Verify Release Candidate"), "candidate verification")
  assert(prepare.includes("Setup GitHub CLI"), "read-only GitHub CLI bootstrap")
  assert(prepare.includes("uses: ./.github/actions/setup-gh"), "prepare uses the shared verified bootstrap")
  assert(prepare.includes("SELECTED_PLATFORMS: ${{ inputs.platforms }}"), "platform input env boundary")
  assert(prepare.includes('selected="$SELECTED_PLATFORMS"'), "shell reads the platform input from env")
  assert(!prepare.includes('selected="${{ inputs.platforms }}"'), "platform input must not be interpolated into shell")
  for (const archive of ["opencode-linux-*.tar.gz", "opencode-darwin-*.zip", "opencode-windows-*.zip"])
    assert(prepare.includes(archive), `selected platform archive check: ${archive}`)
  assert(prepare.includes("Upload Release Candidate"), "candidate artifact upload")
  assert(!prepare.includes("contents: write"), "prepare job gained write permission")
  assert(!prepare.includes("GH_TOKEN"), "prepare job gained a write token")
  assert(publish.includes("if: inputs.create_release"), "publish opt-in guard")
  assert(publish.includes("permissions:\n      contents: write"), "publish write permission")
  assert(publish.includes("GH_TOKEN: ${{ github.token }}"), "publish token")
  assert(publish.includes('--repo "${{ github.repository }}"'), "publish must name the repository without checkout")
  assert.equal(file.split("contents: write").length - 1, 1, "only publish may write contents")
  assert.equal(file.split("GH_TOKEN: ${{ github.token }}").length - 1, 1, "only publish receives GH_TOKEN")
  assert(file.includes("set -o pipefail"), "template provenance capture must preserve packager failures")
  assert(file.includes("Verify Template Provenance"), "template provenance validation")
  for (const field of ["runtime_commit", "template_commit", "compat_runtime_sha"])
    assert(file.includes(field), `template provenance field: ${field}`)
  assert(file.includes("command -v sha256sum"), "Linux checksum fallback")
  assert(publish.includes('"${assets[@]}"'), "publish must tolerate a selected platform subset")
})

await test("verified GitHub CLI bootstrap pins supported archives and verifies before extracting", () => {
  const action = repositoryFile(".github/actions/setup-gh/action.yml")
  const setup = repositoryFile(".github/actions/setup-gh/setup.sh")
  const version = "2.101.0"
  const linuxSha = "9bca2d1c16825f109907a23307628a2f0698fbf99662b73a5cf0b020293072b8"
  const windowsSha = "bc6c814367b193cd8e713611d61e36013c0ef843b8f516458fe3eda039192794"

  for (const value of [version, linuxSha, windowsSha, `https://github.com/cli/cli/releases/download/v${version}`])
    assert(action.includes(value), `missing immutable GitHub CLI pin: ${value}`)
  assert(!action.includes("GH_TOKEN"), "bootstrap must download public assets anonymously")
  assert(!action.includes("GITHUB_TOKEN"), "bootstrap must not receive a repository token")

  for (const contract of [
    "Linux:X64",
    "Windows:X64",
    `gh_\${GH_CLI_VERSION}_linux_amd64/bin/gh`,
    "bin/gh.exe",
    "Unsupported GitHub CLI bootstrap platform",
    "archive checksum mismatch",
    "Expand-Archive -LiteralPath",
    "GH_CLI_ARCHIVE_WINDOWS",
    "GH_CLI_EXTRACT_WINDOWS",
    "cygpath -w",
    "--connect-timeout 20 --max-time 300 --retry 3 --retry-delay 1",
  ])
    assert(setup.includes(contract), `bootstrap contract: ${contract}`)

  const checksum = setup.indexOf('if [ "$actual" != "$expected" ]')
  const linuxExtract = setup.indexOf('tar -xzf "$archive"')
  const windowsExtract = setup.indexOf("Expand-Archive -LiteralPath")
  assert(checksum !== -1 && checksum < linuxExtract, "Linux extraction must follow checksum verification")
  assert(checksum !== -1 && checksum < windowsExtract, "Windows extraction must follow checksum verification")
})

await test("jobs that check out repository content bootstrap gh before evidence reuse", () => {
  const typecheck = workflow("ci-typecheck.yml")
  const tests = workflow("ci-test.yml")
  assert.equal(typecheck.split("uses: ./.github/actions/setup-gh").length - 1, 1, "typecheck bootstrap count")
  assert(
    typecheck.indexOf("uses: ./.github/actions/setup-gh") <
      typecheck.indexOf("uses: ./.github/actions/verified-content"),
  )
  assert(typecheck.includes("run: bash script/setup-gh.test.sh"), "bootstrap fixture test is not wired")

  const testBootstraps = [...tests.matchAll(/uses: \.\/\.github\/actions\/setup-gh/g)].map((match) => match.index)
  const evidenceSteps = [...tests.matchAll(/uses: \.\/\.github\/actions\/verified-content/g)].map(
    (match) => match.index,
  )
  assert.equal(testBootstraps.length, 4, "unit/e2e bootstrap count")
  assert.equal(evidenceSteps.length, 4, "unit/e2e evidence count")
  for (let index = 0; index < testBootstraps.length; index++)
    assert(testBootstraps[index] < evidenceSteps[index], `test job ${index + 1} bootstraps gh after evidence`)
})

await test("release publication uses an anonymous fail-closed Linux bootstrap", () => {
  const release = workflow("release-fork.yml")
  const publish = release.slice(release.indexOf("\n  publish-release:"), release.indexOf("\n  # No-op job"))
  const publishSetup = namedSteps(publish, "Setup GitHub CLI")[0]

  assert(publishSetup, "publish bootstrap missing")
  assert(publishSetup.includes('GH_CLI_VERSION: "2.101.0"'), "inline version pin")
  assert(
    publishSetup.includes("9bca2d1c16825f109907a23307628a2f0698fbf99662b73a5cf0b020293072b8"),
    "inline Linux SHA pin",
  )
  assert(publishSetup.includes('"${RUNNER_OS:-}" != "Linux"'), "inline OS rejection")
  assert(publishSetup.includes('"${RUNNER_ARCH:-}" != "X64"'), "inline architecture rejection")
  assert(!publishSetup.includes("GH_TOKEN"), "bootstrap step must not receive GH_TOKEN")
  assert(!publishSetup.includes("GITHUB_TOKEN"), "bootstrap step must not receive GITHUB_TOKEN")
  assert(
    publishSetup.indexOf('if [ "$actual" != "$GH_CLI_LINUX_AMD64_SHA256" ]') <
      publishSetup.indexOf('tar -xzf "$archive"'),
  )
  assert(!publish.includes("uses: actions/checkout"), "publish must remain no-checkout")
})
