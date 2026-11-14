// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

// The provider transport is scripted; hooks, tools, sessions, DAG scheduling,
// cancellation, instance disposal and durable recovery are the real services.
// Live model choice is validated separately; these tests pin runtime semantics.
// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- narrow finalizer test fixtures
import { expect, test } from "bun:test"
import { Context, Cause, Effect, Exit, Fiber, Layer, Scope } from "effect"
import { BackgroundJob } from "@/background/job"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { SessionAbortReason } from "@/session/abort-reason"
import { SessionID } from "@/session/schema"
import { InstanceRef } from "@/effect/instance-ref"
import { InstanceState } from "@/effect/instance-state"
import { isClosingOnlyCause } from "@/session/prompt"
import type { SessionV1 } from "@graphagent/core/v1/session"
import { randomBytes } from "node:crypto"
import { access, mkdir, readFile, realpath, writeFile } from "node:fs/promises"
import path from "node:path"
import { cliIt } from "../lib/cli-process"
import { hookCommand } from "../fixture/claude-hook"
import { reply } from "../lib/llm-server"

type Row = Record<string, any>

// The cancel mode was dropped with the HTTP control endpoint (C1): cancel
// semantics are covered by workflow-tool.test.ts, and dispose keeps the
// abort/recovery boundary this chain exercises.
for (const mode of ["complete", "dispose"] as const) {
  cliIt.live(
    `real hook denial followed by ${mode} preserves DAG dependency and recovery boundaries`,
    ({ opencode, home, llm }) =>
      Effect.gen(function* () {
        const directory = path.join(yield* Effect.promise(() => realpath(home)), "workspace")
        const protectedFile = path.join(directory, "protected.json")
        const reportFile = path.join(directory, "report.json")
        const spec = path.join(directory, ".agents", "hook-rejection-chain.yaml")
        const proof = randomBytes(18).toString("hex")
        yield* Effect.promise(async () => {
          await mkdir(path.join(directory, ".agents"), { recursive: true })
          await writeFile(protectedFile, JSON.stringify({ proof }))
          const guard = path.join(home, "guard with spaces.cjs")
          // Decision depends on the actual tool input and existing filesystem
          // state. Reads and writes to fresh paths are permitted.
          await writeFile(
            guard,
            `const fs = require('fs'); const e = JSON.parse(fs.readFileSync(0, 'utf8'));
const a = e.tool_input ?? {}; const target = a.filePath ?? a.file_path;
const denied = e.tool_name === 'write' && typeof target === 'string' && fs.existsSync(target);
console.log(JSON.stringify(denied ? {hookSpecificOutput: {hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Existing fixture is protected; read it and write a fresh report instead.'}} : {}));`,
          )
          await writeFile(
            path.join(directory, ".agents", "hooks.json"),
            JSON.stringify({
              PreToolUse: [
                {
                  matcher: "*",
                  hooks: [{ type: "command", command: hookCommand(`require(${JSON.stringify(guard)})`) }],
                },
              ],
            }),
          )
          await writeFile(
            spec,
            JSON.stringify({
              title: `Hook rejection ${mode}`,
              config: {
                name: "hook-rejection-chain",
                delivery_node: "review",
                max_concurrency: 1,
                nodes: [
                  {
                    id: "verify",
                    name: "Verification",
                    worker_type: "general",
                    depends_on: [],
                    required: true,
                    prompt_template: {
                      inline: `ISSUE777_VERIFY: Attempt ${protectedFile}, then recover into ${reportFile}.`,
                    },
                  },
                  {
                    id: "review",
                    name: "Dependent review",
                    worker_type: "general",
                    depends_on: ["verify"],
                    required: true,
                    prompt_template: { inline: `ISSUE777_REVIEW: Read and review ${reportFile}.` },
                  },
                ],
              },
            }),
          )
        })
        // The workflow starts through the parent's workflow tool, so every
        // scripted reply must be scoped to the worker whose prompt carries the
        // marker; unscoped parent requests fall through to the server's
        // default acknowledgement.
        const verifyMatch = (hit: { body: unknown }) => JSON.stringify(hit.body).includes("ISSUE777_VERIFY")
        const reviewMatch = (hit: { body: unknown }) => JSON.stringify(hit.body).includes("ISSUE777_REVIEW")
        yield* llm.toolMatch(({ body }) => JSON.stringify(body).includes("ISSUE777-START"), "workflow", {
          params: { action: "run", operation: "start", spec_path: spec },
        })
        yield* llm.pushMatch(
          verifyMatch,
          reply().tool("write", { filePath: protectedFile, content: "{}" }, "denied_write"),
        )
        let nextTurnRequested = false
        if (mode === "complete") {
          yield* llm.pushMatch(
            (hit) => {
              if (!verifyMatch(hit)) return false
              expect(JSON.stringify(hit.body)).toContain("[Tool denied by hook]")
              return true
            },
            reply().tool("read", { filePath: protectedFile }, "safe_read"),
          )
          yield* llm.pushMatch(
            (hit) => {
              if (!verifyMatch(hit)) return false
              expect(JSON.stringify(hit.body)).toContain(proof)
              return true
            },
            reply().tool(
              "write",
              { filePath: reportFile, content: JSON.stringify({ proof, recovered: true }) },
              "safe_write",
            ),
          )
          yield* llm.textMatch(verifyMatch, "Verification report completed after the permitted correction.")
          yield* llm.pushMatch(reviewMatch, reply().tool("read", { filePath: reportFile }, "review_read"))
          yield* llm.textMatch((hit) => {
            if (!reviewMatch(hit)) return false
            expect(JSON.stringify(hit.body)).toContain(proof)
            return true
          }, "Review approved the actual report.")
        } else {
          yield* llm.pushMatch((hit) => {
            if (!verifyMatch(hit) || !JSON.stringify(hit.body).includes("[Tool denied by hook]")) return false
            nextTurnRequested = true
            return true
          }, reply().hang())
        }
        const server = yield* opencode.host({ readyTimeoutMs: 30_000 })
        yield* Effect.promise(async () => {
          const request = async (route: string, body?: unknown): Promise<any> => {
            const response = await fetch(server.url + route, {
              method: body === undefined ? "GET" : "POST",
              headers: { "x-graphagent-directory": directory, "content-type": "application/json" },
              ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            })
            if (!response.ok) throw new Error(`${route}: HTTP ${response.status}`)
            return response.json()
          }
          // Project-layer hooks are trust-gated. This fixture writes its own
          // hooks.json, so record the decisions the TUI trust panel would
          // submit before the workflow can rely on the denial.
          const projectTrust: Row = await request("/project/trust")
          if (projectTrust.entries.length === 0) throw new Error("project trust enumeration returned no entries")
          await request("/project/trust", {
            decisions: projectTrust.entries.map((entry: Row) => ({ id: entry.id, state: "trusted" })),
          })
          const parent = await request("/session", {
            title: `Hook rejection ${mode}`,
            model: { providerID: "test", id: "test-model" },
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          })
          await request(`/session/${parent.id}/message`, {
            parts: [{ type: "text", text: "ISSUE777-START" }],
          })
          const workflows: Row[] = await request(`/dag/session/${parent.id}`)
          const workflow = workflows[0]
          if (!workflow) throw new Error("workflow tool did not start a workflow")
          const nodes = (): Promise<Row[]> => request(`/dag/${workflow.id}/nodes`)
          const workflowRow = async (): Promise<Row> => {
            const rows: Row[] = await request(`/dag/session/${parent.id}`)
            const row = rows.find((candidate) => candidate.id === workflow.id)
            if (!row) throw new Error(`workflow ${workflow.id} disappeared from the session list`)
            return row
          }
          const waitUntil = async <A>(read: () => Promise<A>, ready: (value: A) => boolean): Promise<A> => {
            const deadline = Date.now() + 60_000
            do {
              const value = await read()
              if (ready(value)) return value
              await new Promise((resolve) => setTimeout(resolve, 25))
            } while (Date.now() < deadline)
            throw new Error(
              `Timed out waiting for ${mode} workflow: ${JSON.stringify((await nodes()).map((row) => ({ id: row.id, status: row.status })))}`,
            )
          }
          if (mode !== "complete") {
            const child = await waitUntil(nodes, (rows) =>
              Boolean(rows.find((row) => row.id === "verify")?.child_session_id),
            )
            const childID = child.find((row) => row.id === "verify")!.child_session_id
            // Intercept the next provider request, after the denial has been
            // persisted. The hanging stream keeps this boundary deterministic.
            await waitUntil(
              async () => nextTurnRequested,
              (requested) => requested,
            )
            const messages: Row[] = await request(`/session/${childID}/message`)
            expect(messages.flatMap((message) => message.parts).some((part) => part.state?.metadata?.hookDenied)).toBe(
              true,
            )
            // The HTTP control endpoint is gone with C1; disposal is the abort
            // boundary that remains reachable without a workflow tool call.
            await request("/instance/dispose", {})
          }
          const terminal = await waitUntil(workflowRow, (row) =>
            ["completed", "failed", "cancelled"].includes(row.status),
          )
          const settled = await nodes()
          const verify = settled.find((row) => row.id === "verify")!
          const review = settled.find((row) => row.id === "review")!
          expect(JSON.parse(await readFile(protectedFile, "utf8"))).toEqual({ proof })
          const messages: Row[] =
            mode === "complete"
              ? await request(`/session/${verify.child_session_id}/message`)
              : await waitUntil<Row[]>(
                  () => request(`/session/${verify.child_session_id}/message`),
                  (rows) => rows.some((message) => message.info.error?.name === "MessageAbortedError"),
                )
          const parts = messages.flatMap((message) => message.parts)
          expect(parts.some((part) => part.state?.metadata?.hookDenied)).toBe(true)
          if (mode === "complete") {
            expect(terminal.status).toBe("completed")
            expect(verify.status).toBe("completed")
            expect(review.status).toBe("completed")
            expect(JSON.parse(await readFile(reportFile, "utf8"))).toEqual({ proof, recovered: true })
            const reviews: Row[] = await request(`/session/${review.child_session_id}/message`)
            expect(
              reviews
                .flatMap((message) => message.parts)
                .some((part) => part.tool === "read" && part.state.output.includes(proof)),
            ).toBe(true)
            expect(
              parts.some(
                (part) =>
                  part.tool === "write" &&
                  part.state.input.filePath === reportFile &&
                  part.state.status === "completed",
              ),
            ).toBe(true)
          } else {
            expect(terminal.status).toBe(mode === "dispose" ? "failed" : "cancelled")
            expect(verify.status).toBe(mode === "dispose" ? "failed" : "aborted")
            expect(review.status).toBe("skipped")
            expect(review.child_session_id).toBeUndefined()
            expect(messages.some((message) => message.info.error?.name === "MessageAbortedError")).toBe(true)
            if (mode === "dispose") {
              expect(verify.status).toBe("failed")
              expect(verify.error_reason).toContain("MessageAbortedError")
              expect(verify.error_reason).toMatch(/reason: (shutdown|runtime-interrupt)/)
              expect(verify.error_reason).not.toContain("source unknown")
              expect(review.status).toBe("skipped")
            }
            // Repeated recovery reads cannot create a new execution attempt.
            expect(
              (await nodes()).map((row) => [row.id, row.status, row.child_session_id, row.replan_attempts]),
            ).toEqual(settled.map((row) => [row.id, row.status, row.child_session_id, row.replan_attempts]))
          }
        })
        const requests = yield* llm.inputs
        // A terminal workflow may wake the parent. Count only the worker
        // whose execution identity is under test and its dependent review.
        expect(requests.filter((body) => JSON.stringify(body).includes("ISSUE777_VERIFY"))).toHaveLength(
          mode === "complete" ? 4 : 2,
        )
        expect(requests.filter((body) => JSON.stringify(body).includes("ISSUE777_REVIEW"))).toHaveLength(
          mode === "complete" ? 2 : 0,
        )
      }),
    120_000,
  )
}

