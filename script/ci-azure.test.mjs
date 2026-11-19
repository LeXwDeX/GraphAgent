// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

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
    "bun run check:model-id",
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
  assert.match(ci, /bun run check:model-id\n\s+displayName: Check model id branches\n/)
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

// #1034: both release pipelines run the same smoke script against every packaged binary, on Linux and on
// macOS, before packaging; macOS keeps its install acceptance on top of it.
await test("both release pipelines run the shared smoke script on every platform", () => {
  const github = read(".github/workflows/release-fork.yml")
  const azure = read(".azure-pipelines/release.yml")
  const call = 'bash script/release-smoke.sh "${dir%/}/bin/graphagent" "$GRAPHAGENT_VERSION"'

  // The GitHub step only filters by the requested platforms; it no longer skips macOS.
  const githubStep = github.match(/\n {6}- name: Verify CLI executable\n((?: {8}[^\n]*\n)+)/)?.[1] ?? ""
  assert.match(githubStep, /^ {8}if: inputs\.platforms == '' \|\| contains\(inputs\.platforms, matrix\.name\)$/m)
  assert(githubStep.includes("GRAPHAGENT_VERSION: ${{ needs.version.outputs.version }}"), "expected version")
  assert(githubStep.includes(call), "release-fork.yml runs the smoke script")
  // The Azure step sits directly under `steps:` (14 spaces), not inside the `${{ if ne(target.name, 'macos') }}:` block.
  const azureStep =
    azure.match(/\n {14}- bash: \|\n((?: {18}[^\n]*\n)+) {16}displayName: Verify CLI executable\n/)?.[1] ?? ""
  assert(azureStep.includes(call), "release.yml runs the smoke script on every platform")

  for (const [file, text, verify, pack, acceptance] of [
    [
      ".github/workflows/release-fork.yml",
      github,
      "name: Verify CLI executable\n",
      "name: Package Artifacts\n",
      "name: macOS Install Acceptance\n",
    ],
    [
      ".azure-pipelines/release.yml",
      azure,
      "displayName: Verify CLI executable\n",
      "displayName: Package artifacts\n",
      "displayName: macOS install acceptance\n",
    ],
  ]) {
    assert.equal((text.match(/bash script\/release-smoke\.sh /g) ?? []).length, 1, `${file} runs the script once`)
    const order = [verify, pack, acceptance].map((marker) => text.indexOf(marker))
    assert(order[0] >= 0 && order[0] < order[1] && order[1] < order[2], `${file}: smoke, package, macOS acceptance`)
    assert(text.includes("bash script/oc-macos-acceptance.test.sh"), `${file} keeps the macOS install acceptance`)
  }

  const script = read("script/release-smoke.sh")
  assert(script.startsWith("#!/usr/bin/env bash\n"), "a bash script")
  assert(script.includes("\nset -euo pipefail\n"), "strict mode")
  assert(script.includes("GRAPHAGENT_DISABLE_MODELS_FETCH=1"), "the smoke test stays offline")
})

// The smoke script itself, against a stand-in CLI that prints the real output formats. The release pipelines
// only run it when a release is cut, so its pass and fail paths are exercised here on every pull request.
// STUB_FAULT picks one regression for the stand-in to inject.
const smokeStub = `#!/usr/bin/env bash
if [ "$STUB_FAULT" = old-dir ]; then mkdir -p "$XDG_CONFIG_HOME/opencode"; fi
case "$*" in
  --version) echo 9.9.9 ;;
  --help)
    {
      if [ "$STUB_FAULT" = no-logo ]; then echo "OpenCode"; else echo "◇─◆ GraphAgent"; fi
      echo
      echo "Commands:"
      echo "  graphagent completion          generate shell completion script"
      echo "  graphagent [project]           start graphagent tui                       [default]"
      echo "  graphagent run [message..]     run graphagent with a message"
      echo "  graphagent debug               debugging and troubleshooting tools"
      echo "  graphagent providers           manage AI providers                   [aliases: auth]"
      echo "  graphagent pr <number>         fetch and checkout a GitHub PR branch, then run graphagent"
      if [ "$STUB_FAULT" = removed ]; then echo "  graphagent serve               start a server"; fi
    } >&2
    ;;
  "run --help") echo "graphagent run [message..]" >&2 ;;
  "debug paths")
    config="$XDG_CONFIG_HOME/graphagent"
    if [ -n "$GRAPHAGENT_CONFIG_DIR" ]; then config="$GRAPHAGENT_CONFIG_DIR"; fi
    if [ "$STUB_FAULT" = legacy-env ] && [ -n "$OPENCODE_CONFIG_DIR" ]; then config="$OPENCODE_CONFIG_DIR"; fi
    printf '%-10s %s\\n' home "$HOME" data "$XDG_DATA_HOME/graphagent" bin "$XDG_CACHE_HOME/graphagent/bin" \\
      log "$XDG_DATA_HOME/graphagent/log" repos "$XDG_DATA_HOME/graphagent/repos" cache "$XDG_CACHE_HOME/graphagent" \\
      config "$config" state "$XDG_STATE_HOME/graphagent" tmp "$TMPDIR/graphagent"
    ;;
esac
`

await test("release-smoke.sh passes a conforming CLI and names the step of each regression", () => {
  const dir = mkdtempSync(join(tmpdir(), "release-smoke-test-"))
  try {
    const script = fileURLToPath(new URL("./release-smoke.sh", import.meta.url))
    const cli = join(dir, "graphagent")
    writeFileSync(cli, smokeStub, { mode: 0o755 })
    const smoke = (fault, { version = "9.9.9", env = {} } = {}) =>
      spawnSync("bash", [script, cli, version], {
        encoding: "utf8",
        env: { ...process.env, ...env, STUB_FAULT: fault },
      })

    const pass = smoke("none")
    assert.equal(pass.status, 0, pass.stderr)
    assert.match(pass.stdout, /release-smoke: OK/)
    // Variables of the caller that move paths must not reach the CLI.
    const inherited = { GRAPHAGENT_CONFIG_DIR: join(dir, "elsewhere"), OPENCODE_CONFIG_DIR: join(dir, "legacy") }
    const hermetic = smoke("none", { env: inherited })
    assert.equal(hermetic.status, 0, hermetic.stderr)

    const regressions = [
      { regression: "a different version", result: smoke("none", { version: "2.0.0" }), step: 1 },
      { regression: "the old logo", result: smoke("no-logo"), step: 2 },
      { regression: "a removed command", result: smoke("removed"), step: 3 },
      { regression: "a directory named after the old brand", result: smoke("old-dir"), step: 4 },
      { regression: "a legacy variable that is honored", result: smoke("legacy-env"), step: 5 },
    ]
    for (const { regression, result, step } of regressions) {
      assert.equal(result.status, 1, `${regression}: ${result.stderr}`)
      assert(result.stderr.includes(`FAIL (step ${step})`), `${regression}: ${result.stderr}`)
    }
    assert.equal(spawnSync("bash", [script, cli], { encoding: "utf8" }).status, 2, "arguments are checked")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
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
