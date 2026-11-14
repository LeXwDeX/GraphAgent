// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

export * as PrWatchAuto from "./auto"

import { Cause, Effect, Option } from "effect"
import { PrWatchPoller } from "./poller"
import { parseRequest } from "./forge"

/**
 * Auto-registration of PR watches (#1071 PR4).
 *
 * The retired design made users configure a PostToolUse hook that ran a
 * separate `pr-watch` script after `gh pr create`. The tool pipeline now calls
 * this built-in subscriber at its own PostToolUse seam, so the watch needs no
 * user hook and no extra process. It is deliberately narrow: one tool id
 * (`bash`), one successful command shape (`gh pr create`, exit 0), a URL in
 * the command's own output (never a replayed command), and a root session —
 * `watch_pr` is ROOT_ONLY, so a child session must not create a durable watch.
 */

/** The model-facing result fields the subscriber needs; no tool-layer types. */
export interface ToolOutcome {
  readonly toolID: string
  readonly command: string | undefined
  readonly exit: number | undefined
  readonly output: string | undefined
  readonly sessionID: string
  /** A child session (`parentID` set) never auto-registers. */
  readonly parentID: string | undefined
}

// `gh pr create` prints the request URL; the output may also carry the shell
// footer and banners, so every https token is tried and the first one that
// parses as a supported GitHub/GitLab request wins.
const URL_PATTERN = /https:\/\/[^\s"'<>]+/g

/**
 * Splits a command line into the simple-command segments a shell would run,
 * with quoting removed. Only the shape recognition needs: unquoted whitespace
 * separates words, quotes group (and hide their content from the command
 * position), and `&&`, `||`, `|`, `&`, `;` and newlines start a new segment.
 * `undefined` for an unterminated quote: an ambiguous command never counts.
 */
function commandSegments(command: string): string[][] | undefined {
  const segments: string[][] = []
  let words: string[] = []
  let word = ""
  let quote: "'" | '"' | undefined
  let started = false
  const endWord = () => {
    if (!started) return
    words.push(word)
    word = ""
    started = false
  }
  const endSegment = () => {
    endWord()
    if (words.length > 0) segments.push(words)
    words = []
  }
  for (let index = 0; index < command.length; index++) {
    const char = command[index]
    if (quote !== undefined) {
      if (char === quote) quote = undefined
      else if (char === "\\" && quote === '"' && index + 1 < command.length) word += command[++index]
      else word += char
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      started = true
      continue
    }
    if (char === "\\" && index + 1 < command.length) {
      word += command[++index]
      started = true
      continue
    }
    if (char === "&" || char === "|" || char === ";" || char === "\n") {
      endSegment()
      continue
    }
    if (/\s/.test(char)) {
      endWord()
      continue
    }
    word += char
    started = true
  }
  if (quote !== undefined) return undefined
  endSegment()
  return segments
}

/**
 * True when one simple command of the line actually runs `gh pr create`. The
 * command position is what counts: the same words inside a quoted argument
 * (`printf ... 'gh pr create'`) are data, not a create.
 */
function runsPrCreate(command: string): boolean {
  const segments = commandSegments(command)
  if (!segments) return false
  return segments.some((words) => words[0] === "gh" && words[1] === "pr" && words[2] === "create")
}

/**
 * The request a successful `gh pr create` announced, or undefined when this
 * call is not one. Recognition reads the completed command and its exit code;
 * the target comes only from the output.
 */
export function createdRequest(command: string | undefined, exit: number | undefined, output: string | undefined) {
  if (command === undefined || exit !== 0 || output === undefined) return undefined
  if (!runsPrCreate(command)) return undefined
  for (const match of output.matchAll(URL_PATTERN)) {
    try {
      return parseRequest(match[0])
    } catch {
      // Not a watchable request URL: keep looking for the real one.
    }
  }
  return undefined
}

/**
 * The built-in PostToolUse subscriber: registers the created request durably
 * and returns. Registration failures are logged, never surfaced into the tool
 * result that already succeeded.
 */
export const afterTool = Effect.fn("PrWatchAuto.afterTool")(function* (input: ToolOutcome) {
  if (input.toolID !== "bash" || input.parentID !== undefined) return
  const request = createdRequest(input.command, input.exit, input.output)
  if (!request) return
  const poller = Option.getOrUndefined(yield* Effect.serviceOption(PrWatchPoller.Service))
  if (!poller) return
  yield* poller.register({ sessionID: input.sessionID, request }).pipe(
    Effect.catchCause((cause: Cause.Cause<never>) =>
      Cause.hasInterrupts(cause)
        ? Effect.failCause(cause)
        : Effect.logWarning("pr watch auto-registration failed", {
            sessionID: input.sessionID,
            url: request.url,
            cause: Cause.pretty(cause),
          }),
    ),
  )
})