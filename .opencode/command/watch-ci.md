---
description: Start the repository's background CI watcher for a PR or the current branch
---

Watch CI for `$ARGUMENTS` (omit the argument to use the current branch's PR).

1. Ensure the repository watcher is installed with `bun .opencode/hooks/install-ci-watcher.ts`. This merges its two owned handlers into ignored `.opencode/hooks.json`, preserving user hooks. Do not replace that file with the template.
2. Run `bun .opencode/hooks/watch-ci.ts request <PR>` through the Bash tool; omit `<PR>` when no argument was supplied. Accept only a PR number or an HTTPS PR URL on the configured GitHub host. Pass it as a literal argument, never interpolate arbitrary user text into shell syntax.
3. The successful helper prints a validated `OPENCODE_CI_WATCH` URL. The PostToolUse hook starts a background watcher and returns immediately. Tell the user it is running, then continue useful work without starting another foreground watch.
4. On its result, inspect the exact reported head. Repair failing checks within the task scope and use this command again after pushing a new head. A timeout or unavailable result permits another attempt. Required-check acceptance and merge remain the main agent's responsibility; this helper never merges.

A successful direct `gh pr create ...` invocation already starts this watcher when installed. Use this command for existing PRs, changed heads, or creation through compound commands/wrappers. Repeated requests for an active or successfully reported PR/head in the same session are deduplicated.
