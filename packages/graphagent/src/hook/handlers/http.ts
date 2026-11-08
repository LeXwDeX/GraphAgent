/**
 * `type: "http"` hook handler and HTTP destination policy.
 *
 * Pure-move extraction from the former monolithic settings module (D1 PR1).
 */
import { Cause, Effect, Option } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import * as Log from "@/util/log"
import type { HookCommand, HookEnvelope } from "../types"
import { commandText, httpUrl, timeoutFor } from "../exec/command"
import { classifyHttpBody } from "../exec/output"
import { blocksOnFailure, hookFailureText, type HookHandler } from "./shared"

const log = Log.create({ service: "hook.settings" })

function httpHeaders(entry: HookCommand): Record<string, string> {
  const allowed = new Set(entry.allowedEnvVars ?? [])
  return Object.fromEntries(
    Object.entries(entry.headers ?? {}).map(([name, value]) => [
      name,
      value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_match, braced, bare) => {
        const key = braced ?? bare
        return allowed.has(key) ? (process.env[key] ?? "") : ""
      }),
    ]),
  )
}

export function httpHookUrlAllowed(url: string, allowed: readonly string[] | undefined): boolean {
  if (allowed === undefined) return true
  return allowed.some((pattern) => {
    const regex = `^${pattern
      .split("*")
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*")}$`
    try {
      return new RegExp(regex).test(url)
    } catch {
      return false
    }
  })
}

/**
 * `type: "http"` handler. Per CC protocol, `url` (legacy: `command`) is the
 * endpoint; the envelope is POSTed once as JSON with `headers` after `$VAR` /
 * `${VAR}` interpolation restricted to `allowedEnvVars` (unlisted variables
 * become ""). Timeout comes from `timeoutFor` (600 s default; `timeout`
 * overrides).
 *
 * 2xx empty body → success with no output. 2xx JSON object → parsed with the
 * same HookOutputSchema as command stdout; a schema mismatch is a non-blocking
 * error. 2xx with any other body (plain text, array, multiple JSON lines) →
 * non-blocking error; the text is never injected into context.
 *
 * Non-2xx, connection failure and timeout → non-blocking error (exitCode 1;
 * null on timeout, output discarded). `onFailure: "block"` on a foreground,
 * non-exempt event is the only path that turns them into a synthetic
 * `exitBlock`. There is no retry: one POST per trigger. Hooks must never crash
 * the host.
 *
 * The handler is a plain HookHandler that resolves HttpClient per run via
 * Effect.serviceOption, so `run` stays `R = never` (the WP-4A interface
 * contract); it is registered once in the handler map below.
 */
export const httpHandler: HookHandler = {
  type: "http",
  run: Effect.fn("SettingsHook.handler.http")(function* (entry, envelope, _cwd, _inHook) {
    const http = Option.getOrUndefined(yield* Effect.serviceOption(HttpClient.HttpClient))
    if (!http) {
      log.warn("http hook skipped: HttpClient not in context", { command: commandText(entry) })
      return { json: undefined, exitBlock: undefined }
    }
    const timeoutMs = timeoutFor(entry, envelope.hook_event_name)

    const url = httpUrl(entry)
    const exit = yield* HttpClientRequest.post(url).pipe(
      HttpClientRequest.setHeaders(httpHeaders(entry)),
      HttpClientRequest.bodyJson(envelope),
      Effect.flatMap((req) => http.execute(req)),
      Effect.flatMap((res) =>
        Effect.gen(function* () {
          const text = yield* res.text
          return { status: res.status, text }
        }),
      ),
      Effect.timeout(timeoutMs),
      Effect.exit,
    )

    if (exit._tag === "Failure") {
      log.warn("http hook request failed (non-blocking)", {
        command: url,
        error: String(exit.cause),
      })
      return {
        json: undefined,
        exitCode: Cause.isTimeoutError(Option.getOrUndefined(Cause.findErrorOption(exit.cause))) ? null : 1,
        failureMessage: hookFailureText(exit.cause),
        exitBlock: blocksOnFailure(entry, envelope.hook_event_name)
          ? `http hook failed; blocking because onFailure is "block"`
          : undefined,
      }
    }

    const { status, text } = exit.value
    if (status < 200 || status >= 300) {
      return {
        json: undefined,
        exitCode: 1,
        failureMessage: `hook returned status ${status}`,
        exitBlock: blocksOnFailure(entry, envelope.hook_event_name)
          ? `http hook returned status ${status}; blocking because onFailure is "block"`
          : undefined,
      }
    }
    const body = classifyHttpBody(text)
    if (body.kind === "empty") return { json: undefined, succeeded: true }
    const json = body.kind === "json" ? body.value : undefined
    return {
      json,
      succeeded: !!json,
      failureMessage: json ? undefined : "hook returned invalid JSON",
      exitBlock:
        !json && blocksOnFailure(entry, envelope.hook_event_name)
          ? `http hook invalid JSON; blocking because onFailure is "block"`
          : undefined,
    }
  }),
}
