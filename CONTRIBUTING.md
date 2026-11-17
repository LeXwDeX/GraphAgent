# Contributing to GraphAgent

Thank you for helping improve GraphAgent. This page is the short version: how to set up, which checks to run and how to deliver a change. The detailed engineering rules are in the development guide, [`AGENTS.md`](./AGENTS.md), and in the nested `AGENTS.md` files inside the packages; apply the nearest one to each package you change.

## Development setup

- Requirements: Bun 1.4.4 (pinned by `packageManager` in `package.json`) and Node 26.13.0 (pinned in `.node-version`). `bun run toolchain:check` also verifies Go, which is pinned in `config_assistant/go.mod`.
- From the repository root, install the dependencies, check the toolchain and start the TUI:

  ```bash
  bun install
  bun run toolchain:check
  bun dev
  ```

- To start in a specific directory, run `bun dev <directory>`.
- To compile a standalone executable for your platform:

  ```bash
  cd packages/graphagent
  bun run build --single
  ```

  The binary is written to `packages/graphagent/dist/graphagent-<platform>/bin/graphagent`. Replace `<platform>` with your platform, for example `darwin-arm64` or `linux-x64`.

- To debug, start GraphAgent with `bun run --inspect=<url> dev` and attach your debugger to that URL. Example VS Code configurations are in [`.vscode/settings.example.json`](./.vscode/settings.example.json) and [`.vscode/launch.example.json`](./.vscode/launch.example.json); the launch example attaches to `ws://localhost:6499/`.

## Tests and checks

Run these from the repository root unless noted:

- Tests: do not run bare `bun test` or `bun run test` at the root (both are guarded). Run the `test` script inside the package you changed, for example `cd packages/graphagent && bun run test`.
- `bun run typecheck`: type-check the workspace.
- `bun run lint`: oxlint with a warning ceiling (`--max-warnings`) that only goes down. Fix warnings; never raise the ceiling.
- `bun run check:hosts`: run it before every commit. It scans tracked files and `bun.lock` for private hosts; `bun.lock` may only contain public registry URLs.
- After you change HTTP API routes, run `bun run build` in `packages/sdk/js` to regenerate the SDK.
- Formatting is Prettier with the settings in `package.json` (`semi: false`, `printWidth: 120`).

Further checks apply depending on what you change (database baseline, DAG, events, HTTP contract, UI, dependencies). They are listed in `AGENTS.md` under "Local verification scope before push / PR".

## Adding a Provider

