import { describe, expect, it } from "bun:test"
import { $ } from "bun"
import { Effect } from "effect"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { DagLocation } from "@/dag/location"
import { WorkflowAuthoring } from "@/dag/authoring"
import { DagValidation } from "@/dag/validation"
import { tmpdir } from "../fixture/fixture"

async function gitRepoWithLinkedWorktree() {
  let linked = ""
  const tmp = await tmpdir({
    git: true,
    init: async (directory) => {
      linked = path.join(os.tmpdir(), `opencode-workspace-${Math.random().toString(36).slice(2)}`)
      await $`git worktree add --detach ${linked} HEAD`.cwd(directory).quiet()
      linked = await fs.realpath(linked)
    },
    dispose: async () => {
      if (!linked) return
      try {
        await $`git worktree remove --force ${linked}`.quiet()
      } catch {
        // The sandbox cleanup below removes leftovers.
      }
    },
  })
  return { tmp, linked }
}

function validate(input: {
  directory: string
  workspace?: string
  nodeWorkspace?: string
  objective?: string
  nodeInline?: string
}) {
  return Effect.runPromise(
    DagValidation.validatePostCompile({
      source: "test",
      profile: "environment",
      config:
        input.workspace !== undefined || input.objective !== undefined
          ? {
              ...(input.workspace !== undefined ? { workspace: input.workspace } : {}),
              ...(input.objective !== undefined ? { objective: input.objective } : {}),
            }
          : {},
      nodes: [
        {
          id: "n1",
          name: "N1",
          worker_type: "build",
          depends_on: [],
          prompt_template: { inline: input.nodeInline ?? "work" },
          ...(input.nodeWorkspace !== undefined ? { workspace: input.nodeWorkspace } : {}),
        },
      ],
      directory: input.directory,
      structural: false,
    }),
  )
}

const workspaceErrors = (result: Awaited<ReturnType<typeof validate>>) =>
  result.errors.filter((error) => error.code === DagValidation.DIAGNOSTIC_CODES.workspaceInvalid)

describe("workflow validate: workspace binding", () => {
  it("accepts an absolute linked worktree of the same project", async () => {
    const { tmp, linked } = await gitRepoWithLinkedWorktree()
    await using _ = tmp
    const result = await validate({ directory: tmp.path, workspace: linked })
    expect(result.valid).toBe(true)
    expect(workspaceErrors(result)).toEqual([])
  })

  it("accepts the main checkout as a worktree", async () => {
    const { tmp } = await gitRepoWithLinkedWorktree()
    await using _ = tmp
    const result = await validate({ directory: tmp.path, workspace: await fs.realpath(tmp.path) })
    expect(result.valid).toBe(true)
  })

  it("rejects a missing workspace", async () => {
    const { tmp } = await gitRepoWithLinkedWorktree()
    await using _ = tmp
    const missing = path.join(os.tmpdir(), `does-not-exist-${Math.random().toString(36).slice(2)}`)
    const result = await validate({ directory: tmp.path, workspace: missing })
    expect(result.valid).toBe(false)
    expect(workspaceErrors(result)).toEqual([
      expect.objectContaining({ path: "config.workspace", message: expect.stringContaining("does not exist") }),
    ])
  })

  it("rejects a workspace from another project", async () => {
    const { tmp } = await gitRepoWithLinkedWorktree()
    await using _ = tmp
    await using other = await tmpdir({ git: true })
    const result = await validate({ directory: tmp.path, workspace: other.path })
    expect(workspaceErrors(result)).toEqual([
      expect.objectContaining({ path: "config.workspace", message: expect.stringContaining("different project") }),
    ])
  })

  it("rejects a directory that is not a linked worktree", async () => {
    const { tmp } = await gitRepoWithLinkedWorktree()
    await using _ = tmp
    const plain = path.join(tmp.path, "plain")
    await fs.mkdir(plain)
    const result = await validate({ directory: tmp.path, workspace: plain })
    expect(workspaceErrors(result)).toEqual([
      expect.objectContaining({ path: "config.workspace", message: expect.stringContaining("not a linked worktree") }),
    ])
  })

  it("rejects a relative workspace", async () => {
    const { tmp } = await gitRepoWithLinkedWorktree()
    await using _ = tmp
    const result = await validate({ directory: tmp.path, workspace: "../sibling" })
    expect(workspaceErrors(result)).toEqual([
      expect.objectContaining({ path: "config.workspace", message: expect.stringContaining("absolute path") }),
    ])
  })

  it("validates a node-level workspace", async () => {
    const { tmp, linked } = await gitRepoWithLinkedWorktree()
    await using _ = tmp
    expect(workspaceErrors(await validate({ directory: tmp.path, nodeWorkspace: linked }))).toEqual([])
    const missing = path.join(os.tmpdir(), `missing-${Math.random().toString(36).slice(2)}`)
    expect(workspaceErrors(await validate({ directory: tmp.path, nodeWorkspace: missing }))).toEqual([
      expect.objectContaining({ path: "nodes[n1].workspace" }),
    ])
  })

  it("reports relative workspace syntax in the portable profile", async () => {
    const result = await Effect.runPromise(
      DagValidation.validatePostCompile({
        source: "test",
        profile: "portable",
        config: { workspace: "relative/workspace" },
        nodes: [
          {
            id: "n1",
            name: "N1",
            worker_type: "build",
            depends_on: [],
            prompt_template: { inline: "work" },
            workspace: "also-relative",
          },
        ],
        structural: false,
      }),
    )
    expect(workspaceErrors(result).map((error) => error.path)).toEqual(["config.workspace", "nodes[n1].workspace"])
    expect(workspaceErrors(result).every((error) => error.message.includes("absolute path"))).toBe(true)
  })

  it("keeps non-git workflows valid when no workspace is bound", async () => {
    await using tmp = await tmpdir()
    const result = await validate({ directory: tmp.path })
    expect(result.valid).toBe(true)
    expect(workspaceErrors(result)).toEqual([])
  })

  it("rejects any workspace outside a git project", async () => {
    await using tmp = await tmpdir()
    await using other = await tmpdir()
    const result = await validate({ directory: tmp.path, workspace: other.path })
    expect(workspaceErrors(result)).toEqual([
      expect.objectContaining({ path: "config.workspace", message: expect.stringContaining("git project") }),
    ])
  })
})