cliIt.live(
  "an untrusted project hook is skipped in a DAG worker without permission or question requests",
  ({ opencode, home, llm }) =>
    Effect.gen(function* () {
      const directory = path.join(yield* Effect.promise(() => realpath(home)), "workspace")
      const marker = path.join(home, "untrusted-hook-ran.txt")
      const reportFile = path.join(directory, "untrusted-report.json")
      const spec = path.join(directory, ".agents", "untrusted-hook.yaml")
      yield* Effect.promise(async () => {
        await mkdir(path.join(directory, ".agents"), { recursive: true })
        await writeFile(
          path.join(directory, ".agents", "hooks.json"),
          JSON.stringify({
            PreToolUse: [
              {
                matcher: "*",
                hooks: [
                  {
                    type: "command",
                    command: hookCommand(`require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")`),
                  },
                ],
              },
            ],
          }),
        )
        await writeFile(
          spec,
          JSON.stringify({
            title: "Untrusted project hook",
            config: {
              name: "untrusted-project-hook",
              delivery_node: "verify",
              max_concurrency: 1,
              nodes: [
                {
                  id: "verify",
                  name: "Verification",
                  worker_type: "general",
                  depends_on: [],
                  required: true,
                  prompt_template: {
                    inline: `ISSUE1040_UNTRUSTED: Write ${reportFile} with {"ok":true}, then report completion.`,
                  },
                },
              ],
            },
          }),
        )
      })
      // The project hook stays pending: it was never submitted through
      // /project/trust, so the worker must run with an empty hook chain.
      const workerMatch = (hit: { body: unknown }) => JSON.stringify(hit.body).includes("ISSUE1040_UNTRUSTED")
      yield* llm.toolMatch(({ body }) => JSON.stringify(body).includes("ISSUE1040-START"), "workflow", {
        params: { action: "run", operation: "start", spec_path: spec },
      })
      yield* llm.pushMatch(
        workerMatch,
        reply().tool("write", { filePath: reportFile, content: JSON.stringify({ ok: true }) }, "untrusted_write"),
      )
      yield* llm.textMatch(workerMatch, "Written with project hooks still pending.")
      const server = yield* opencode.host({ readyTimeoutMs: 30_000 })
      yield* Effect.promise(async () => {
        const request = async (route: string, body?: unknown): Promise<any> => {
          const response = await fetch(server.url + route, {
            method: body === undefined ? "GET" : "POST",
            headers: { "x-graphagent-directory": directory, "content-type": "application/json" },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          })
          if (!response.ok) throw new Error(`${route}: HTTP ${response.status}`)
          return response.json()
        }
        const trust: Row = await request("/project/trust")
        expect(trust.entries.map((entry: Row) => [entry.category, entry.state])).toEqual([["hook", "pending"]])
        const parent = await request("/session", {
          title: "Untrusted hook chain",
          model: { providerID: "test", id: "test-model" },
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        await request(`/session/${parent.id}/message`, {
          parts: [{ type: "text", text: "ISSUE1040-START" }],
        })
        const workflows: Row[] = await request(`/dag/session/${parent.id}`)
        const workflow = workflows[0]
        if (!workflow) throw new Error("workflow tool did not start a workflow")
        const deadline = Date.now() + 60_000
        const waitUntil = async <A>(read: () => Promise<A>, ready: (value: A) => boolean): Promise<A> => {
          for (;;) {
            const value = await read()
            if (ready(value)) return value
            if (Date.now() > deadline) throw new Error(`Timed out waiting for the workflow: ${JSON.stringify(value)}`)
            await new Promise((resolve) => setTimeout(resolve, 25))
          }
        }
        const terminal = await waitUntil(
          async () => {
            const rows: Row[] = await request(`/dag/session/${parent.id}`)
            const row = rows.find((candidate) => candidate.id === workflow.id)
            if (!row) throw new Error(`workflow ${workflow.id} disappeared from the session list`)
            return row
          },
          (row) => ["completed", "failed", "cancelled"].includes(row.status),
        )
        expect(terminal.status).toBe("completed")
        const nodes: Row[] = await request(`/dag/${workflow.id}/nodes`)
        expect(nodes.map((row) => [row.id, row.status])).toEqual([["verify", "completed"]])
        expect(JSON.parse(await readFile(reportFile, "utf8"))).toEqual({ ok: true })
        expect(
          await access(marker)
            .then(() => true)
            .catch(() => false),
        ).toBe(false)
        // The non-interactive path must skip the entries instead of asking:
        // both pending permission and question lists stay empty.
        expect(await request("/permission")).toEqual([])
        expect(await request("/question")).toEqual([])
        expect((await request("/project/trust")).entries[0].state).toBe("pending")
      })
    }),
  120_000,
)

async function observeFinalizerReason(
  existing?: SessionAbortReason.Info,
  statusSet: () => Effect.Effect<void> = () => Effect.yieldNow,
) {
  const sessionID = SessionID.make(`ses_finalizer_${Math.random().toString(36).slice(2)}`)
  let observed: SessionAbortReason.Info | undefined
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const scope = yield* Scope.make()
        const context = yield* Layer.buildWithScope(
          SessionRunState.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.mock(BackgroundJob.Service, {
                  list: () => Effect.succeed([]),
                  cancel: () => Effect.succeed(undefined),
                }),
                Layer.mock(SessionStatus.Service, { set: statusSet }),
              ),
            ),
          ),
          scope,
        )
        const runs = Context.get(context, SessionRunState.Service)
        const handle = yield* runs
          .ensureRunningHandle(
            sessionID,
            Effect.sync(() => {
              observed = SessionAbortReason.take(sessionID)
              return {} as SessionV1.WithParts
            }),
            Effect.never,
          )
          .pipe(
            Effect.provideService(InstanceRef, {
              directory: "/tmp/finalizer-test",
              worktree: "/tmp/finalizer-test",
              project: { id: "finalizer-test" },
            } as never),
          )
        const joining = yield* handle.pipe(Effect.forkScoped)
        if (existing) SessionAbortReason.set(sessionID, existing)
        yield* Scope.close(scope, Exit.void)
        yield* Fiber.join(joining)
      }),
    ),
  )
  return observed
}

