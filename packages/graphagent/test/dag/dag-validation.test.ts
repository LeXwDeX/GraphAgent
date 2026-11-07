import { describe, expect } from "bun:test"
import { $ } from "bun"
import { Effect } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { CrossSpawnSpawner } from "@graphagent/core/cross-spawn-spawner"
import { DagValidation } from "../../src/dag/validation"
import type { NodeConfig } from "../../src/dag/dag"
import { WorkflowAuthoring } from "../../src/dag/authoring"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(CrossSpawnSpawner.defaultLayer)

function validateSpec(input: {
  value: unknown
  source: string
  profile?: DagValidation.Profile
  directory?: string
  catalogs?: DagValidation.EnvironmentCatalogs
}) {
  return WorkflowAuthoring.make({ loadEnvironment: () => Effect.succeed(input.catalogs ?? {}) }).prepare({
    action: "start",
    source: { kind: "inline", value: input.value, source: input.source },
    profile: input.profile,
    environment: { directory: input.directory },
  })
}

function validateYaml(input: { content: string; source: string; profile?: DagValidation.Profile }) {
  return WorkflowAuthoring.make().prepare({
    action: "start",
    source: { kind: "yaml", content: input.content, source: input.source },
    profile: input.profile,
  })
}

const validNodesSpec = {
  title: "Two node chain",
  config: {
    name: "two-node-chain",
    nodes: [
      {
        id: "explore",
        name: "explore",
        worker_type: "explore",
        depends_on: [],
        prompt_template: { inline: "Inspect {{target}}", input: { target: "dag module" } },
        required: true,
      },
      {
        id: "summarize",
        name: "summarize",
        worker_type: "general",
        depends_on: ["explore"],
        prompt_template: { inline: "Summarize {{explore}}." },
        report_to_parent: true,
      },
    ],
  },
}

const validBlocksSpec = {
  config: {
    name: "plan-verify-review",
    objective: "Ship the bounded change with evidence",
    blocks: [
      { id: "plan", kind: "plan" },
      { id: "code", kind: "coding", depends_on: ["plan"] },
      { id: "verify", kind: "verify", depends_on: ["code"] },
      { id: "review", kind: "review", depends_on: ["verify"] },
    ],
  },
}

function projectDir(files: Record<string, string>) {
  return tmpdirScoped({
    init: (directory) =>
      Effect.promise(async () => {
        for (const [file, content] of Object.entries(files)) {
          const target = path.join(directory, file)
          await fs.mkdir(path.dirname(target), { recursive: true })
          await fs.writeFile(target, content, "utf-8")
        }
      }),
  })
}

