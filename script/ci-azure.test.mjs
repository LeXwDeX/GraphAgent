// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

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
    "displayName: Unit Tests (graphagent ${{ shard }}/${{ length(parameters.shards) }})\n",
    "displayName: Unit Tests (HttpAPI)\n",
    "displayName: Bench (TUI)\n",
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
  for (const job of ["unit_workspace", "unit_httpapi", "unit_graphagent_${{ shard }}"]) {
    assert(aggregate.includes(`- ${job}\n`), `depends on ${job}`)
    assert(aggregate.includes(`$[ dependencies.${job}.result ]`), `reads ${job} result`)
  }
  assert(aggregate.includes('if [ "$result" != "Succeeded" ]'))
  assert(aggregate.includes("expected=$(( 3 + ${{ length(parameters.shards) }} ))"))
  assert(aggregate.includes("- checkout: none"), "aggregate runs no repository code")
})

await test("CI runs the gates the GitHub workflows used to run", () => {
  for (const command of [
    "bun run check:hosts",
    "bun run check:hosts:test",
    "bun run check:fn-length",
    "bun run lint",
    "bun typecheck",
    "bun run --cwd packages/core migration --check",
    "bun run test:dag-core",
    "bash script/oc-install-boundary.test.sh && bash script/oc-path-priority.test.sh",
    "bun turbo test --concurrency=1 --filter='!graphagent'",
    "go test ./...",
    "bun run check:generated",
    "--shard=${{ shard }}/${{ length(parameters.shards) }} --timings=test/ci-timings.json",
    "bun run test:httpapi:ci",
    "bun run bench:tui -- --repeats=5 --enforce",
  ])
    assert(ci.includes(command), command)
  assert.match(ci, /bun run test:httpapi:ci\n\s+displayName: [^\n]+\n\s+workingDirectory: [^\n]+\n\s+timeoutInMinutes: \d+/)
  assert.match(ci, /bun run check:generated\n\s+displayName: Check generated SDK\n\s+workingDirectory: packages\/sdk\/js/)
  assert.match(ci, /bun run check:fn-length\n\s+displayName: Check session function length\n/)
  assert.match(
    ci,
    /bun run check:hosts\n\s+displayName: Check private hosts\n\s+env:\n\s+PRIVATE_HOST_PATTERNS: \$\(PRIVATE_HOST_PATTERNS\)/,
  )
})

await test("Azure Pipelines runs development CI and GitHub Actions runs release and extra Nix platforms", () => {
  const workflows = new URL("../.github/workflows/", import.meta.url)
  assert.deepEqual(
    readdirSync(workflows).sort(),
    ["nix-extra-platforms.yml", "release-fork.yml"],
    ".github/workflows holds the release and the extra Nix platforms",
  )
  for (const file of ["ci.yml", "nix-verify.yml", "nightly-pty.yml", "release.yml", "templates/toolchain.yml"])
    assert(existsSync(new URL(`../.azure-pipelines/${file}`, import.meta.url)), file)
  const release = read(".azure-pipelines/release.yml")
  assert.match(release, /\ntrigger: none\npr: none\n/, "the Azure release fallback is manual only")
  const nix = read(".azure-pipelines/nix-verify.yml")
  assert.match(nix, /\ntrigger: none\n/)
  assert.match(nix, /\n  paths:\n    include:\n      - flake\.nix\n/)
})

// #1364: native Windows is not supported from v2.0 (Windows users run the Linux build under WSL), so
// neither release pipeline builds, packages or checks a Windows artifact.
await test("the release pipelines build Linux and macOS only", () => {
  for (const file of [".github/workflows/release-fork.yml", ".azure-pipelines/release.yml"])
    assert.doesNotMatch(read(file), /windows/i, `${file} has no Windows target`)
})

// #1095: the Azure pool cannot route aarch64-linux and x86_64-darwin, so a GitHub workflow runs the same
// verification there. It keeps the same triggers and the same Nix, and its actions stay pinned.
await test("the GitHub Nix workflow mirrors the Azure Nix pipeline on the platforms Azure cannot route", () => {
  const azure = read(".azure-pipelines/nix-verify.yml")
  const github = read(".github/workflows/nix-extra-platforms.yml")
  const items = (text, pattern) =>
    (text.match(pattern)?.[1] ?? "")
      .split("\n")
      .filter(Boolean)
      .map((line) => line.replace(/^\s*- /, ""))
  // An Azure path filter names the nix directory; GitHub needs a glob for the files inside it.
  const azurePaths = items(azure, /\n  paths:\n    include:\n((?:      - [^\n]+\n)+)/).map((path) =>
    path === "nix" ? "nix/**" : path,
  )
  const githubPaths = items(github, /\n    paths:\n((?:      - [^\n]+\n)+)/)
  assert(azurePaths.includes("flake.nix"), "the Azure path list was read")
  assert.deepEqual(
    githubPaths.toSorted(),
    [...azurePaths, ".github/workflows/nix-extra-platforms.yml"].toSorted(),
    "same path list as the Azure pipeline, plus the workflow itself",
  )
  const installer = /https:\/\/releases\.nixos\.org\/nix\/nix-[\d.]+\/install/
  assert(azure.match(installer), "the Azure pipeline pins a Nix installer")
  assert.equal(github.match(installer)?.[0], azure.match(installer)[0], "both pipelines install the same Nix")
  assert.deepEqual(
    [...github.matchAll(/^ +- system: (\S+)$/gm)].map((match) => match[1]),
    ["aarch64-linux", "x86_64-darwin"],
  )
  assert.match(github, /\npermissions:\n  contents: read\n/)
  const actions = [...github.matchAll(/uses: (\S+)@(\S+)/g)]
  assert(actions.length > 0, "the workflow uses actions")
  for (const [, action, ref] of actions) assert.match(ref, /^[0-9a-f]{40}$/, `${action} is pinned to a commit`)
})

