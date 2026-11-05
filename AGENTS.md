# AGENTS.md

Guidance for coding agents in GraphAgent, an opencode fork with a DAG workflow engine. This file records repository facts and secondary development constraints. Apply the nearest nested `AGENTS.md` to each changed package. Verify factual claims against current source, package scripts, and workflows; do not treat a development rule as proof that a check has passed.

## Scope and layout

- GraphAgent v1 is in focused maintenance, as described in `README.md`: DAG configuration, curated workflow templates, and reproducible defect fixes. Stability and data-integrity defects may receive narrow compatibility patches. Keep changes within this scope.
- Bun workspace + Turbo. Runtime pins have one source each: Bun in `package.json` (`packageManager`), Node in `.node-version`, Go in `config_assistant/go.mod`. CI and container builds read the same pins. Electron owns its embedded Node runtime; VSCode extension host types retain their own compatibility major.
- `packages/core`: DAG engine primitives (`src/dag/` — store/projector/sql, exported as `./dag/core/*` and `./dag/*`) plus DB schema/migrations ownership.
- `packages/opencode`: agent runtime. Services compose in `AppLayer` (`src/effect/app-runtime.ts`). Effect v4 (beta) rules, `makeRuntime`/`InstanceState`, tool-schema, and module-shape contracts are owned by `packages/opencode/AGENTS.md`.
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
- Use isolated sessions, temporary data, and task-owned test processes. Preserve the user's active chats, configuration, and running services. Keep credentials out of logs, fixtures, and artifacts. Security audits use model reasoning over business logic and source; do not use external DayBreak tools.

## File permission diagnosis

When a file operation is denied, record the exact action and error before changing anything:

1. Confirm the real path, owning worktree, Git status, owner, origin, and whether the target is a symlink, generated file, dependency, patch, or task-owned working copy.
2. Inspect the file and parent directory permissions, ACLs, immutable flags, mount state, and any lock and its owner, using the available platform tools. Do not disclose secrets or remove an unknown lock.
3. Distinguish an OS permission failure or accidental read-only copy from an intentional frozen snapshot, tool input validation, and an agent, approval, or sandbox policy refusal. Do not infer the cause from `PermissionDenied` alone or use a permission change to bypass a refusal.
4. If a task-owned ordinary working copy is demonstrably read-only by accident, and the intended edit and permission change are allowed, make only the necessary non-recursive permission change. For example, add owner write to a working copy that inherited `0444` from a read-only snapshot. Record the mode and content hash before and after, confirm the content is unchanged, retry the original operation, and verify the result. Preserve the frozen original.
5. For upstream SDKs, dependency caches, generated files, lockfiles, or patches, identify the owner and use the project's manifest, generator, patch, or upstream workflow. Do not directly edit a managed dependency cache or claim a permanent fix from a local permission change.
6. If ownership, the cause, or authorization remains unclear, stop the affected action and report the evidence. Do not change another person's files, protected evidence, ACLs, ownership, or system security policy, and do not switch tools or agents to bypass a denied action.

## Commands (from repo root unless noted)

- Install: `bun install`. Installs are exact-pinned; newly resolved releases must be ≥3 days old unless excluded (root `bunfig.toml`).
- Toolchain: `bun run toolchain:check` checks installed Bun, Node, and Go before runtime validation and rejects any differing runtime patch; an optional local pre-push hook may run the same check. CLI build scripts import the shared `Script` module, which checks Bun and Node. Go CI sets `GOTOOLCHAIN=local`. Rust containers read `packages/containers/rust-toolchain.toml` and verify the compiler version.
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
- If a test model is unavailable or quota-limited, continue with an available configured model from those families. This authorization is for model calls, not changing credentials or deploying services.
- For runtime fixes accepted through the installed `opencode` command, first install the local test build over `/usr/local/bin/opencode`; verify that the command actually runs this binary, its version, and matching build/install SHA-256 hashes before testing. Start a new process; see `packages/opencode/AGENTS.md` for steps. This does not apply to unit tests or `bun dev` development checks and is not a stable release.

## Development and release workflow

The general release workflow (self-hosted CI → GitHub Runner → human review → tag + GitHub Release) is defined in the maintainer's global agent instructions; this section records only project-specific requirements.

