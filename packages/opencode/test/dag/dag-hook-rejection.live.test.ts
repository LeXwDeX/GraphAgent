import { Effect } from "effect"
import { test } from "bun:test"
import { withCliFixture } from "../lib/cli-process"
import { hookCommand } from "../fixture/claude-hook"
import fs from "node:fs/promises"
import path from "node:path"
import { randomBytes } from "node:crypto"
// Opt in against an already configured QWEN/GLM/DeepSeek provider. This runs
// the source CLI in an isolated home/database; it does not install a binary.
const setting = process.env.OPENCODE_DAG_HOOK_LIVE_CONFIG
test.skipIf(!setting)(
  "a live model corrects a real hook denial and its dependent review validates the artifact",
  async () => {
    const originConfig = JSON.parse(await fs.readFile(setting!, "utf8"))
    const selected = Object.entries(originConfig.provider ?? {}).flatMap(([providerID, value]: [string, any]) =>
      Object.keys(value.models ?? {})
        .filter((modelID) => /qwen|glm|deepseek/i.test(modelID))
        .map((modelID) => ({ providerID, modelID })),
    )
    const modelSetting = process.env.OPENCODE_DAG_HOOK_LIVE_MODEL
    const model = selected.find(
      (candidate) => !modelSetting || `${candidate.providerID}/${candidate.modelID}` === modelSetting,
    )
    if (!model) throw new Error("Live config must contain the requested QWEN, GLM, or DeepSeek model")
    const { providerID, modelID } = model
    await Effect.runPromise(
      Effect.scoped(
        withCliFixture(({ opencode, home, env }) =>
          Effect.gen(function* () {
            const dir = path.join(home, "workspace")
            yield* Effect.promise(() => fs.mkdir(path.join(dir, ".opencode"), { recursive: true }))
            const proof = randomBytes(18).toString("hex")
            const protectedFile = path.join(dir, "protected.json")
            yield* Effect.promise(() => fs.writeFile(protectedFile, JSON.stringify({ proof })))
            const hookPath = path.join(home, "guard with spaces.cjs"),
              auditPath = path.join(home, "audit.jsonl")
            const hook = `const fs=require('fs'),path=require('path');const e=JSON.parse(fs.readFileSync(0,'utf8'));const a=e.tool_input??e.toolInput??{};const tool=e.tool_name??e.toolName;const p=a.filePath??a.file_path??'';const command=a.command??'';const deny=(['write','edit','apply_patch','bash'].includes(String(tool).toLowerCase())&&(p===${JSON.stringify(protectedFile)}||command.includes('protected.json')||String(a.patchText??'').includes('protected.json')));fs.appendFileSync(${JSON.stringify(auditPath)},JSON.stringify({tool,input:a,denied:deny,session:e.session_id??e.sessionID})+'\\n');console.log(JSON.stringify(deny?{hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:'Existing protected fixture cannot be changed. Read it safely and create a fresh report.json in this workspace instead.'}}:{}));`
            yield* Effect.promise(() => fs.writeFile(hookPath, hook))
            yield* Effect.promise(() =>
              fs.writeFile(
                path.join(dir, ".opencode", "hooks.json"),
                JSON.stringify({
                  PreToolUse: [
                    {
                      matcher: "*",
                      hooks: [{ type: "command", command: hookCommand(`require(${JSON.stringify(hookPath)})`) }],
                    },
                  ],
                }),
              ),
            )
            const config = {
              provider: { [providerID]: originConfig.provider[providerID] },
              model: `${providerID}/${modelID}`,
              permission: "allow",
              compaction: { auto: false },
              reasoningDistillation: { enabled: false },
            }
            const server = yield* opencode.serve({
              port: 0,
              hostname: "127.0.0.1",
              readyTimeoutMs: 30000,
              env: {
                ...env,
                OPENCODE_CONFIG: "",
                OPENCODE_CONFIG_DIR: "",
                OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
                OPENCODE_DB: path.join(home, "isolated.db"),
              },
            })
            yield* Effect.promise(async () => {
              const req = async (route: string, body?: unknown) => {
                const r = await fetch(server.url + route, {
                  method: body ? "POST" : "GET",
                  headers: { "x-opencode-directory": dir, "content-type": "application/json" },
                  ...(body ? { body: JSON.stringify(body) } : {}),
                })
                if (!r.ok) throw Error(`HTTP ${route} ${r.status}`)
                return r.json()
              }
              const parent: any = await req("/session", {
                title: "777 dynamic rejection",
                model: { id: modelID, providerID },
                permission: [{ permission: "*", pattern: "*", action: "allow" }],
              })
              const worker = `First use the write tool to overwrite ${protectedFile} with {} as a required initial test attempt. If the runtime refuses it, obey the refusal, read the original JSON file safely, then write a NEW ${path.join(dir, "report.json")} containing exactly the original proof value and an additional field recovered:true. Do not invent the proof; read the actual file. End with a short report describing the denied action and your completed correction. Never repeat the denied write. Do not call workflow tools.`
              const review = `Read ${path.join(dir, "protected.json")} and ${path.join(dir, "report.json")} using tools. Verify their proof values match and report.recovered is true. Write ${path.join(dir, "review.json")} containing {proof:<actual value read>,approved:true}. Then provide your review verdict. Do not modify any other files. Do not call workflow tools.`
              const start: any = await req("/dag", {
                session_id: parent.id,
                title: "777 dynamic refusal recovery",
                config: {
                  name: "777-real-hook",
                  result_protocol: "final_response",
                  delivery_node: "review",
                  max_concurrency: 1,
                  nodes: [
                    {
                      id: "verify",
                      name: "Verification worker",
                      worker_type: "general",
                      depends_on: [],
                      required: true,
                      prompt_template: { inline: worker },
                    },
                    {
                      id: "review",
                      name: "Dependent review",
                      worker_type: "general",
                      depends_on: ["verify"],
                      required: true,
                      prompt_template: { inline: review },
                    },
                  ],
                },
              })

              let nodes: any[] = [],
                detail: any
              const end = Date.now() + 240000
              do {
                detail = await req("/dag/" + start.id)
                nodes = await req("/dag/" + start.id + "/nodes")
                if (["completed", "failed", "cancelled"].includes(detail.status)) break
                await new Promise((r) => setTimeout(r, 1000))
              } while (Date.now() < end)
              const audit = (await fs.readFile(auditPath, "utf8").catch(() => ""))
                .trim()
                .split("\n")
                .filter(Boolean)
                .map((s) => JSON.parse(s))
              const childEvidence = []
              for (const n of nodes) {
                const messages: any[] = n.child_session_id
                  ? await req("/session/" + n.child_session_id + "/message")
                  : []
                childEvidence.push({
                  id: n.id,
                  status: n.status,
                  error: n.error_reason,
                  tools: messages
                    .flatMap((m) => m.parts)
                    .filter((p) => p.type === "tool")
                    .map((p) => ({
                      tool: p.tool,
                      status: p.state.status,
                      metadata: p.state.metadata,
                      input: p.state.input,
                      output: p.state.output,
                    })),
                  errors: messages.map((m) => m.info.error).filter(Boolean),
                })
              }

              const report = JSON.parse(await fs.readFile(path.join(dir, "report.json"), "utf8").catch(() => "{}"))
              const reviewed = JSON.parse(await fs.readFile(path.join(dir, "review.json"), "utf8").catch(() => "{}"))
              const protectedOriginal = JSON.parse(await fs.readFile(protectedFile, "utf8"))
              const checks = {
                workflowCompleted: detail.status === "completed",
                bothCompleted: nodes.length === 2 && nodes.every((n) => n.status === "completed"),
                denied: audit.some((a) => a.denied),
                durableDenial: childEvidence.some(
                  (child) => child.id === "verify" && child.tools.some((tool) => tool.metadata?.hookDenied === true),
                ),
                reviewReadProof: childEvidence.some(
                  (child) =>
                    child.id === "review" &&
                    child.tools.some(
                      (tool) => tool.tool === "read" && typeof tool.output === "string" && tool.output.includes(proof),
                    ),
                ),
                noChildError: childEvidence.every((child) => child.errors.length === 0),
                allowedAfterDenied:
                  audit.findIndex((a) => a.denied) >= 0 &&
                  audit.slice(audit.findIndex((a) => a.denied) + 1).some((a) => !a.denied && a.tool === "write"),
                protectedUnchanged: protectedOriginal.proof === proof,
                workerProof: report.proof === proof && report.recovered === true,
                reviewProof: reviewed.proof === proof && reviewed.approved === true,
              }
              console.log(JSON.stringify({ model: `${providerID}/${modelID}`, checks, hookCalls: audit.length }))
              if (!Object.values(checks).every(Boolean)) throw Error("Live hook recovery acceptance failed")
            })
          }),
        ),
      ),
    )
  },
  300_000,
)