New providers should need few code changes, if any. First open a PR to [models.dev](https://github.com/anomalyco/models.dev), the third-party catalog that GraphAgent takes its model list from.

## Issues and Pull Requests

- Open an Issue first, then the PR, and link them with `Closes #N` in the PR.
- Issue and PR titles and bodies are written in Chinese. An Issue body has the sections `原因` / `范围` / `方案` / `验收` (reason, scope, approach, acceptance). A PR body has `原因` / `变更` / `证据` / `检查清单` (reason, changes, evidence, checklist).
- Titles follow conventional-commit style, `type(issue-number): description`, for example `fix(123): 修复启动时崩溃`. The allowed types are listed in `AGENTS.md`.
- Keep PRs small and focused. Keep descriptions short and in your own words.
- UI changes: include screenshots or recordings that show before and after.
- Logic changes: explain how you verified the change, so a reviewer can reproduce it.
- Maintainers merge with merge commits only; squash and rebase merges are disabled.

The full delivery workflow is in [`AGENTS.md`](./AGENTS.md#delivery-specgit-2), under "Delivery (SpecGit 2)".

## License of Your Contribution

Contributions follow the same two-rule license model as the repository:

- Changes to files listed in [`LICENSE-UPSTREAM.txt`](./LICENSE-UPSTREAM.txt) are contributed under the upstream MIT license.
- New files and changes to fork-authored files are contributed under Apache-2.0. New source files must start with the two-line SPDX header used in the repository.

Run `bun run check:license` to check the license model, including the SPDX header of new source files.

All code in this project is authored by human contributors. AI tools are used only as assistants and are not authors. Historical `Co-Authored-By: Claude` lines in commits record that a tool was used; they are not an authorship claim and grant no rights. Future commits, pull requests, issues, and release notes must not include AI attribution or "Generated with" statements.

---

# 贡献指南

感谢你帮助改进 GraphAgent。本文是精简版：怎样搭建开发环境、提交前跑哪些检查、怎样交付改动。详细的工程规则见开发指南 [`AGENTS.md`](./AGENTS.md) 和各包内嵌套的 `AGENTS.md`；改动哪个包，就遵循离它最近的那一份。

## 开发环境

- 版本要求：Bun 1.4.4（由 `package.json` 的 `packageManager` 固定）和 Node 26.13.0（由 `.node-version` 固定）。`bun run toolchain:check` 还会检查 Go，其版本固定在 `config_assistant/go.mod`。
- 在仓库根目录安装依赖、检查工具链并启动 TUI：

  ```bash
  bun install
  bun run toolchain:check
  bun dev
  ```

- 要在指定目录启动，运行 `bun dev <directory>`。
- 为当前平台编译单机可执行文件：

  ```bash
  cd packages/graphagent
  bun run build --single
  ```

  产物位于 `packages/graphagent/dist/graphagent-<platform>/bin/graphagent`，其中 `<platform>` 换成你的平台，例如 `darwin-arm64`、`linux-x64`。

- 调试：用 `bun run --inspect=<url> dev` 启动 GraphAgent，再让调试器附加到该 URL。VS Code 的示例配置见 [`.vscode/settings.example.json`](./.vscode/settings.example.json) 和 [`.vscode/launch.example.json`](./.vscode/launch.example.json)，其中 launch 示例附加到 `ws://localhost:6499/`。

## 测试与检查

除特别说明外，都在仓库根目录运行：

- 测试：不要在根目录跑裸的 `bun test` 或 `bun run test`（两者都被拦截）。进入你改动的包，运行它自己的 `test` 脚本，例如 `cd packages/graphagent && bun run test`。
- `bun run typecheck`：对整个工作区做类型检查。
- `bun run lint`：oxlint，警告数量的上限（`--max-warnings`）只降不升。要修警告，不要调高上限。
- `bun run check:hosts`：每次提交前运行。它扫描被 Git 跟踪的文件和 `bun.lock` 里的私有主机；`bun.lock` 里只允许出现公共 registry 的 URL。
- 改动 HTTP API 路由后，在 `packages/sdk/js` 运行 `bun run build` 重新生成 SDK。
- 格式化使用 Prettier，配置在 `package.json`（`semi: false`、`printWidth: 120`）。

按改动内容还有其他检查（数据库基线、DAG、事件、HTTP 契约、UI、依赖），见 `AGENTS.md` 中 “Local verification scope before push / PR” 一节。

## 新增 Provider

新增 Provider 通常只需要很少的代码改动，甚至不需要。请先向 [models.dev](https://github.com/anomalyco/models.dev) 提 PR；GraphAgent 的模型列表来自这个第三方数据源。

## Issue 与 PR

- 先开 Issue，再开 PR，并在 PR 里用 `Closes #N` 关联。
- Issue 和 PR 的标题、正文都用中文。Issue 正文分 `原因` / `范围` / `方案` / `验收` 四节；PR 正文分 `原因` / `变更` / `证据` / `检查清单` 四节。
- 标题采用 conventional commit 风格：`type(issue号): 说明`，例如 `fix(123): 修复启动时崩溃`。可用的 type 列在 `AGENTS.md` 中。
- PR 保持小而聚焦；描述简短，用自己的话写。
- UI 改动：附上能对比改动前后的截图或录屏。
- 逻辑改动：写清你是怎么验证的，让评审者能够复现。
- 维护者只用 merge commit 合并；squash 和 rebase 合并已被禁用。

完整的交付流程见 [`AGENTS.md`](./AGENTS.md#delivery-specgit-2) 的 “Delivery (SpecGit 2)” 一节。

## 贡献的许可

你的贡献遵循与本仓库相同的两条许可规则：

- 对 [`LICENSE-UPSTREAM.txt`](./LICENSE-UPSTREAM.txt) 所列文件的改动，按上游的 MIT 许可贡献。
- 新增文件和对本项目自有文件的改动，按 Apache-2.0 贡献。新增的源文件必须以仓库中使用的两行 SPDX 头开头。

运行 `bun run check:license` 可检查许可规则，包括新增源文件的 SPDX 头。

本项目全部代码的作者是人类贡献者，AI 工具仅作为辅助工具使用。历史提交中的 `Co-Authored-By: Claude` 等署名行只表示使用过该工具，不代表作者身份，也不构成任何权利主张。今后的提交、PR、Issue 与发布说明不得包含 AI 署名或 "Generated with" 类说明。