// #1279: the PTY end-to-end benchmark runs nightly and by hand, and reports; it is not a gate.
await test("the nightly PTY benchmark is a scheduled warning, not a gate", () => {
  const nightly = read(".azure-pipelines/nightly-pty.yml")
  assert.match(nightly, /\ntrigger: none\npr: none\n/, "no push or pull request trigger")
  assert.match(
    nightly,
    /\nschedules:\n  - cron: "[^"\n]+"\n[^\n]*\n    branches:\n      include:\n        - main\n    always: true\n/,
    "a nightly schedule on main that does not wait for a commit",
  )
  assert(nightly.includes("bun run bench:tui:pty"), "runs the PTY benchmark")
  assert(nightly.includes("bun test/perf/pty-report.ts"), "writes the ratio table")
  assert(nightly.includes("##vso[task.uploadsummary]"), "puts the table on the run summary")
  assert.match(nightly, /- publish: [^\n]+\n\s+artifact: tui-pty-/, "uploads the runs as an artifact")
  // The benchmark and the report only warn; a failed measurement must not turn the run red.
  const steps = nightly.split("\n      - ")
  for (const name of ["Run PTY benchmark", "Report ratio against the baseline"]) {
    const step = steps.find((block) => block.includes(`displayName: ${name}\n`))
    assert(step?.includes("continueOnError: true"), `${name} only warns`)
  }
  assert.doesNotMatch(nightly, /\ndependencies:|\n\s+dependsOn:/, "nothing waits on the nightly")
  // The PR pipeline stays free of it: no schedule, no PTY step, no job the aggregate depends on.
  assert.doesNotMatch(ci, /\nschedules:/)
  assert(!ci.includes("bench:tui:pty") && !ci.includes("nightly"), "ci.yml does not run the nightly benchmark")
  assert(existsSync(new URL("../packages/tui/test/perf/pty-report.ts", import.meta.url)), "the table script exists")
  assert(existsSync(new URL("../packages/tui/test/perf/pty-baseline.json", import.meta.url)), "the PTY baseline exists")
})

await test("every job runs on the per-minute GitHub-hosted Agents pool", () => {
  for (const file of ["ci.yml", "nix-verify.yml", "nightly-pty.yml", "release.yml"]) {
    const pipeline = read(`.azure-pipelines/${file}`)
    const pools = pipeline.match(/\n\s+pool:\n[^\n]+/g) ?? []
    assert(pools.length > 0, file)
    for (const pool of pools) assert.match(pool, /name: GitHub-hosted Agents$/, `${file}: ${pool.trim()}`)
  }
})

await test("the root Azure pipeline stays a bounded, credential-free runner probe", () => {
  const smoke = read("azure-pipelines.yml")
  assert.match(smoke, /\ntrigger: none\npr: none\n/)
  assert.match(smoke, /Manual capacity probe only; development CI is\n#\s+\.azure-pipelines\/ci\.yml/)
  assert.equal((smoke.match(/- job: smoke_/g) ?? []).length, 2, "linux and macOS probes")
  assert.equal((smoke.match(/timeoutInMinutes: 10/g) ?? []).length, 2, "every probe is bounded")
  assert.equal((smoke.match(/- checkout: none/g) ?? []).length, 2, "no probe checks out repository code")
  assert.doesNotMatch(smoke, /azureSubscription:|serviceConnection:|secrets\.|- task:|checkout: self/)
  for (const pool of smoke.match(/vmImage: [^\n]+/g) ?? [])
    assert.match(pool, /vmImage: (ubuntu-latest|macOS-latest)$/, pool)
  for (const name of smoke.match(/^ {8}name: [^\n]+$/gm) ?? [])
    assert.equal(name.trim(), "name: yc-ci-linux", "named pools stay on the managed CI pool")
})
