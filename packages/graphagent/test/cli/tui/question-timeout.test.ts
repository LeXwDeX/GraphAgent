// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { expect } from "bun:test"
import { Cause, Effect, Exit } from "effect"
import { createServer } from "node:net"
import { chmod, mkdir, mkdtemp } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { artifactCliTarget, sourceCliTarget, withCliFixture } from "../../lib/cli-process"
import { it } from "../../lib/effect"
import { reply } from "../../lib/llm-server"
import { createTuiProcess, type TuiProcess } from "../../lib/tui-process"

const artifactExecutable = process.env.GRAPHAGENT_TEST_ARTIFACT_EXECUTABLE
const sourceEnabled = process.env.GRAPHAGENT_TEST_TUI_SOURCE === "1"
const enabled = !!artifactExecutable || sourceEnabled
const target = artifactExecutable ? artifactCliTarget(artifactExecutable) : sourceCliTarget
const run = enabled ? it.live : it.live.skip

const TIMEOUT_QUESTION = "QUESTION_TIMEOUT_WITHOUT_INPUT"
const NAV_FIRST = "QUESTION_NAVIGATION_FIRST"
const NAV_SECOND = "QUESTION_NAVIGATION_SECOND"
const PARTIAL_QUESTION = "QUESTION_PARTIAL_ANSWER_IDLE"
const SELECT_QUESTION = "QUESTION_SELECTION_CANCELS_TIMEOUT"
const CUSTOM_QUESTION = "QUESTION_CUSTOM_FOCUS_CANCELS_TIMEOUT"
const DISMISS_QUESTION = "QUESTION_DISMISS_WITHOUT_ANSWER"
const FINAL_DONE = "QUESTION_TIMEOUT_TUI_FINAL_DONE"
const CUSTOM_ANSWER = "custom answer from the user"
const RESUMED_ACTION_RESULT = "QUESTION_TIMEOUT_RESUMED_READ"
const COUNTDOWN = /Timeout in \d+s/

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") throw new Error(`expected object, got ${String(value)}`)
  return value as Record<string, unknown>
}

function isTitleRequest(value: Record<string, unknown>) {
  return JSON.stringify(value).includes("Generate a title for this conversation")
}

function latestToolContent(value: Record<string, unknown>) {
  const messages = Array.isArray(value.messages) ? value.messages : []
  const tool = messages.toReversed().find((item) => record(item).role === "tool")
  const content = tool ? record(tool).content : undefined
  if (typeof content !== "string") throw new Error(`expected latest tool result in ${JSON.stringify(value)}`)
  return content
}