describe("workflow spec validator", () => {
  describe("diagnostic contract", () => {
    it.effect("returns stable machine-readable diagnostics with severity, code, path, message, hint", () =>
      Effect.gen(function* () {
        const result = yield* validateSpec({ value: { config: {} }, source: "<inline>" })
        expect(result.valid).toBe(false)
        expect(result.errors.length).toBeGreaterThan(0)
        for (const diagnostic of result.errors) {
          expect(diagnostic.severity).toBe("error")
          expect(typeof diagnostic.code).toBe("string")
          expect(typeof diagnostic.path).toBe("string")
          expect(typeof diagnostic.message).toBe("string")
          expect(typeof diagnostic.hint).toBe("string")
        }
      }),
    )

    it.effect("collects several independent errors instead of only the first", () =>
      Effect.gen(function* () {
        const result = yield* validateSpec({
          value: {
            config: {
              name: "multi-error",
              nodes: [
                {
                  id: "a",
                  name: "a",
                  worker_type: "general",
                  depends_on: ["missing"],
                  prompt_template: { inline: "Use {{gone}}" },
                },
                {
                  id: "a",
                  name: "dup",
                  worker_type: "general",
                  depends_on: [],
                  prompt_template: { inline: "ok" },
                },
              ],
            },
          },
          source: "<inline>",
        })
        const codes = result.errors.map((d) => d.code)
        expect(codes).toContain(DagValidation.DIAGNOSTIC_CODES.dagInvalid)
        expect(codes).toContain(DagValidation.DIAGNOSTIC_CODES.promptUnboundVariable)
        expect(result.errors.length).toBeGreaterThanOrEqual(3)
      }),
    )

    it.effect("orders diagnostics stably for identical input", () =>
      Effect.gen(function* () {
        const input = {
          value: {
            config: {
              name: "ordering",
              nodes: [
                {
                  id: "z",
                  name: "z",
                  worker_type: "general",
                  depends_on: ["missing"],
                  prompt_template: { inline: "{{gone}}" },
                },
                {
                  id: "a",
                  name: "a",
                  worker_type: "general",
                  depends_on: ["missing"],
                  prompt_template: { inline: "{{gone}}" },
                },
              ],
            },
          },
          source: "<inline>",
        }
        const first = yield* validateSpec(input)
        const second = yield* validateSpec(input)
        expect(second.errors).toEqual(first.errors)
      }),
    )

    it.effect("returns schema.invalid for malformed YAML through the shared parser", () =>
      Effect.gen(function* () {
        const result = yield* validateYaml({
          content: "config: [unclosed",
          source: "broken.yaml",
        })
        expect(result).toMatchObject({
          source: "broken.yaml",
          profile: "portable",
          valid: false,
          warnings: [],
          nodes: [],
          errors: [
            {
              severity: "error",
              code: DagValidation.DIAGNOSTIC_CODES.schemaInvalid,
              path: "$",
              message: "file is not parseable YAML",
            },
          ],
        })
      }),
    )

    it.effect("warning-only validation stays valid", () =>
      Effect.gen(function* () {
        const result = yield* validateSpec({
          value: {
            config: {
              name: "warning-only",
              nodes: [
                {
                  id: "gate",
                  name: "gate",
                  worker_type: "general",
                  depends_on: [],
                  required: true,
                  output_schema: { type: "object", format: "custom" },
                  prompt_template: { inline: "Rule." },
                },
              ],
            },
          },
          source: "<inline>",
        })
        expect(result.valid).toBe(true)
        expect(result.errors).toEqual([])
        expect(result.warnings.some((d) => d.code === DagValidation.DIAGNOSTIC_CODES.schemaKeywordWarning)).toBe(true)
      }),
    )

    it.effect("validation has no side effects: no services, no files, no workflow id", () =>
      Effect.gen(function* () {
        const tmp = yield* projectDir({})
        const before = yield* Effect.promise(() => fs.readdir(tmp))
        const result = yield* validateSpec({
          value: validNodesSpec,
          source: "<inline>",
          directory: tmp,
        })
        expect(result.valid).toBe(true)
        expect(JSON.stringify(result)).not.toContain("workflow_id")
        expect(yield* Effect.promise(() => fs.readdir(tmp))).toEqual(before)
      }),
    )
  })

  describe("portable profile", () => {
    it.effect("valid block YAML passes without reading user directories", () =>
      Effect.gen(function* () {
        const result = yield* validateSpec({ value: validBlocksSpec, source: "builtin://test" })
        expect(result.valid).toBe(true)
        expect(result.nodes.map((node) => node.id)).toEqual(
          expect.arrayContaining(["plan", "code", "verify", "review--standards", "review"]),
        )
        expect(result.nodes.find((node) => node.id === "review")?.review_phase).toBe("diff")
      }),
    )

    it.effect("valid low-level node YAML passes with compiled-node summary", () =>
      Effect.gen(function* () {
        const result = yield* validateSpec({ value: validNodesSpec, source: "<inline>" })
        expect(result.valid).toBe(true)
        expect(result.nodes.map((node) => node.id)).toEqual(["explore", "summarize"])
        expect(result.nodes[1]?.depends_on).toEqual(["explore"])
      }),
    )

    it.effect("rejects a spec carrying both graph sources", () =>
      Effect.gen(function* () {
        const result = yield* validateSpec({
          value: {
            config: {
              name: "both-sources",
              objective: "x",
              blocks: [{ id: "plan", kind: "plan" }],
              nodes: [{ id: "a", name: "a", worker_type: "general", depends_on: [], prompt_template: { inline: "x" } }],
            },
          },
          source: "<inline>",
        })
        expect(result.valid).toBe(false)
        expect(result.errors[0]?.code).toBe(DagValidation.DIAGNOSTIC_CODES.schemaInvalid)
      }),
    )

    it.effect("rejects a prompt template selecting both inline and id", () =>
      Effect.gen(function* () {
        const result = yield* validateSpec({
          value: {
            config: {
              name: "ambiguous-source",
              nodes: [
                {
                  id: "a",
                  name: "a",
                  worker_type: "general",
                  depends_on: [],
                  prompt_template: { inline: "x", id: "code-explore" },
                },
              ],
            },
          },
          source: "<inline>",
        })
        expect(result.valid).toBe(false)
      }),
    )

    it.effect("rejects a prompt template with no source", () =>
      Effect.gen(function* () {
        const result = yield* validateSpec({
          value: {
            config: {
              name: "no-source",
              nodes: [
                {
                  id: "a",
                  name: "a",
                  worker_type: "general",
                  depends_on: [],
                  prompt_template: { input: { target: "x" } },
                },
              ],
            },
          },
          source: "<inline>",
        })
        expect(result.valid).toBe(false)
      }),
    )

    it.effect("flags id prompts as nonportable even when the project happens to own them", () =>
      Effect.gen(function* () {
        const tmp = yield* projectDir({ ".agents/dag-prompts/code-explore.md": "Explore {{target}}" })
        const result = yield* validateSpec({
          value: {
            config: {
              name: "id-prompt",
              nodes: [
                {
                  id: "explore",
                  name: "explore",
                  worker_type: "explore",
                  depends_on: [],
                  prompt_template: { id: "code-explore", input: { target: "x" } },
                },
              ],
            },
          },
          source: "builtin://dag-review",
          profile: "portable",
          directory: tmp,
        })
        expect(result.errors.some((d) => d.code === DagValidation.DIAGNOSTIC_CODES.promptNonportableAsset)).toBe(true)
      }),
    )

    it.effect("inline prompt with an unbound placeholder fails with node id and path", () =>
      Effect.gen(function* () {
        const result = yield* validateSpec({
          value: {
            config: {
              name: "unbound",
              nodes: [
                {
                  id: "a",
                  name: "a",
                  worker_type: "general",
                  depends_on: [],
                  prompt_template: { inline: "Use {{gone}}" },
                },
              ],
            },
          },
          source: "<inline>",
        })
        const diagnostic = result.errors.find((d) => d.code === DagValidation.DIAGNOSTIC_CODES.promptUnboundVariable)
        expect(diagnostic).toBeDefined()
        expect(diagnostic?.message).toContain("{{gone}}")
      }),
    )
  })

  describe("environment profile", () => {
    it.effect("resolves a project prompt and validates its bindings", () =>
      Effect.gen(function* () {
        const tmp = yield* projectDir({
          ".agents/dag-prompts/code-explore.md": "Explore {{target}} and {{missing}}",
        })
        const result = yield* validateSpec({
          value: {
            config: {
              name: "env-binding",
              nodes: [
                {
                  id: "explore",
                  name: "explore",
                  worker_type: "explore",
                  depends_on: [],
                  prompt_template: { id: "code-explore", input: { target: "dag" } },
                },
              ],
            },
          },
          source: "env.yaml",
          profile: "environment",
          directory: tmp,
        })
        const diagnostic = result.errors.find((d) => d.code === DagValidation.DIAGNOSTIC_CODES.promptUnboundVariable)
        expect(diagnostic?.message).toContain('prompt asset "code-explore"')
        expect(diagnostic?.message).toContain("{{missing}}")
      }),
    )

    it.effect("reports prompt.missing_asset when the id does not resolve", () =>
      Effect.gen(function* () {
        const tmp = yield* projectDir({})
        const result = yield* validateSpec({
          value: {
            config: {
              name: "missing-asset",
              nodes: [
                {
                  id: "explore",
                  name: "explore",
                  worker_type: "explore",
                  depends_on: [],
                  prompt_template: { id: "does-not-exist" },
                },
              ],
            },
          },
          source: "env.yaml",
          profile: "environment",
          directory: tmp,
        })
        expect(result.errors.some((d) => d.code === DagValidation.DIAGNOSTIC_CODES.promptMissingAsset)).toBe(true)
      }),
    )

    it.effect("resolves prompt assets from the node's effective execution directory", () =>
      Effect.gen(function* () {
        const owner = yield* tmpdirScoped({ git: true })
        const linkedPath = path.join(os.tmpdir(), `opencode-dag-prompt-${Math.random().toString(36).slice(2)}`)
        yield* Effect.promise(() => $`git worktree add --detach ${linkedPath} HEAD`.cwd(owner).quiet())
        const workspace = yield* Effect.promise(() => fs.realpath(linkedPath))
        yield* Effect.addFinalizer(() =>
          Effect.promise(async () => {
            await $`git worktree remove --force ${workspace}`
              .cwd(owner)
              .quiet()
              .catch(() => undefined)
            await fs.rm(linkedPath, { recursive: true, force: true })
          }),
        )
        const workspacePrompts = path.join(workspace, ".agents", "dag-prompts")
        const ownerPrompts = path.join(owner, ".agents", "dag-prompts")
        const workspaceOnly = `workspace-only-${Math.random().toString(36).slice(2)}`
        const ownerOnly = `owner-only-${Math.random().toString(36).slice(2)}`
        yield* Effect.promise(async () => {
          await fs.mkdir(workspacePrompts, { recursive: true })
          await fs.mkdir(ownerPrompts, { recursive: true })
          await fs.writeFile(path.join(workspacePrompts, `${workspaceOnly}.md`), "Workspace {{target}}")
          await fs.writeFile(path.join(ownerPrompts, `${ownerOnly}.md`), "Owner {{target}}")
        })
        const spec = (promptId: string, execution: { workspace?: string; nodeWorkspace?: string }) => ({
          config: {
            name: "workspace-prompt",
            ...(execution.workspace ? { workspace: execution.workspace } : {}),
            nodes: [
              {
                id: "explore",
                name: "explore",
                worker_type: "explore",
                depends_on: [],
                ...(execution.nodeWorkspace ? { workspace: execution.nodeWorkspace } : {}),
                prompt_template: { id: promptId, input: { target: "dag" } },
              },
            ],
          },
        })
        const validate = (promptId: string, execution: { workspace?: string; nodeWorkspace?: string }) =>
          validateSpec({
            value: spec(promptId, execution),
            source: "env.yaml",
            profile: "environment",
            directory: owner,
          })

        // Only the workspace has the asset: it must resolve, not report missing.
        const workspaceAsset = yield* validate(workspaceOnly, { workspace })
        expect(workspaceAsset.errors.some((d) => d.code === DagValidation.DIAGNOSTIC_CODES.promptMissingAsset)).toBe(
          false,
        )
        expect(workspaceAsset.errors.some((d) => d.code === DagValidation.DIAGNOSTIC_CODES.promptUnboundVariable)).toBe(
          false,
        )

        // Only the owner has the asset: it must not mask the workspace lookup.
        const ownerAsset = yield* validate(ownerOnly, { workspace })
        expect(ownerAsset.errors.some((d) => d.code === DagValidation.DIAGNOSTIC_CODES.promptMissingAsset)).toBe(true)

        // A node workspace overrides the workflow workspace for its prompt.
        const nodeAsset = yield* validate(workspaceOnly, { workspace: owner, nodeWorkspace: workspace })
        expect(nodeAsset.errors.some((d) => d.code === DagValidation.DIAGNOSTIC_CODES.promptMissingAsset)).toBe(false)

        // Fragments cannot carry workspace, so extend/replan must inherit the
        // persisted workflow workspace passed by the caller.
        const authoring = WorkflowAuthoring.make({ loadEnvironment: () => Effect.succeed({}) })
        const fragmentNode = (promptId: string, nodeWorkspace?: string) => ({
          id: "added",
          name: "added",
          worker_type: "explore",
          depends_on: [],
          ...(nodeWorkspace ? { workspace: nodeWorkspace } : {}),
          prompt_template: { id: promptId, input: { target: "dag" } },
        })
        const prepareFragment = (action: "extend" | "replan", promptId: string, nodeWorkspace?: string) =>
          authoring.prepare({
            action,
            source: {
              kind: "inline",
              source: `${action}.yaml`,
              value:
                action === "extend"
                  ? { nodes: [fragmentNode(promptId, nodeWorkspace)] }
                  : { fragment: { name: "replanned", nodes: [fragmentNode(promptId, nodeWorkspace)] } },
            },
            profile: "environment",
            environment: { directory: owner },
            executionWorkspace: workspace,
          })
        const missingAsset = (result: { errors: readonly DagValidation.Diagnostic[] }) =>
          result.errors.some((d) => d.code === DagValidation.DIAGNOSTIC_CODES.promptMissingAsset)

        for (const action of ["extend", "replan"] as const) {
          expect(missingAsset(yield* prepareFragment(action, workspaceOnly))).toBe(false)
          expect(missingAsset(yield* prepareFragment(action, ownerOnly))).toBe(true)
          expect(missingAsset(yield* prepareFragment(action, ownerOnly, owner))).toBe(false)
        }
      }),
    )

    it.effect("worker.unknown is an error and block validation is Skill-catalog independent", () =>
      Effect.gen(function* () {
        const result = yield* validateSpec({
          value: validBlocksSpec,
          source: "<inline>",
          profile: "environment",
          catalogs: {
            worker_types: new Set(["plan", "general"]),
          },
        })
        const unknown = result.errors.filter((d) => d.code === DagValidation.DIAGNOSTIC_CODES.workerUnknown)
        expect(unknown.map((d) => d.message)).toEqual(expect.arrayContaining([expect.stringContaining('"build"')]))
        expect(result.warnings).toEqual([])

        const legacy = yield* validateSpec({
          value: {
            config: {
              ...validBlocksSpec.config,
              blocks: [{ id: "plan", kind: "plan", skills: ["ghost-skill"] }],
            },
          },
          source: "<inline>",
          profile: "environment",
          catalogs: { worker_types: new Set(["plan", "build", "general"]) },
        })
        expect(legacy.valid).toBe(false)
        expect(legacy.errors).toContainEqual(
          expect.objectContaining({
            code: DagValidation.DIAGNOSTIC_CODES.schemaInvalid,
            path: expect.stringContaining("skills"),
          }),
        )
      }),
    )

    it.effect("model.unavailable is reported per unresolved node", () =>
      Effect.gen(function* () {
        const result = yield* validateSpec({
          value: validNodesSpec,
          source: "<inline>",
          profile: "environment",
          catalogs: {
            resolveModel: (node) => Effect.succeed(node.id !== "summarize"),
          },
        })
        const diagnostic = result.errors.find((d) => d.code === DagValidation.DIAGNOSTIC_CODES.modelUnavailable)
        expect(diagnostic?.path).toBe("nodes[summarize]")
      }),
    )
  })

  describe("config repository evidence", () => {
    it.effect("pre-fix prototype-decision-route.yaml fails block compilation (pinned fixture)", () =>
      Effect.gen(function* () {
        const source = yield* Effect.promise(() =>
          Bun.file(
            new URL("./fixtures/config-templates-pre-fix/prototype-decision-route.yaml", import.meta.url),
          ).text(),
        )
        const result = yield* validateSpec({
          value: Bun.YAML.parse(source),
          source: "prototype-decision-route.yaml",
        })
        expect(result.valid).toBe(false)
        const diagnostic = result.errors.find((d) => d.code === DagValidation.DIAGNOSTIC_CODES.blockCompileFailed)
        expect(diagnostic).toBeDefined()
        expect(diagnostic?.message).toContain("verification")
      }),
    )

    it.effect("pre-fix dag-review.yaml prompts are not portable (pinned fixture)", () =>
      Effect.gen(function* () {
        const source = yield* Effect.promise(() =>
          Bun.file(new URL("./fixtures/config-templates-pre-fix/dag-review.yaml", import.meta.url)).text(),
        )
        const result = yield* validateSpec({
          value: Bun.YAML.parse(source),
          source: "dag-review.yaml",
        })
        expect(result.valid).toBe(false)
        const nonportable = result.errors.filter(
          (d) => d.code === DagValidation.DIAGNOSTIC_CODES.promptNonportableAsset,
        )
        const ids = nonportable.map((d) => d.message)
        for (const prompt of ["code-explore", "review-arch", "review-logic", "review-style"]) {
          expect(ids.join("\n")).toContain(prompt)
        }
      }),
    )

    it.effect("every root YAML in the config repository passes portable validation", () =>
      Effect.gen(function* () {
        // Live cross-repo gate: runs where an opencode-dag-config checkout sits
        // next to the runtime repo (or OPENCODAG_CONFIG_REPO points at one).
        const repoDir =
          process.env.OPENCODAG_CONFIG_REPO ??
          path.resolve(import.meta.dir, "..", "..", "..", "..", "opencode-dag-config")
        const yamlFiles = (yield* Effect.promise(() => fs.readdir(repoDir).catch(() => [] as string[]))).filter(
          (name) => name.endsWith(".yaml") || name.endsWith(".yml"),
        )
        // checkout not available — CI pins the evidence above instead
        if (yamlFiles.length === 0) return
        const failures: Array<{ name: string; errors: DagValidation.Diagnostic[] }> = []
        for (const file of yamlFiles.sort()) {
          const text = yield* Effect.promise(() => Bun.file(path.join(repoDir, file)).text())
          const result = yield* validateYaml({ content: text, source: file })
          if (!result.valid) failures.push({ name: file, errors: result.errors })
        }
        expect(failures).toEqual([])
      }),
    )
  })

  describe("verdict vocabulary lint", () => {
    function blocksSpec(objective: string, block: Record<string, unknown>) {
      return {
        config: {
          name: "verdict-vocabulary",
          objective,
          blocks: [{ id: "gate", ...block }],
        },
      }
    }

    it.effect("warns when a review instruction names PASS/BLOCKING", () =>
      Effect.gen(function* () {
        const result = yield* validateSpec({
          value: blocksSpec("Review the change", { kind: "review", instruction: "Return PASS or BLOCKING" }),
          source: "<inline>",
        })
        const warning = result.warnings.find(
          (diagnostic) => diagnostic.code === DagValidation.DIAGNOSTIC_CODES.verdictVocabulary,
        )
        expect(warning?.path).toBe("config.blocks[gate].instruction")
        expect(warning?.message).toContain("PASS")
        expect(warning?.message).toContain("BLOCKING")
      }),
    )

    it.effect("does not warn when the review vocabulary matches", () =>
      Effect.gen(function* () {
        const result = yield* validateSpec({
          value: blocksSpec("Review the change", { kind: "review", instruction: "Return ACCEPT or REJECT" }),
          source: "<inline>",
        })
        expect(
          result.warnings.filter((diagnostic) => diagnostic.code === DagValidation.DIAGNOSTIC_CODES.verdictVocabulary),
        ).toEqual([])
      }),
    )

    it.effect("warns when the shared objective names review words for a verify block", () =>
      Effect.gen(function* () {
        const result = yield* validateSpec({
          value: blocksSpec("Output PASS/BLOCKING", { kind: "verify" }),
          source: "<inline>",
        })
        const warnings = result.warnings.filter(
          (diagnostic) => diagnostic.code === DagValidation.DIAGNOSTIC_CODES.verdictVocabulary,
        )
        expect(warnings.some((warning) => warning.path === "config.objective")).toBe(true)
        expect(warnings.map((warning) => warning.message).join("\n")).toContain("BLOCKING")
        expect(warnings.map((warning) => warning.message).join("\n")).not.toContain("PASS")
      }),
    )

    it.effect("warns when the objective names ACCEPT for a verify-only graph", () =>
      Effect.gen(function* () {
        const result = yield* validateSpec({
          value: blocksSpec("Return ACCEPT or REJECT", { kind: "verify" }),
          source: "<inline>",
        })
        const warnings = result.warnings.filter(
          (diagnostic) => diagnostic.code === DagValidation.DIAGNOSTIC_CODES.verdictVocabulary,
        )
        expect(warnings.map((warning) => warning.message).join("\n")).toContain("ACCEPT")
        expect(warnings.map((warning) => warning.message).join("\n")).toContain("REJECT")
      }),
    )
  })
})