describe("DagLocation execution directory", () => {
  it("checks the bound workspace and falls back to the owner directory", async () => {
    const { tmp, linked } = await gitRepoWithLinkedWorktree()
    await using _ = tmp
    expect(DagLocation.resolveExecution({ directory: tmp.path, executionDirectory: linked })).toEqual({
      _tag: "ok",
      directory: linked,
    })
    expect(DagLocation.resolveExecution({ directory: tmp.path, executionDirectory: null })).toEqual({
      _tag: "ok",
      directory: tmp.path,
    })
    const missing = path.join(os.tmpdir(), `missing-${Math.random().toString(36).slice(2)}`)
    expect(DagLocation.resolveExecution({ directory: tmp.path, executionDirectory: missing })).toEqual({
      _tag: "missing",
      directory: missing,
    })
  })

  it("rejects a bound workspace replaced by a foreign repository", async () => {
    const { tmp, linked } = await gitRepoWithLinkedWorktree()
    await using _ = tmp
    await $`git -C ${tmp.path} worktree remove --force ${linked}`.quiet()
    await fs.mkdir(linked)
    await $`git init ${linked}`.quiet()
    try {
      const location = DagLocation.resolveExecution({ directory: tmp.path, executionDirectory: linked })
      expect(location).toEqual({
        _tag: "invalid",
        directory: linked,
        reason: expect.stringContaining("different project"),
      })
    } finally {
      await fs.rm(linked, { recursive: true, force: true })
    }
  })

  it("rejects a bound workspace replaced by a plain directory", async () => {
    await using tmp = await tmpdir({ git: true })
    const linked = path.join(tmp.path, "plain-workspace")
    await fs.mkdir(linked)
    const location = DagLocation.resolveExecution({ directory: tmp.path, executionDirectory: linked })
    expect(location).toEqual({
      _tag: "invalid",
      directory: linked,
      reason: expect.stringContaining("not a linked worktree"),
    })
  })

  it("rejects a bound workspace that resolves through a new symlink", async () => {
    const { tmp, linked } = await gitRepoWithLinkedWorktree()
    await using _ = tmp
    const alias = path.join(os.tmpdir(), `opencode-workspace-alias-${Math.random().toString(36).slice(2)}`)
    await fs.symlink(linked, alias)
    try {
      const location = DagLocation.resolveExecution({ directory: tmp.path, executionDirectory: alias })
      expect(location).toEqual({
        _tag: "invalid",
        directory: alias,
        reason: expect.stringContaining("resolves to"),
      })
    } finally {
      await fs.rm(alias, { force: true })
    }
  })
})

