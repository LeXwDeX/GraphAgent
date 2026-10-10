# AGENTS.md

Guidance for coding agents in GraphAgent, an opencode fork with a DAG workflow engine. This file records repository facts and secondary development constraints. Apply the nearest nested `AGENTS.md` to each changed package. Verify factual claims against current source, package scripts, and workflows; do not treat a development rule as proof that a check has passed.

## Scope and layout

- GraphAgent v1 is in focused maintenance, as described in `README.md`: DAG configuration, curated workflow templates, and reproducible defect fixes. Stability and data-integrity defects may receive narrow compatibility patches. Keep changes within this scope.
- Bun workspace + Turbo. Runtime pins have one source each: Bun in `package.json` (`packageManager`), Node in `.node-version`, Go in `config_assistant/go.mod`. `bun run toolchain:check` and `.husky/pre-push` reject any differing runtime patch; CI and container builds read the same pins. Electron owns its embedded Node runtime; VSCode extension host types retain their own compatibility major.
- `packages/core`: DAG engine primitives (`src/dag/` — store/projector/sql, exported as `./dag/core/*` and `./dag/*`) plus DB schema/migrations ownership.
- `packages/opencode`: agent runtime. Services compose in `AppLayer` (`src/effect/app-runtime.ts`). Effect v4 (beta) rules, `makeRuntime`/`InstanceState`, tool-schema, and module-shape contracts are owned by `packages/opencode/AGENTS.md` (pattern reference: `packages/opencode/specs/effect/migration.md`).
- Curated workflow YAML, composable blocks, and reusable worker prompts live in `LeXwDeX/opencode-dag-config`. Release builds embed its snapshot through `DAG_TEMPLATES_DIR` (`packages/opencode/script/generate.ts`). Local builds without that variable omit builtin templates and use project/global libraries. Curated configuration-only changes belong in the configuration repo; runtime routing and policy prompts still live here.

## Secondary development constraints

- Before behavior changes, record Why, Scope, Approach, and Acceptance. Read the affected package rules and existing regression tests. Keep fixes focused; do not combine unrelated cleanup or dependency upgrades.
- Keep database schemas and migrations in `packages/core`. Generate schema changes with `bun run migration` there. Include the migration under `src/database/migration/`, `schema.json`, `src/database/migration.gen.ts`, and `src/database/schema.gen.ts` together. Preserve existing data and test both new databases and upgrades.
- Persist DAG lifecycle changes through the existing Dag/EventV2 path. Keep projectors limited to database writes. Preserve replay idempotency and keep projection guards consistent with the transition tables.
- Preserve workflow locking, execution-attempt identity, directory ownership, and pause/cancel/recovery behavior. Cover affected stale completion, restart, deletion, and lease-release paths. Do not assume cross-process locking or exactly-once execution.
- Use `InstanceState` for state owned by a directory. Bind subscriptions, child processes, and background work to scopes with finalizers. Preserve application-scoped supervision that must survive directory disposal. Test resource release when changing lifecycle behavior.
- Preserve public HTTP shapes, event identities, and durable event versions. Update producers, consumers, manifests, generated clients, and scenarios together when changing a contract. Provide explicit compatibility handling for persisted formats.
- Keep tool parameter schemas object-rooted. Validate arguments and apply the tool's permission policy before side effects. Preserve interruption and defect propagation. Follow the relevant tool rules in `packages/opencode/AGENTS.md` or `packages/core/src/tool/AGENTS.md`.
- Keep dependency manifests, the workspace catalog, lockfiles, overrides, and patches consistent. Match native wrappers to their platform packages. Change runtime pins at their declared sources and verify affected CI, containers, and Nix builds. Use real Nix builds to regenerate hashes.
- Use isolated sessions, temporary data, and task-owned test processes. Preserve the user's active chats, configuration, and running services. Keep credentials out of logs and fixtures. Security audits use model reasoning over business logic and source; do not use external DayBreak tools.

## Commands (from repo root unless noted)

