# Repository CI watcher

Install this checkout's default hook configuration once:

```sh
bun .opencode/hooks/install-ci-watcher.ts
```

The tracked `ci-watcher.template.json`, `watch-ci.ts`, installer, and `/watch-ci` command define the repository default. The installer merges only handlers marked `options.repoCiWatcher=v1` into **local, Git-ignored `.opencode/hooks.json`**, preserving other events and user handlers. Repeating installation is safe. Invalid JSON or an edit detected before replacement aborts without overwriting the file. Installers are serialized, but external editors do not share that lock: avoid editing the file during installation, since an edit between the last check and replacement cannot be detected. The template is not a replacement for the user's configuration. Run the installer again after updating this template. Bun and an authenticated `gh` must already be on PATH.

After installation, a successful Bash tool invocation beginning with `gh pr create` and returning an HTTPS PR URL starts a background watcher automatically. SessionStart injects concise usage guidance. Start a new session for that guidance; the hook file is hot-reloaded. For an existing PR, a new head, or compound commands such as `cd repo && gh pr create`, use `/watch-ci [PR]`. Its request helper resolves the URL read-only, and the same PostToolUse handler starts the watcher. Direct terminal executions outside an agent tool do not trigger agent hooks.

The watcher polls `gh pr view` and `gh pr checks` every **45 seconds**, for at most **45 minutes** (plus bounded query completion). Each CLI query is capped at 10 seconds; the hook's 2,800-second outer timeout leaves cleanup and notification time. Empty check lists remain pending, not successful. It waits for all observed checks to settle; failed or cancelled checks produce failure. Head changes stop the old watcher with a superseded result. The head is checked again before a final success/failure, but no external polling scheme can prevent a push immediately after that read. The main agent must verify current-head required checks before merging.

On success, failure, timeout, or unavailable/superseded state, the command writes a bounded summary to stderr and exits **2**. The existing `asyncRewake` mechanism routes that result to the **originating session**, without blocking the tool call. No check logs, credentials, or tool command text are stored. A failure notification contains counts, PR number, head SHA, and URL; inspect detailed failures separately. Polling errors are retried three times. The watcher never pushes, merges, or changes GitHub settings.

Locks live in the session scratchpad's `pr-ci-watch/` directory and are keyed by validated PR URL + head SHA. This deliberately deduplicates within the originating session; separate sessions may monitor the same PR for their own results. Success/failure receipts suppress later duplicate delivery for that head in that session. Timeout/unavailable results are retryable. Dead owners can be reclaimed, while live or initializing owners are never stolen. No hook protocol can guarantee exactly-once delivery across a crash between writing a receipt and delivering its callback.

SessionEnd, cancellation, and instance disposal use the existing asynchronous-hook process supervision. The template uses structured `args`, not a shell, so the watcher is a direct child of the host. It checks its parent's identity/liveness every second; if the host crashes, it aborts its current GitHub query, releases its lock where possible, and exits. The integration tests kill a synthetic host and verify both watcher and query exit. This is bounded self-cleanup, not an OS-level survival guarantee: SIGKILL of the watcher itself, a frozen process, or an OS failure can prevent cleanup. While the supervisor is running, every query and watch has its own timeout; stale lock directories can be removed after verifying the recorded owner PID is dead. A crash precisely during stale-lock reclamation may leave a `.reap` directory, which requires the same dead-owner inspection before removal. Never run this watcher with `nohup`, a shell that detaches it, or a daemon launcher.

Tests use isolated scratchpads, short injected timeouts, and a fake local `gh` executable. They make no remote writes:

```sh
cd packages/opencode
bun run test test/hook/repo-ci-watcher.test.ts
```
