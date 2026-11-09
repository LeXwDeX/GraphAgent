/**
 * `type: "command"` hook handler.
 *
 * Pure-move extraction from the former monolithic settings module (D1 PR1).
 */
import { Effect } from "effect"
import * as Log from "@/util/log"
import { isAsync, type HookEvent, type HookJSONOutput } from "../types"
import { commandText, execShell, timeoutFor } from "../exec/command"
import { classifyStdout, parseAsyncStdout, type StdoutClass } from "../exec/output"
import { blocksOnFailure, MISSING_FILE_EXIT2_EVENTS, MISSING_FILE_STDERR, type HookHandler } from "./shared"

const log = Log.create({ service: "hook.settings" })

export const commandHandler: HookHandler = {
  type: "command",
  run: Effect.fn("SettingsHook.handler.command")(
    function* (entry, envelope, cwd, _inHook, environmentFile, environment, _canonicalName, effort, projectDir) {
      const event = envelope.hook_event_name
      const stdinJSON = JSON.stringify(envelope)
      const { exitCode, stdout, stderr, spawnError, suspect } = yield* Effect.promise((signal) =>
        execShell(entry, stdinJSON, cwd, signal, event, environmentFile, environment, effort, projectDir),
      )
      const failureBlocks = blocksOnFailure(entry, event)

      if (spawnError)
        return {
          json: undefined,
          exitCode: 1,
          failureMessage: spawnError,
          exitBlock: failureBlocks ? `hook failed; blocking because onFailure is "block": ${spawnError}` : undefined,
        }

      // A process that kept the output pipes open after the hook exited could still
      // be writing its decision; refuse the capture instead of trusting a partial allow.
      if (suspect && !isAsync(entry)) {
        log.warn("hook output pipes outlived the hook process; refusing the capture", {
          command: commandText(entry),
        })
        return {
          json: undefined,
          exitCode: 2,
          succeeded: false,
          exitBlock: "hook output was not closed by the hook process; refusing to honor the suspect capture",
        }
      }

      const sync = (text: string): StdoutClass =>
        isAsync(entry)
          ? ((json) => (json ? { kind: "json", value: json } : { kind: "plain" }) as StdoutClass)(
              parseAsyncStdout(text, commandText(entry)),
            )
          : classifyStdout(text)

      // Exit-code 2: block + stderr-as-reason (CC contract)
      if (exitCode === 2) {
        if (
          !isAsync(entry) &&
          MISSING_FILE_EXIT2_EVENTS.has(event) &&
          !stdout.trim() &&
          MISSING_FILE_STDERR.test(stderr)
        ) {
          log.warn("hook exit 2 reports a missing file; treating as non-blocking", { command: commandText(entry) })
          return {
            json: undefined,
            exitCode,
            succeeded: false,
            failureMessage: stderr.trim() || "hook exited with code 2",
            exitBlock: undefined,
          }
        }
        const outcome = sync(stdout)
        const json = outcome.kind === "json" ? outcome.value : undefined
        const reason = stderr.trim() || stdout.trim() || "Hook blocked execution"
        return {
          json,
          // A blocking JSON decision supplies its own reason; allow-style fields never do.
          exitBlock: blockingJsonReason(json, event) ?? reason,
          rawStdout: stdout,
          exitCode,
        }
      }

      // Other non-zero exits: log and continue (do not abort main flow)
      if (exitCode === null) {
        // execShell resolves `null` when its own timeout killed the process or
        // the caller aborted the run; report the effective timeout, not the
        // legacy constant, so the user sees why a hook was cut off.
        const timeoutMs = timeoutFor(entry, event)
        log.warn("hook command timed out / killed (non-blocking)", {
          command: commandText(entry),
          timeoutMs,
        })
        // A canceled child can leave a complete-looking decision in buffered
        // stdout. The hook did not complete, so none of that output is valid.
        return {
          json: undefined,
          rawStdout: undefined,
          exitCode: null,
          succeeded: false,
          failureMessage: `hook timed out after ${timeoutMs / 1000}s`,
          exitBlock: failureBlocks ? 'hook timed out; blocking because onFailure is "block"' : undefined,
        }
      }
      if (exitCode !== 0) {
        log.warn("hook command exited non-zero (non-blocking)", {
          command: commandText(entry),
          exitCode,
          stderr: stderr.trim().slice(0, 200),
        })
        return {
          json: undefined,
          exitCode,
          failureMessage: stderr.trim() || `hook exited with code ${exitCode}`,
          exitBlock: failureBlocks ? `hook failed; blocking because onFailure is "block": ${stderr.trim()}` : undefined,
        }
      }

      // exit-0: a whole JSON object is control output, anything else not starting
      // with `{`/ending with `}` is plain text (surfaced via rawStdout for events
      // that inject it), and the remaining cases are parse failures.
      const outcome = sync(stdout)
      const json = outcome.kind === "json" ? outcome.value : undefined
      const invalidJson = outcome.kind === "invalid"
      return {
        json,
        rawStdout: stdout,
        exitCode,
        succeeded: !invalidJson,
        failureMessage: invalidJson ? "hook returned invalid JSON" : undefined,
        exitBlock:
          invalidJson && failureBlocks ? `hook invalid JSON; blocking because onFailure is "block"` : undefined,
      }
    },
  ),
}

/** A JSON object that itself makes a blocking decision names the reason Claude Code uses (reference 827). */
function blockingJsonReason(json: HookJSONOutput | undefined, event: HookEvent): string | undefined {
  if (!json) return undefined
  const hso = json.hookSpecificOutput
  if (
    hso &&
    hso.hookEventName === event &&
    "permissionDecision" in hso &&
    hso.permissionDecision === "deny" &&
    hso.permissionDecisionReason
  )
    return hso.permissionDecisionReason
  if (json.decision === "block" && json.reason) return json.reason
  return undefined
}