describe("isolation rules", () => {
  const node = (overrides: Partial<NodeConfig> = {}): NodeConfig => ({
    id: "writer",
    name: "Writer",
    worker_type: "build",
    depends_on: [],
    prompt_template: { inline: "do work" },
    isolation: "worktree",
    ...overrides,
  })

  const errors = (nodes: NodeConfig[]) =>
    DagValidation.isolationDiagnostics({
      nodes,
      profile: "portable",
      ownerDirectory: "/repo",
    })

  it.effect("accepts a writer in the portable profile", () =>
    Effect.sync(() => {
      expect(errors([node()])).toEqual([])
    }),
  )

  it.effect("rejects a node that also declares workspace", () =>
    Effect.sync(() => {
      expect(errors([node({ workspace: "/repo/wt" })])).toEqual([
        expect.objectContaining({
          code: DagValidation.DIAGNOSTIC_CODES.isolationInvalid,
          path: "nodes[writer].isolation",
          message: expect.stringContaining("mutually exclusive"),
        }),
      ])
    }),
  )

  it.effect("rejects review and read-only workers", () =>
    Effect.sync(() => {
      expect(errors([node({ id: "review", review: { phase: "diff" } })])[0]?.message).toContain("review node")
      expect(errors([node({ id: "explore", worker_type: "explore" })])[0]?.message).toContain("not write-capable")
    }),
  )

  it.effect("rejects target-sensitive nodes", () =>
    Effect.sync(() => {
      expect(errors([node({ target_sensitive: true })])[0]?.message).toContain("target-sensitive")
    }),
  )

  it.effect("fails closed when the environment profile has no writer catalog", () =>
    Effect.sync(() => {
      const diagnostics = DagValidation.isolationDiagnostics({
        nodes: [node()],
        profile: "environment",
        ownerDirectory: "/repo",
        catalogs: { writer_types: undefined },
      })
      expect(diagnostics.some((diagnostic) => diagnostic.message.includes("writer catalog"))).toBe(true)
    }),
  )
})