1. **Self-hosted CI.** Build the CI container image from the repository pins (base on `packages/containers/bun-node`; the run must pass `bun run toolchain:check`) and mount only the checkout or worktree under test. Its definition lives in the untracked `ci/` directory outside this repository. Run the Linux steps of the repository's CI pipeline. Windows E2E, macOS, and Nix are out of scope here and covered by the GitHub Runner. Keep fixtures and fake credentials; no real models, secrets, or user configuration.
2. **GitHub Runner.** The hosted CI of record and the final gate. Push the branch and mark the PR ready only after self-hosted CI is green. Do not spend GitHub Runner minutes iterating on failures reproducible on Linux; reproduce and fix them in self-hosted CI first. Merge per Delivery (SpecGit 2) once required checks pass. Pipeline details are defined by the pipeline configuration files in the repository; read current GitHub settings to verify which checks branch protection requires.
3. **Human review.** Happens after merge, on the build of the merged `main` commit. Artifacts are built on the development/test machine or come from the `release-fork.yml` `create_release: false` run.
4. **Tag + GitHub Release.** Publish only a `main` commit that passed the GitHub Runner and was approved in human review (see Release pipeline).

Host details live only in the maintainer's global agent instructions and the untracked `.env.hosts` at the repository root (mode `0600`, Git-ignored). Never write them into tracked files, commits, Issues, PRs, CI logs, or release notes.

### Local verification scope before push / PR

- Behavior changes: run the affected package's typecheck and focused regression tests, then the applicable gates below. Record actual commands and results. For documentation-only changes, check facts, links, formatting, and the diff; runtime tests are unnecessary.
- Database changes: from `packages/core`, run `bun run migration --check` and the affected migration tests. Include empty-database and existing-database cases.
- DAG lifecycle or persistence changes: run the DAG gate (Commands), plus affected replay, attempt, cancellation, recovery, and lease tests.
- Public event changes: run both `packages/schema/test/event-manifest.test.ts` and `packages/opencode/test/event-manifest.test.ts` from their respective packages, plus affected event consumers. Check inventories, fixed-count assertions and generated event types together; the DAG gate does not include every runtime manifest test.
- HTTP contract changes: follow Generated code below, verify both client generators are idempotent, and run `bun run test:httpapi` from `packages/opencode` with the updated scenarios. Generated-file checks compare against Git, so distinguish intended uncommitted output from unexpected regeneration drift.
- Runtime configuration changes: verify loading through `AppLayer` (`packages/opencode/src/effect/app-runtime.ts`), following the Effect and runtime contracts in `packages/opencode/AGENTS.md`.
- UI changes: exercise rendering and interaction on every affected client (TUI, app, or direct `run`), including relevant state transitions and terminal cleanup; a backend-only test is insufficient. Use package-local browser/TUI harnesses and isolated configuration.
- Dependency or toolchain changes: run `bun run toolchain:check`, affected package checks, and relevant toolchain/container/Go tests.

### Release pipeline

- `.github/workflows/release-fork.yml` manual `workflow_dispatch` from `main` is the release pipeline. Its default `create_release: false` builds and verifies artifacts. `create_release: true` publishes the stable `X.Y.Z` release and marks it Latest.
- Release versions derive from stable `graphagent-vX.Y.Z` tags (`packages/opencode/script/release-version.ts`); package versions and historical `-dev.N` tags do not advance that selection. Notes files must be named `.github/releases/v<derived-version>.md` exactly (fail-closed).
- If the primary release workflow cannot run (for example, minutes or concurrency are exhausted), the repository's fallback release pipeline may be run manually from `main` to publish the same way. Never run both for the same version.

## Generated code

- After changing HTTP API routes, regenerate both clients — CI fails on stale output: `packages/client` (`bun run generate`) and `packages/sdk/js` (`bun run build` regenerates `src/v2/gen`).
- Changing a route's request/response shape also requires updating its scenario in `packages/opencode/test/server/httpapi-exercise/index.ts`; `test:httpapi` fails on missing/skipped scenarios.

## DAG product invariants

- New workflow specs must not pin node models. Preserve historical persisted node models for compatibility. Resolution order is persisted node model → DAG tier → worker agent model → parent session model.
- Model tiers come from `dag.jsonc`. Required nodes and `review` / `review-*` workers prefer `advanced`; other nodes prefer `standard`. A single configured tier serves both.
- Keep platform delivery (issues, PRs, merge, release) out of `/dag-*` commands; use SpecGit for delivery. Built-in commands register via `packages/core/src/plugin/command.ts` and `packages/opencode/src/command/index.ts`; user commands shadow builtins by name.

