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
    "displayName: E2E Tests (${{ platform }})\n",
  ])
    assert(ci.includes(name), name)
  assert.match(ci, /name: e2ePlatforms\n[\s\S]*?default: \[linux, windows\]/)
  assert.match(ci, /name: shards\n[\s\S]*?default: \[1, 2, 3, 4\]/)
})

await test("every main PR and main push runs the full suite", () => {
  assert.match(ci, /\ntrigger:\n  batch: false\n  branches:\n    include:\n      - main\n/)
  assert.match(ci, /\npr:\n  autoCancel: true\n  drafts: true\n  branches:\n    include:\n      - main\n/)
  assert.doesNotMatch(ci, /\n  paths:/, "CI must not be path-filtered")
  assert.doesNotMatch(ci, /condition: .*(Build\.Reason|SourceBranch)/, "no gate is skipped by event or branch")
})

await test("the unit aggregate fails unless every unit job succeeded", () => {
  const aggregate = ci.slice(ci.indexOf("\n  - job: unit_tests"), ci.indexOf("\n  - ${{ each platform"))
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
    "bun run lint",
    "bun typecheck",
    "bun run test:dag-core",
    "bash script/oc-install-boundary.test.sh && bash script/oc-path-priority.test.sh",
    "bun turbo test --concurrency=1 --filter='!opencode'",
    "go test ./...",
    "bun run test:unit",
    "bun run check:generated",
    "--shard=${{ shard }}/${{ length(parameters.shards) }} --timings=test/ci-timings.json",
    "bun run test:httpapi:ci",
    "bun --cwd packages/app test:e2e:local",
    "test/dag/dag-artifact-permissions.test.ts",
    "test/sanitize-markdown.test.ts",
  ])
    assert(ci.includes(command), command)
  assert.match(ci, /bun run test:httpapi:ci\n\s+displayName: [^\n]+\n\s+workingDirectory: [^\n]+\n\s+timeoutInMinutes: \d+/)
})

await test("Azure Pipelines replaces GitHub Actions entirely", () => {
  const workflows = new URL("../.github/workflows/", import.meta.url)
  assert(!existsSync(workflows) || readdirSync(workflows).length === 0, ".github/workflows must stay empty")
  for (const file of ["ci.yml", "nix-verify.yml", "release.yml", "templates/toolchain.yml"])
    assert(existsSync(new URL(`../.azure-pipelines/${file}`, import.meta.url)), file)
  const release = read(".azure-pipelines/release.yml")
  assert.match(release, /\ntrigger: none\npr: none\n/, "release is manual only")
  const nix = read(".azure-pipelines/nix-verify.yml")
  assert.match(nix, /\ntrigger: none\n/)
  assert.match(nix, /\n  paths:\n    include:\n      - flake\.nix\n/)
})