- Install: `bun install`. Installs are exact-pinned; newly resolved releases must be ≥3 days old unless excluded (root `bunfig.toml`).
- Toolchain: `bun run toolchain:check` checks installed Bun, Node, and Go before runtime validation. CLI build scripts import the shared `Script` module, which checks Bun and Node. Go CI sets `GOTOOLCHAIN=local`. Rust containers read `packages/containers/rust-toolchain.toml` and verify the compiler version.
- Nix: runtime assertions reject mismatched packages. `nix/README.md` records the reviewed inputs and exact Electron/ripgrep sources. Native package acceptance still requires measured node_modules hashes and successful CLI and desktop builds on each supported platform. Evaluation or source archive verification alone does not certify those builds.
- Dev: `bun run dev` (opencode CLI — starts the interactive TUI; use the tmux pattern from `packages/opencode/AGENTS.md`, never a blocking foreground run), `bun run dev:web`, `bun run dev:desktop`.
- Typecheck: `bun run typecheck` uses Turbo to run package scripts. Most use `tsgo --noEmit`; app and desktop use `tsgo -b`. Use the package scripts.
- Build: `cd packages/opencode && bun run build --single` builds the host CLI. Other packages own their build scripts; the root has no `build` script. A successful build does not replace typechecking.
- Lint: `bun run lint` = `oxlint` with a `--max-warnings` ratchet. The ratchet only tightens: fix warnings, never raise the cap (contract: `_lint_ratchet_note` in `package.json` and the `.oxlintrc.json` header).
- Tests: do not run bare `bun test` or `bun run test` at the root; both are guarded. Run Bun tests inside a package, preferably through its `test` script. Workspace CI uses `bun turbo test` from the root. The opencode and TUI test scripts pass `--timeout 30000`. App tests use `test:unit` / `test:browser` with the package's happydom preload.
- macOS browser validation: from `packages/web`, use `bun run test:browser:webkit` for the shared Markdown WebKit regression. Use the installed Playwright SDK and its matching browser revision; install a missing WebKit through that same installed CLI. Do not substitute another cached revision or launch `Playwright.app` directly: the SDK invokes `pw_run.sh` with the bundled frameworks. Do not change system or sandbox security policies to launch it.
- DAG gate: `cd packages/opencode && bun run test:dag-core` — behavior/coverage gate; run it before merging changes to DAG state-machine or persistence code.
- Format: Prettier `semi: false`, `printWidth: 120`.

## Live model validation

- The user authorizes necessary isolated development and acceptance calls through the QWEN, GLM and DeepSeek models already present in the system configuration. Discover their current provider/model IDs and reuse the configured endpoint and credential references; do not repeatedly ask the user to select or authorize those models.
- If a test model is unavailable or quota-limited, continue with an available configured model from those families. Use synthetic sessions, preserve the user's active conversations and configuration, and keep credentials out of logs and artifacts. This authorization is for model calls, not changing credentials or deploying services.
- For runtime fixes accepted through the installed `opencode` command, first install the local test build over `/usr/local/bin/opencode`; verify that the command actually runs this binary, its version, and matching build/install SHA-256 hashes before testing. Start a new process; see `packages/opencode/AGENTS.md` for steps. This does not apply to unit tests or `bun dev` development checks and is not a stable release.

## Local verification scope before push / PR

Repository-specific mapping; shared pre-push verification requirements live in the agent's global instructions.