async function waitForScreen(
  tui: TuiProcess,
  description: string,
  predicate: (screen: string) => boolean,
  timeoutMs = 15_000,
) {
  const started = Date.now()
  for (;;) {
    const screen = tui.screen()
    if (predicate(screen)) return screen
    if (Date.now() - started >= timeoutMs) {
      throw new Error(`timed out waiting for ${description}\nCurrent screen:\n${screen}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

async function freePort() {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("failed to reserve a loopback port")
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  return address.port
}

async function evidenceDirectory() {
  const configured = process.env.GRAPHAGENT_TEST_TUI_EVIDENCE_DIR
  if (configured) {
    if (!path.isAbsolute(configured)) throw new Error(`TUI evidence directory must be absolute: ${configured}`)
    const dir = path.join(configured, "question-timeout")
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await chmod(dir, 0o700).catch(() => {})
    return dir
  }
  const created = await mkdtemp(path.join(os.tmpdir(), "graphagent-question-timeout-tui-"))
  await chmod(created, 0o700)
  process.stderr.write(`[tui-evidence] ${created}\n`)
  return created
}

function question(question: string, multiple = false) {
  return {
    question,
    header: question.slice(0, 24),
    options: [
      { label: "Use defaults (Recommended)", description: "Continue with the default choice" },
      { label: "Inspect first", description: "Inspect the available evidence first" },
    ],
    multiple,
  }
}

run(
  "times out without input, ignores navigation, and accepts answers after interaction",
  () =>
    withCliFixture(
      ({ env, home, llm, target: resolvedTarget }) =>
        Effect.gen(function* () {
          let checkpoint = "fixture-ready"
          const resumedActionFile = path.join(home, "question-timeout-resumed.txt")
          const config = {
            ...record(JSON.parse(env.GRAPHAGENT_CONFIG_CONTENT ?? "{}")),
            question_timeout: 2,
            permission: { external_directory: { [path.join(home, "*")]: "allow" } },
          }
          yield* Effect.promise(() => Bun.write(resumedActionFile, RESUMED_ACTION_RESULT))

          yield* llm.push(
            reply().tool("question", { questions: [question(TIMEOUT_QUESTION)] }),
            reply().tool("read", { filePath: resumedActionFile }),
            reply().tool("question", { questions: [question(NAV_FIRST), question(NAV_SECOND)] }),
            reply().tool("question", { questions: [question(PARTIAL_QUESTION, true)] }),
            reply().tool("question", { questions: [question(SELECT_QUESTION, true)] }),
            reply().tool("question", { questions: [question(CUSTOM_QUESTION)] }),
            reply().tool("question", { questions: [question(DISMISS_QUESTION)] }),
            reply().text(FINAL_DONE).stop(),
          )

          const port = yield* Effect.promise(freePort)
          const evidenceDir = yield* Effect.promise(evidenceDirectory)
          const tui = yield* Effect.promise(() =>
            createTuiProcess({
              target: resolvedTarget,
              args: [
                home,
                "--model",
                "test/test-model",
                "--prompt",
                "Trigger the scripted question flow",
                "--hostname",
                "127.0.0.1",
                "--port",
                String(port),
              ],
              cwd: home,
              env: { ...env, GRAPHAGENT_CONFIG_CONTENT: JSON.stringify(config) },
              evidenceDir,
              cols: 120,
              rows: 40,
            }),
          )
          yield* Effect.addFinalizer((exit) =>
            Effect.promise(() =>
              tui.close({
                checkpoint,
                ...(Exit.isFailure(exit)
                  ? {
                      failure: Cause.prettyErrors(exit.cause).map((error) => ({
                        name: error.name,
                        message: error.message,
                        stack: error.stack,
                      })),
                    }
                  : {}),
              }),
            ).pipe(Effect.ignore),
          )

          yield* Effect.promise(() => tui.waitForText(TIMEOUT_QUESTION, 30_000))
          yield* Effect.promise(() =>
            waitForScreen(tui, "initial question countdown", (screen) => COUNTDOWN.test(screen)),
          )
          checkpoint = "initial-countdown-visible"
          yield* Effect.promise(() => tui.waitForText(NAV_FIRST, 10_000))

          const afterFirstTimeout = (yield* llm.inputs).filter((input) => !isTitleRequest(input))
          expect(afterFirstTimeout).toHaveLength(3)
          const firstContinuation = latestToolContent(afterFirstTimeout[1])
          expect(firstContinuation).toContain("The user is temporarily away from the computer and did not answer")
          expect(firstContinuation).toContain("Choose the best solution yourself")
          expect(firstContinuation).toContain('fallback candidate: "Use defaults (Recommended)"')
          expect(firstContinuation).toContain("recommendation, not a restriction")
          expect(firstContinuation).toContain("Silence never grants new scope")
          expect(firstContinuation).toContain("does not by itself block work")
          expect(firstContinuation).not.toContain("User has answered your questions")
          expect(latestToolContent(afterFirstTimeout[2])).toContain(RESUMED_ACTION_RESULT)
          checkpoint = "unanswered-timeout-followed-by-read-action"

          yield* Effect.promise(() => waitForScreen(tui, "navigation countdown", (screen) => COUNTDOWN.test(screen)))
          tui.write("\t", "navigate-without-answering")
          yield* Effect.promise(() => tui.waitForText(NAV_SECOND))
          yield* Effect.promise(() =>
            waitForScreen(tui, "countdown after navigation", (screen) => COUNTDOWN.test(screen)),
          )
          yield* Effect.promise(() => tui.waitForText(PARTIAL_QUESTION, 10_000))
          checkpoint = "navigation-did-not-cancel-timeout"

          const afterNavigationTimeout = (yield* llm.inputs).filter((input) => !isTitleRequest(input))
          expect(afterNavigationTimeout).toHaveLength(4)
          expect(latestToolContent(afterNavigationTimeout[3])).toContain("The user is temporarily away")

          yield* Effect.promise(() =>
            waitForScreen(tui, "partial answer countdown", (screen) => COUNTDOWN.test(screen)),
          )
          tui.write("1", "select-partial-answer")
          yield* Effect.promise(() => tui.waitForText("[✓] Use defaults (Recommended)"))
          yield* Effect.promise(() => tui.waitForText(SELECT_QUESTION, 10_000))
          const afterPartialTimeout = (yield* llm.inputs).filter((input) => !isTitleRequest(input))
          expect(afterPartialTimeout).toHaveLength(5)
          expect(latestToolContent(afterPartialTimeout[4])).toContain("The user is temporarily away")
          checkpoint = "partial-answer-inactivity-timeout"

          yield* Effect.promise(() => waitForScreen(tui, "selection countdown", (screen) => COUNTDOWN.test(screen)))
          tui.write("1", "select-option-and-cancel-timeout")
          yield* Effect.promise(() =>
            waitForScreen(tui, "selection countdown removal", (screen) => !COUNTDOWN.test(screen)),
          )
          yield* Effect.promise(() => tui.waitForText("[✓] Use defaults (Recommended)"))
          tui.write("1", "toggle-selected-option-off")
          yield* Effect.promise(() => tui.waitForText("[ ] Use defaults (Recommended)"))
          yield* Effect.sleep("250 millis")
          expect(tui.screen()).toContain(SELECT_QUESTION)
          expect(tui.screen()).not.toMatch(COUNTDOWN)
          expect((yield* llm.inputs).filter((input) => !isTitleRequest(input))).toHaveLength(5)
          checkpoint = "selection-response-phase-active"

          tui.write("1", "reselect-option-for-submit")
          yield* Effect.promise(() => tui.waitForText("[✓] Use defaults (Recommended)"))
          tui.write("\t", "open-selection-review")
          yield* Effect.promise(() => tui.waitForText("Review"))
          tui.write("\r", "submit-selected-answer")
          yield* Effect.promise(() => tui.waitForText(CUSTOM_QUESTION, 10_000))

          const afterSelection = (yield* llm.inputs).filter((input) => !isTitleRequest(input))
          expect(afterSelection).toHaveLength(6)
          const selectionContinuation = latestToolContent(afterSelection[5])
          expect(selectionContinuation).toContain("User has answered your questions")
          expect(selectionContinuation).toContain("Use defaults")
          expect(selectionContinuation).not.toContain("temporarily away")
          checkpoint = "selected-answer-result-observed"

          yield* Effect.promise(() => waitForScreen(tui, "custom countdown", (screen) => COUNTDOWN.test(screen)))
          tui.write("3", "focus-custom-answer-and-cancel-timeout")
          yield* Effect.promise(() =>
            waitForScreen(tui, "custom countdown removal", (screen) => !COUNTDOWN.test(screen)),
          )
          tui.write("\x1b", "leave-custom-answer-editor")
          yield* Effect.sleep("250 millis")
          expect(tui.screen()).toContain(CUSTOM_QUESTION)
          expect(tui.screen()).not.toMatch(COUNTDOWN)
          expect((yield* llm.inputs).filter((input) => !isTitleRequest(input))).toHaveLength(6)
          checkpoint = "custom-response-phase-active"

          tui.write("3", "reenter-custom-answer-editor")
          yield* Effect.sleep("100 millis")
          tui.write(CUSTOM_ANSWER, "type-custom-answer")
          tui.write("\r", "submit-custom-answer")
          yield* Effect.promise(() => tui.waitForText(DISMISS_QUESTION, 10_000))

          const afterCustom = (yield* llm.inputs).filter((input) => !isTitleRequest(input))
          expect(afterCustom).toHaveLength(7)
          const customContinuation = latestToolContent(afterCustom[6])
          expect(customContinuation).toContain("User has answered your questions")
          expect(customContinuation).toContain(CUSTOM_ANSWER)
          expect(customContinuation).not.toContain("temporarily away")
          checkpoint = "custom-answer-result-observed"

          tui.write("\x1b", "dismiss-question")
          yield* Effect.promise(() => tui.waitForText(FINAL_DONE, 10_000))
          const completed = (yield* llm.inputs).filter((input) => !isTitleRequest(input))
          expect(completed).toHaveLength(8)
          const dismissalContinuation = latestToolContent(completed[7])
          expect(dismissalContinuation).toContain("Do not repeat this question")
          expect(dismissalContinuation).not.toContain("User has answered")
          checkpoint = "dismissal-guidance-reached-model"

          yield* Effect.promise(() =>
            tui.close({
              mode: resolvedTarget.mode,
              assertions: {
                countdownDisplayed: true,
                unansweredTimeoutResumedWithReadAction: true,
                navigationDidNotCancelTimeout: true,
                partialAnswerInactivityTimedOut: true,
                selectionCancelledTimeout: true,
                customFocusCancelledTimeout: true,
                selectionAndCustomAnswersReachedTheModel: true,
                dismissalGuidanceReachedTheModel: true,
              },
            }),
          )
        }),
      target,
    ),
  90_000,
)
