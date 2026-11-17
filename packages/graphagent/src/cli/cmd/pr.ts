import { Effect } from "effect"
import { APP_NAME } from "@graphagent/core/brand"
import { UI } from "../ui"
import { effectCmd, fail } from "../effect-cmd"
import { Git } from "@/git"
import { InstanceRef } from "@/effect/instance-ref"
import { Process } from "@/util/process"
import { t } from "@graphagent/tui/i18n"

export const PrCommand = effectCmd({
  command: "pr <number>",
  describe: t("cli.pr.describe"),
  builder: (yargs) =>
    yargs.positional("number", {
      type: "number",
      describe: t("cli.pr.arg.number"),
      demandOption: true,
    }),
  handler: Effect.fn("Cli.pr")(function* (args) {
    const ctx = yield* InstanceRef
    if (!ctx) return yield* fail(t("cli.pr.noInstance"))
    if (ctx.project.vcs !== "git") {
      return yield* fail(t("cli.pr.noGitRepo"))
    }

    const git = yield* Git.Service
    const worktree = ctx.worktree

    const prNumber = args.number
    const localBranchName = `pr/${prNumber}`
    UI.println(t("cli.pr.fetching", { number: prNumber }))

    const checkout = yield* Effect.promise(() =>
      Process.run(["gh", "pr", "checkout", `${prNumber}`, "--branch", localBranchName, "--force"], { nothrow: true }),
    )
    if (checkout.code !== 0) {
      return yield* fail(t("cli.pr.checkoutFailed", { number: prNumber }))
    }

    const prInfoResult = yield* Effect.promise(() =>
      Process.text(
        [
          "gh",
          "pr",
          "view",
          `${prNumber}`,
          "--json",
          "headRepository,headRepositoryOwner,isCrossRepository,headRefName,body",
        ],
        { nothrow: true },
      ),
    )

    let sessionId: string | undefined

    if (prInfoResult.code === 0 && prInfoResult.text.trim()) {
      const prInfo = JSON.parse(prInfoResult.text)

      if (prInfo?.isCrossRepository && prInfo.headRepository && prInfo.headRepositoryOwner) {
        const forkOwner = prInfo.headRepositoryOwner.login
        const forkName = prInfo.headRepository.name
        const remoteName = forkOwner

        const remotes = (yield* git.run(["remote"], { cwd: worktree })).text().trim()
        if (!remotes.split("\n").includes(remoteName)) {
          yield* git.run(["remote", "add", remoteName, `https://github.com/${forkOwner}/${forkName}.git`], {
            cwd: worktree,
          })
          UI.println(t("cli.pr.addedRemote", { remote: remoteName }))
        }

        yield* git.run(["branch", `--set-upstream-to=${remoteName}/${prInfo.headRefName}`, localBranchName], {
          cwd: worktree,
        })
      }

      if (prInfo?.body) {
        const sessionMatch = prInfo.body.match(/https:\/\/opncd\.ai\/s\/([a-zA-Z0-9_-]+)/)
        if (sessionMatch) {
          const sessionUrl = sessionMatch[0]
          UI.println(t("cli.pr.foundSession", { url: sessionUrl }))
          UI.println(t("cli.pr.importing"))

          const importResult = yield* Effect.promise(() =>
            Process.text([APP_NAME, "import", sessionUrl], { nothrow: true }),
          )
          if (importResult.code === 0) {
            // Matches the English `Imported session: <id>` line, which `import` never translates.
            const sessionIdMatch = importResult.text.trim().match(/Imported session: ([a-zA-Z0-9_-]+)/)
            if (sessionIdMatch) {
              sessionId = sessionIdMatch[1]
              UI.println(t("cli.pr.imported", { sessionId }))
            }
          }
        }
      }
    }

    UI.println(t("cli.pr.checkedOut", { number: prNumber, branch: localBranchName }))
    UI.println()
    UI.println(t("cli.pr.starting"))
    UI.println()

    const graphagentArgs = sessionId ? ["-s", sessionId] : []
    const code = yield* Effect.promise(
      () =>
        Process.spawn([APP_NAME, ...graphagentArgs], {
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit",
          cwd: process.cwd(),
        }).exited,
    )
    // Match legacy throw semantics — propagate as a defect so the top-level
    // index.ts catch handles it identically (exit 1, "Unexpected error" banner).
    if (code !== 0) return yield* Effect.die(new Error(t("cli.pr.exited", { code })))
  }),
})
