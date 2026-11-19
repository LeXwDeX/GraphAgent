// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { EOL } from "os"
import { Effect } from "effect"
import { RequestCapture } from "@/provider/request-capture"
import { fail } from "../../effect-cmd"

export type RequestOutput = { code: number; stdout: string; stderr: string }

/**
 * What `graphagent debug request <session> [--step N]` prints: the captured request of that step (the last one when
 * no step is given) as JSON, or on stderr why there is none. Sessions idle for over a week are removed first.
 */
export async function requestOutput(args: { session: string; step?: number }, dir?: string): Promise<RequestOutput> {
  await RequestCapture.cleanup(Date.now(), dir)
  const steps = await RequestCapture.list(args.session, dir)
  const last = steps.at(-1)
  if (last === undefined) {
    return {
      code: 1,
      stdout: "",
      stderr: `No captured requests for session ${args.session}. Set GRAPHAGENT_DEBUG_REQUESTS=1 to record them.`,
    }
  }
  const step = args.step ?? last
  if (!steps.includes(step)) {
    return { code: 1, stdout: "", stderr: `Step ${step} not found; captured steps: 1..${last}` }
  }
  const captured = await RequestCapture.read(args.session, step, dir)
  if (!captured) {
    return { code: 1, stdout: "", stderr: `Step ${step} of session ${args.session} could not be read.` }
  }
  return { code: 0, stdout: JSON.stringify(captured, null, 2), stderr: "" }
}

export const debugRequest = Effect.fn("Cli.debug.request")(function* (args: { session: string; step?: number }) {
  const output = yield* Effect.promise(() => requestOutput(args))
  if (output.stderr) process.stderr.write(output.stderr + EOL)
  if (output.stdout) process.stdout.write(output.stdout + EOL)
  if (output.code !== 0) yield* fail("", output.code)
})