## Delivery (SpecGit 2)

- SpecGit is a shared user-level CLI; resolve its version and contract with `specgit --version`, `specgit --help`, and `specgit --schema`. The declaration `.specgit.yaml` is local, per-checkout configuration (Git-excluded, not tracked). Initialize or refresh each checkout or worktree with `specgit init --provider github --remote origin --target main --language zh --native-auto-merge false` and `specgit setup --agent generic --agent opencode --opencode-claude-hooks --hook-purpose guard --hook-purpose context` (generic owns the `AGENTS.md` entry; this fork's opencode uses Claude-compatible hooks; Claude Code reads `AGENTS.md` directly); both are maintenance and refresh their owned blocks below. Keep `AGENTS.md` as the only guidance entry: do not create `CLAUDE.md` (SpecGit's asset layer rejects a symlinked or non-regular `CLAUDE.md`). Set `validation.labels: kind` in `.specgit.yaml` so each Issue/PR gets one `kind::<type>` label derived from its title; all 14 kinds are enabled: `feat`, `fix`, `refactor`, `perf`, `docs`, `test`, `chore`, `style`, `build`, `ci`, `revert`, `security`, `deprecate`, `dogfood` (use `--create-labels` if the forge lacks them). Set `validation.titles: true` and `validation.bodies: true`; Issue and PR titles and bodies are written in Chinese. Issue sections are `原因` / `范围` / `方案` / `验收`; PR sections are `原因` / `变更` / `证据` / `检查清单`.
- `.specgit.yaml`, `.agents/skills/specgit-native/SKILL.md`, and `.opencode/hooks.json` are covered by SpecGit's local exclusion or `.gitignore`. Claude Code context hooks are local custom glue in `.claude/settings.json` (SessionStart/PreToolUse call `specgit hook`); keep it Git-ignored and treat it as agent-maintained because SpecGit does not refresh it. The opencode fork keeps its SpecGit-managed hooks in `.opencode/hooks.json`; both hook transports are compatible with the `AGENTS.md` entry and the fixed Skill.
- Track only project code, tests, build/CI configuration, current user-facing and architecture/domain documentation, and `AGENTS.md` files. Keep local agent scaffolding (`.opencode/`, `.husky/`, `.agents/`, `.claude/`, `.serena/`, SpecGit-generated assets), generated state, dated audits/evidence/plans, obsolete specs and prototypes, screenshots, and local debug scripts untracked. The matching ignore rules live in `.gitignore` and nested `.gitignore` files; do not re-add these paths without an explicit policy change.
- `main` is the only long-lived integration branch, the protected branch, the only delivery target, and the CI push target. Create Issues and PRs directly against `main`; do not introduce `dev` or another staging branch. Branch from `main` and delete the delivery branch after merge.
- Track complete 原因/范围/方案/验收 Issues with `specgit issue`, aggregate with `specgit pr` (created as a draft, then `specgit pr --ready`), and observe native evidence with `specgit pr --status` / bounded `specgit watch`. Branch names remain `{type}/short-name`. Parallel deliveries use separate worktrees; each worktree keeps its own checkpoint.
- GitHub owns acceptance and merge. Merge with merge commits only (`gh pr merge --merge`); squash and rebase merges are disabled because they break branch and worktree tracking. Verify the current PR head and actual native requirements; check merge state and linked Issue closure separately. Never weaken required checks to complete delivery. When the maintainer explicitly directs a direct merge for a documentation or local-only change, record that direction in the PR and merge without waiting for CI; this is a maintainer exception, not a default.
- Automatic merge and supplementary Issue closure default off. Native `gh` operations require user authorization from the current task; configuration grants none.

## Agent references

- Issues/PRDs live in GitHub Issues; use `gh issue create/view/list/comment/edit/close` from the repository root. Pull requests are delivery artifacts, not incoming requests. Triage labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`.

<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->


<!-- specgit:project:v2:start -->
## SpecGit 2

Read project-root `.agents/skills/specgit-native/SKILL.md` before work; if missing, initialize with the shared `specgit init` CLI or restore an existing integration with `specgit setup` ([installation](https://github.com/LeXwDeX/SpecGit/blob/main/docs/agent-install.md)).
<!-- specgit:project:v2:end -->