- Behavior changes: run the affected package's typecheck and focused regression tests, then the applicable gates below. Record actual commands and results. For documentation-only changes, check facts, links, formatting, and the diff; runtime tests are unnecessary.
- Database changes: from `packages/core`, run `bun run migration --check` and the affected migration tests. Include empty-database and existing-database cases.
- DAG lifecycle or persistence changes: run `test:dag-core` from `packages/opencode`, plus affected replay, attempt, cancellation, recovery, and lease tests.
- Public event changes: run both `packages/schema/test/event-manifest.test.ts` and `packages/opencode/test/event-manifest.test.ts` from their respective packages, plus affected event consumers. Check inventories, fixed-count assertions and generated event types together; the DAG gate does not include every runtime manifest test.
- HTTP contract changes: follow Generated code below, verify both client generators are idempotent, and run `bun run test:httpapi` from `packages/opencode` with the updated scenarios. Generated-file checks compare against Git, so distinguish intended uncommitted output from unexpected regeneration drift.
- Runtime configuration changes: verify loading through `AppLayer` (`packages/opencode/src/effect/app-runtime.ts`), following the Effect and runtime contracts in `packages/opencode/AGENTS.md`.
- UI changes: exercise rendering and interaction on every affected client (TUI, app, or direct `run`), including relevant state transitions and terminal cleanup; a backend-only test is insufficient. Use package-local browser/TUI harnesses and isolated configuration.
- Dependency or toolchain changes: run `bun run toolchain:check`, affected package checks, and relevant toolchain/container/Go tests. Nix acceptance requires builds on a Nix host.

## CI gates (.github/workflows)

- CI push and PR targets are `main`. Development branches use `{type}/short-name`.
- `ci-typecheck.yml`: lint → typecheck → DAG-core gate → `oc` installer boundary test, plus toolchain checks.
- `ci-test.yml`: Linux workspace tests, Go tests, both client generation checks, and the HttpAPI exerciser. Playwright E2E runs on Linux and Windows. The workflow also defines focused lifecycle checks.
- Workflow files define jobs and triggers. Read current GitHub settings to verify which checks are required by branch protection.

## Generated code

- After changing HTTP API routes, regenerate both clients — CI fails on stale output: `packages/client` (`bun run generate`) and `packages/sdk/js` (`bun run build` regenerates `src/v2/gen`).
- Changing a route's request/response shape also requires updating its scenario in `packages/opencode/test/server/httpapi-exercise/index.ts`; `test:httpapi` fails on missing/skipped scenarios.

## DAG product invariants

- New workflow specs must not pin node models. Preserve historical persisted node models for compatibility. Resolution order is persisted node model → DAG tier → worker agent model → parent session model.
- Model tiers come from `dag.jsonc`. Required nodes and `review` / `review-*` workers prefer `advanced`; other nodes prefer `standard`. A single configured tier serves both.
- Keep platform delivery (issues, PRs, merge, release) out of `/dag-*` commands; use SpecGit for delivery. Built-in commands register via `packages/core/src/plugin/command.ts` and `packages/opencode/src/command/index.ts`; user commands shadow builtins by name.

## Delivery (SpecGit 2)

- SpecGit is a shared user-level CLI; resolve its version and contract with `specgit --version`, `specgit --help`, and `specgit --schema`. The declaration `.specgit.yaml` is local, per-checkout configuration (Git-excluded, not tracked). Initialize or refresh each checkout or worktree with `specgit init --provider github --remote origin --target main --language en --native-auto-merge false` and `specgit setup --agent opencode`; both are maintenance and refresh their owned blocks below.
- Track complete Why/Scope/Approach/Acceptance Issues with `specgit issue`, aggregate with `specgit pr` (created as a draft, then `specgit pr --ready`), and observe native evidence with `specgit pr --status` / bounded `specgit watch`. Branch names remain `{type}/short-name`; feature work targets `main`. Parallel deliveries use separate worktrees; each worktree keeps its own checkpoint.
- GitHub owns acceptance and merge. Repository policy requires `Typecheck`, `Unit Tests (linux)`, and both E2E platforms to pass before merge. Merge with merge commits only (`gh pr merge --merge`); squash and rebase merges are disabled because they break branch and worktree tracking. Verify the current PR head and actual native requirements; check merge state and linked Issue closure separately. Never weaken required checks to complete delivery.
- Automatic merge and supplementary Issue closure default off. Native `gh` operations require user authorization from the current task; configuration grants none.

## Releases

