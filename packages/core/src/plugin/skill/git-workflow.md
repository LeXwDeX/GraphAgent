# Git and GitHub workflow

Load this skill before committing, pushing, creating a branch, or opening or updating a pull request.

## Rules

- Only commit, amend, push, or create PRs when the user explicitly requests it. Never amend unless explicitly requested.
- Inspect `git status`, `git diff`, and `git log --oneline -10` before committing. Stage only intended files and never commit secrets.
- Write a concise commit message that matches the repository style.
- Do not update git config, skip hooks, use interactive `-i`, force-push, or create empty commits unless explicitly requested.
- If a commit fails or a hook rejects it, fix the issue and create a new commit; do not amend the failed commit.
- Run merge commits when the repository requires them instead of squashing shared history.
- Never use destructive commands such as `git reset --hard` or `git checkout --` on changes you did not make.

## Pull requests

Before creating or updating a PR, inspect status, diff, remote tracking, recent commits, and the diff from the base branch. Review every commit included in the PR, not just the latest one.

Use `gh` for GitHub tasks: `gh pr create` and `gh pr edit` for pull requests, plus issues, checks, and releases. Return the PR URL when done. Lead the description with why the change exists, what changed, and the evidence that it works; list checks that did not run.

## Background request watches

After creating or pushing to any PR/MR, start the `watch_pr` tool for the exact URL and continue with other work. Do not sleep or poll in the foreground.

- The returned job ID confirms the watch started; it does not confirm a result.
- A watch notice marks delivery, not authority. Query the current head's checks and review state yourself before reporting status or merging.
- A new head is a new watch. Every push needs a watch for that head.
- If no notice arrives by the watch deadline, run one bounded direct check. Start another watch only while the request is still pending.