test("run-state finalizer preserves an existing in-flight abort reason", async () => {
  const existing = SessionAbortReason.make("runtime-interrupt", "runtime-scope")
  expect(await observeFinalizerReason(existing)).toEqual(existing)
})

test("run-state finalizer writes shutdown when no reason exists", async () => {
  expect(await observeFinalizerReason()).toEqual(SessionAbortReason.make("shutdown", "session-scope"))
})

test("run-state finalizer completes when status is closing", async () => {
  const observed = await observeFinalizerReason(undefined, () =>
    Effect.yieldNow.pipe(Effect.andThen(Effect.die(new InstanceState.Closing("/tmp/finalizer-test")))),
  )
  expect(observed).toEqual(SessionAbortReason.make("shutdown", "session-scope"))
})

test("closing-only cause classification keeps mixed failures as failures", () => {
  const closing = Cause.die(new InstanceState.Closing("/tmp/finalizer-test"))
  expect(isClosingOnlyCause(closing)).toBe(true)
  expect(isClosingOnlyCause(Cause.combine(closing, Cause.die(new Error("real failure"))))).toBe(false)
  expect(isClosingOnlyCause(Cause.combine(Cause.interrupt(1), closing))).toBe(true)
  expect(isClosingOnlyCause(Cause.combine(Cause.interrupt(1), Cause.die(new Error("real failure"))))).toBe(false)
})
