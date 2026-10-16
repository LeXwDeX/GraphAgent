// The provider transport is scripted; hooks, tools, sessions, DAG scheduling,
// cancellation, instance disposal and durable recovery are the real services.
// Live model choice is validated separately; these tests pin runtime semantics.
import { expect } from "bun:test"
import { Effect } from "effect"
import { randomBytes } from "node:crypto"
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises"
import path from "node:path"
import { cliIt } from "../lib/cli-process"
import { hookCommand } from "../fixture/claude-hook"
import { reply } from "../lib/llm-server"

type Row = Record<string, any>

for (const mode of ["complete", "cancel", "dispose"] as const) {
  cliIt.live(
    `real hook denial followed by ${mode} preserves DAG dependency and recovery boundaries`,
    ({ opencode, home, llm }) =>
      Effect.gen(function* () {
        const directory = path.join(yield* Effect.promise(() => realpath(home)), "workspace")
        const protectedFile = path.join(directory, "protected.json")
        const reportFile = path.join(directory, "report.json")
        const proof = randomBytes(18).toString("hex")
        yield* Effect.promise(async () => {
          await mkdir(path.join(directory, ".opencode"), { recursive: true })
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
            path.join(directory, ".opencode", "hooks.json"),
            JSON.stringify({
              PreToolUse: [
                {
                  matcher: "*",
                  hooks: [{ type: "command", command: hookCommand(`require(${JSON.stringify(guard)})`) }],
                },
              ],
            }),
          )
        })
        yield* llm.push(reply().tool("write", { filePath: protectedFile, content: "{}" }, "denied_write"))
        let nextTurnRequested = false
        if (mode === "complete") {
          yield* llm.pushMatch(
            ({ body }) => {
              expect(JSON.stringify(body)).toContain("[Tool denied by hook]")
              return true
            },
            reply().tool("read", { filePath: protectedFile }, "safe_read"),
          )
          yield* llm.pushMatch(
            ({ body }) => {
              expect(JSON.stringify(body)).toContain(proof)
              return true
            },
            reply().tool(
              "write",
              { filePath: reportFile, content: JSON.stringify({ proof, recovered: true }) },
              "safe_write",
            ),
          )
          yield* llm.text("Verification report completed after the permitted correction.")
          yield* llm.push(reply().tool("read", { filePath: reportFile }, "review_read"))
          yield* llm.textMatch(({ body }) => {
            expect(JSON.stringify(body)).toContain(proof)
            return true
          }, "Review approved the actual report.")
        } else {
          yield* llm.pushMatch(() => {
            nextTurnRequested = true
            return true
          }, reply().hang())
        }
        const server = yield* opencode.serve({ hostname: "127.0.0.1", readyTimeoutMs: 30_000 })
        yield* Effect.promise(async () => {
          const request = async (route: string, body?: unknown): Promise<any> => {
            const response = await fetch(server.url + route, {
              method: body === undefined ? "GET" : "POST",
              headers: { "x-opencode-directory": directory, "content-type": "application/json" },
              ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            })
            if (!response.ok) throw new Error(`${route}: HTTP ${response.status}`)
            return response.json()
          }
          const parent = await request("/session", {
            title: `Hook rejection ${mode}`,
            model: { providerID: "test", id: "test-model" },
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          })
          const workflow = await request("/dag", {
            session_id: parent.id,
            title: `Hook rejection ${mode}`,
            config: {
              name: "hook-rejection-chain",
              result_protocol: "final_response",
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
          })
          const nodes = (): Promise<Row[]> => request(`/dag/${workflow.id}/nodes`)
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
            await request(
              mode === "dispose" ? "/instance/dispose" : `/dag/${workflow.id}/control`,
              mode === "dispose" ? {} : { operation: "cancel" },
            )
          }
          const terminal = await waitUntil(
            () => request(`/dag/${workflow.id}`),
            (row) => ["completed", "failed", "cancelled"].includes(row.status),
          )
          const settled = await nodes()
          const verify = settled.find((row) => row.id === "verify")!
          const review = settled.find((row) => row.id === "review")!
          expect(JSON.parse(await readFile(protectedFile, "utf8"))).toEqual({ proof })
          const messages: Row[] = await request(`/session/${verify.child_session_id}/message`)
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
              expect(verify.error_reason).toContain("source unknown")
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