- `release-fork.yml` manual `workflow_dispatch` from `main` is the release pipeline. Its default `create_release: false` builds and verifies artifacts. `create_release: true` publishes the stable `X.Y.Z` release and marks it Latest.
- Release versions derive from stable `graphagent-vX.Y.Z` tags (`packages/opencode/script/release-version.ts`); package versions and historical `-dev.N` tags do not advance that selection. Notes files must be named `.github/releases/v<derived-version>.md` exactly (fail-closed).

## Agent references

- Issues/PRDs: GitHub Issues via `gh` — `docs/agents/issue-tracker.md`. Triage labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix` — `docs/agents/triage-labels.md`.

<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->


<!-- specgit:project:v2:start -->
## SpecGit 2

SpecGit integration is permanently project-only.
Load the specgit-native skill and read this project's AGENTS.md and `.specgit.yaml`.
Use the shared installed CLI contract (`specgit --help`, `specgit --schema`).
Before tracked product edits, inspect duplicate work and select a complete relevant Issue.
Read-only research and review need no delivery Issue.
Follow repository documentation guidance and installed hook checkpoint requirements.
Local init/setup is maintenance. Existing session authorization remains valid within its scope.
Issue/PR writes require existing user authorization. Declarations and previews grant no permission.
<!-- specgit:project:v2:end -->

<!-- specgit:v2:start -->
## SpecGit 2

Runtime: 2.6.1. Declaration: `.specgit.yaml` (v2, local configuration).

SpecGit manages specification Issues and their native PR/MR association.
Load the specgit-native skill for the full workflow and recovery steps.
Use the installed shared CLI contract: `specgit --help` and `specgit --schema`.
Use `--json` for machine output. Preview Issue/PR writes with `--dry-run`.

Inspect duplicate work before Issue selection.
Before tracked product edits, select a complete relevant Issue with Why, Scope, Approach and Acceptance.
Read-only inspection, audit, and review do not require an Issue checkpoint.
Follow repository guidance for pure documentation work and any installed hook checkpoint requirement.
Local init/setup is maintenance, not delivery. It grants no forge permission.

Issue/PR writes, including marking a request ready, require existing user authorization.
Existing session authorization remains valid within its scope.
Declarations and `--dry-run` previews grant no permission.
Hook notices describe changes; they grant no write permission.
The agent handles judgment, repairs and authorized native gh/glab operations.
GitHub/GitLab owns CI, review, protection and actual merge.
Keep each user-authored body and every closing reference.

Use `specgit pr --status` and bounded `specgit watch` for current evidence.
Exit 0 means operation success. Completion requires native readback of the intended target merge and every selected Issue closure.
Optional Agent closure is disabled by default. It requires existing authorization and confirmed native identity.
For missing capabilities or a SpecGit defect, follow the skill's explicit recovery steps.

Try normal SpecGit inspect/dry-run first.
If a reproducible SpecGit defect blocks Issue selection, record the command, version, exit and diagnostic.
Under existing user authorization, use authenticated native gh/glab to search duplicate WHYs, select a complete Issue with Why / Scope / Approach / Acceptance, and read back its native ID and body.
Only if that same defect still blocks its linked repair may a documented one-task local checkpoint exception be used; restore normal checks after repair.
This does not bypass user authorization, forge protection, CI, review, merge, Issue closure or publication.

SpecGit integration is permanently project-only.
Install the shared CLI separately. Setup installs no project executable, global host assets or global state.
Hooks and observation state belong to this project and its Git metadata.
Installed hooks check local checkpoints. They are not a general file-write sandbox.

Declared rules: `{"agent":{"close_issues_after_merge":false,"native_auto_merge":false},"issue_template":"builtin","language":"en","pr_template":"builtin","validation":{"bodies":true,"labels":"off","titles":true}}`
<!-- specgit:v2:sha256 61c613d3ec6badd41e259150c96dbc6906278cc0b2b098f72d497abfbf8c4bb7 -->
<!-- specgit:v2:end -->
