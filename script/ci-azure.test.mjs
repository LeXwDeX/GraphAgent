import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readdirSync, readFileSync } from "node:fs"

const read = (name) => readFileSync(new URL(`../${name}`, import.meta.url), "utf8")
const ci = read(".azure-pipelines/ci.yml")

// Job display names are the GitHub check names that `main` branch protection
// requires; renaming one silently drops a required gate.
await test("CI keeps the required gate names", () => {
  for (const name of [
    "displayName: Typecheck\n",
    "displayName: Unit Tests (workspace)\n",
    "displayName: Unit Tests (opencode ${{ shard }}/${{ length(parameters.shards) }})\n",
    "displayName: Unit Tests (HttpAPI)\n",
    "displayName: Unit Tests (linux)\n",
  ])
    assert(ci.includes(name), name)
  assert.match(ci, /name: shards\n[\s\S]*?default: \[1, 2, 3, 4\]/)
})

await test("every main PR and main push runs the full suite", () => {
  assert.match(ci, /\ntrigger:\n  batch: false\n  branches:\n    include:\n      - main\n/)
  assert.match(ci, /\npr:\n  autoCancel: true\n  drafts: true\n  branches:\n    include:\n      - main\n/)
  assert.doesNotMatch(ci, /\n  paths:/, "CI must not be path-filtered")
  assert.doesNotMatch(ci, /condition: .*(Build\.Reason|SourceBranch)/, "no gate is skipped by event or branch")
})

await test("the unit aggregate fails unless every unit job succeeded", () => {
  const aggregate = ci.slice(ci.indexOf("\n  - job: unit_tests"))
  assert(aggregate.includes("condition: always()"), "aggregate runs after failed or skipped dependencies")
  for (const job of ["unit_workspace", "unit_httpapi", "unit_opencode_${{ shard }}"]) {
    assert(aggregate.includes(`- ${job}\n`), `depends on ${job}`)
    assert(aggregate.includes(`$[ dependencies.${job}.result ]`), `reads ${job} result`)
  }
  assert(aggregate.includes('if [ "$result" != "Succeeded" ]'))
  assert(aggregate.includes("expected=$(( 2 + ${{ length(parameters.shards) }} ))"))
  assert(aggregate.includes("- checkout: none"), "aggregate runs no repository code")
})

await test("CI runs the gates the GitHub workflows used to run", () => {
  for (const command of [
    "bun run check:hosts",
    "bun run check:hosts:test",
    "bun run lint",
    "bun typecheck",
    "bun run --cwd packages/core migration --check",
    "bun run test:dag-core",
    "bash script/oc-install-boundary.test.sh && bash script/oc-path-priority.test.sh",
    "bun turbo test --concurrency=1 --filter='!opencode'",
    "go test ./...",
    "bun run check:generated",
    "--shard=${{ shard }}/${{ length(parameters.shards) }} --timings=test/ci-timings.json",
    "bun run test:httpapi:ci",
  ])
    assert(ci.includes(command), command)
  assert.match(ci, /bun run test:httpapi:ci\n\s+displayName: [^\n]+\n\s+workingDirectory: [^\n]+\n\s+timeoutInMinutes: \d+/)
  assert.match(ci, /bun run check:generated\n\s+displayName: Check generated SDK\n\s+workingDirectory: packages\/sdk\/js/)
  assert.match(
    ci,
    /bun run check:hosts\n\s+displayName: Check private hosts\n\s+env:\n\s+PRIVATE_HOST_PATTERNS: \$\(PRIVATE_HOST_PATTERNS\)/,
  )
})

await test("Azure Pipelines runs development CI and GitHub Actions runs release and Windows E2E", () => {
  const workflows = new URL("../.github/workflows/", import.meta.url)
  assert.deepEqual(
    readdirSync(workflows).sort(),
    ["release-fork.yml", "windows-e2e.yml"],
    ".github/workflows holds the release and Windows E2E",
  )
  for (const file of ["ci.yml", "nix-verify.yml", "release.yml", "templates/toolchain.yml"])
    assert(existsSync(new URL(`../.azure-pipelines/${file}`, import.meta.url)), file)
  const release = read(".azure-pipelines/release.yml")
  assert.match(release, /\ntrigger: none\npr: none\n/, "the Azure release fallback is manual only")
  const windows = read(".github/workflows/windows-e2e.yml")
  assert.match(windows, /name: Verify DAG artifact storage on Windows\n\s+working-directory: packages\/opencode/)
  for (const file of ["dag-output-ref", "dag-output-ref-result", "dag-input-mapping-runtime", "dag-artifact-permissions"])
    assert(windows.includes(`test/dag/${file}.test.ts`), file)
  const nix = read(".azure-pipelines/nix-verify.yml")
  assert.match(nix, /\ntrigger: none\n/)
  assert.match(nix, /\n  paths:\n    include:\n      - flake\.nix\n/)
})

await test("every job runs on the per-minute GitHub-hosted Agents pool", () => {
  for (const file of ["ci.yml", "nix-verify.yml", "release.yml"]) {
    const pipeline = read(`.azure-pipelines/${file}`)
    const pools = pipeline.match(/\n\s+pool:\n[^\n]+/g) ?? []
    assert(pools.length > 0, file)
    for (const pool of pools)
      assert.match(pool, /name: GitHub-hosted Agents$|vmImage: (windows-latest|\$\{\{ target\.image \}\})$/, `${file}: ${pool.trim()}`)
  }
})

await test("the root Azure pipeline stays a bounded, credential-free runner probe", () => {
  const smoke = read("azure-pipelines.yml")
  assert.match(smoke, /\ntrigger: none\npr: none\n/)
  assert.match(smoke, /Manual capacity probe only; development CI is\n#\s+\.azure-pipelines\/ci\.yml/)
  assert.equal((smoke.match(/- job: smoke_/g) ?? []).length, 3, "linux, windows and macOS probes")
  assert.equal((smoke.match(/timeoutInMinutes: 10/g) ?? []).length, 3, "every probe is bounded")
  assert.equal((smoke.match(/- checkout: none/g) ?? []).length, 3, "no probe checks out repository code")
  assert.doesNotMatch(smoke, /azureSubscription:|serviceConnection:|secrets\.|- task:|checkout: self/)
  for (const pool of smoke.match(/vmImage: [^\n]+/g) ?? [])
    assert.match(pool, /vmImage: (ubuntu-latest|windows-latest|macOS-latest)$/, pool)
  for (const name of smoke.match(/^ {8}name: [^\n]+$/gm) ?? [])
    assert.equal(name.trim(), "name: yc-ci-linux", "named pools stay on the managed CI pool")
})