describe("workflow authoring: workspace binding", () => {
  it("prepares a start graph with the bound workspace and realpath", async () => {
    const { tmp, linked } = await gitRepoWithLinkedWorktree()
    await using _ = tmp
    const authoring = WorkflowAuthoring.make({ loadEnvironment: () => Effect.succeed({}) })
    const result = await Effect.runPromise(
      authoring.prepare({
        action: "start",
        source: {
          kind: "inline",
          value: {
            config: {
              name: "workspace",
              workspace: linked,
              nodes: [
                {
                  id: "n1",
                  name: "N1",
                  worker_type: "build",
                  depends_on: [],
                  prompt_template: { inline: "work" },
                },
              ],
            },
          },
        },
        profile: "environment",
        environment: { directory: tmp.path },
      }),
    )
    expect(result.valid).toBe(true)
    expect(result.prepared?.action).toBe("start")
    if (result.prepared?.action !== "start") return
    expect(result.prepared.config.workspace).toBe(linked)
  })

  it("rejects a missing workspace before start", async () => {
    const { tmp } = await gitRepoWithLinkedWorktree()
    await using _ = tmp
    const authoring = WorkflowAuthoring.make({ loadEnvironment: () => Effect.succeed({}) })
    const missing = path.join(os.tmpdir(), `missing-${Math.random().toString(36).slice(2)}`)
    const result = await Effect.runPromise(
      authoring.prepare({
        action: "start",
        source: {
          kind: "inline",
          value: {
            config: {
              name: "workspace",
              workspace: missing,
              nodes: [
                {
                  id: "n1",
                  name: "N1",
                  worker_type: "build",
                  depends_on: [],
                  prompt_template: { inline: "work" },
                },
              ],
            },
          },
        },
        profile: "environment",
        environment: { directory: tmp.path },
      }),
    )
    expect(result.valid).toBe(false)
    expect(result.prepared).toBeUndefined()
    expect(result.errors).toEqual([
      expect.objectContaining({ code: DagValidation.DIAGNOSTIC_CODES.workspaceInvalid, path: "config.workspace" }),
    ])
  })
})

describe("workflow validate: worktree mismatch uses the execution workspace", () => {
  const mismatches = (result: Awaited<ReturnType<typeof validate>>) =>
    result.warnings.filter(
      (warning) => warning.code === DagValidation.DIAGNOSTIC_CODES.workspaceWorktreeMismatch,
    )

  it("does not warn when the objective names the config workspace", async () => {
    const { tmp, linked } = await gitRepoWithLinkedWorktree()
    await using _ = tmp
    const result = await validate({
      directory: tmp.path,
      workspace: linked,
      objective: `Inspect ${linked} before changing files.`,
    })
    expect(mismatches(result)).toEqual([])
  })

  it("warns when the objective names the owner worktree but the config workspace executes", async () => {
    const { tmp, linked } = await gitRepoWithLinkedWorktree()
    await using _ = tmp
    const result = await validate({
      directory: tmp.path,
      workspace: linked,
      objective: `Inspect ${tmp.path} before changing files.`,
    })
    expect(mismatches(result)).toEqual([
      expect.objectContaining({
        path: "config.objective",
        message: expect.stringContaining(linked),
      }),
    ])
  })

  it("does not warn when a node instruction names its node workspace", async () => {
    const { tmp, linked } = await gitRepoWithLinkedWorktree()
    await using _ = tmp
    const result = await validate({
      directory: tmp.path,
      nodeWorkspace: linked,
      nodeInline: `Read ${linked}/README.md first.`,
    })
    expect(mismatches(result)).toEqual([])
  })

  it("warns when a node instruction names the config workspace but the node executes elsewhere", async () => {
    const { tmp, linked } = await gitRepoWithLinkedWorktree()
    await using _ = tmp
    const result = await validate({
      directory: tmp.path,
      workspace: linked,
      objective: `Inspect ${linked} before changing files.`,
      nodeInline: `Read ${tmp.path}/README.md first.`,
    })
    expect(mismatches(result)).toEqual([
      expect.objectContaining({
        path: "nodes[n1].prompt_template.inline",
        message: expect.stringContaining(linked),
      }),
    ])
  })
})
