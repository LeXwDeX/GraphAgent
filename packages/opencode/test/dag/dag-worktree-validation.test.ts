import { describe, expect, it } from "bun:test"
import { $ } from "bun"
import { Effect, Schema } from "effect"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { DagValidation } from "@/dag/validation"
import type { NodeConfig } from "@/dag/dag"
import { tmpdir } from "../fixture/fixture"

function validate(input: { directory: string; objective?: string; instruction: string }) {
  return Effect.runPromise(
    DagValidation.validatePostCompile({
      source: "test",
      profile: "environment",
      config: input.objective ? { objective: input.objective } : {},
      nodes: [
        {
          id: "n1",
          name: "N1",
          worker_type: "build",
          depends_on: [],
          prompt_template: { inline: input.instruction },
        },
      ],
      directory: input.directory,
      structural: false,
    }),
  )
}

function mismatchWarnings(result: Awaited<ReturnType<typeof validate>>) {
  return result.warnings.filter((warning) => warning.code === DagValidation.DIAGNOSTIC_CODES.workspaceWorktreeMismatch)
}

async function gitRepoWithLinkedWorktree() {
  let linked = ""
  const tmp = await tmpdir({
    git: true,
    init: async (directory) => {
      linked = path.join(os.tmpdir(), `opencode-worktree-${Math.random().toString(36).slice(2)}`)
      await $`git worktree add --detach ${linked} HEAD`.cwd(directory).quiet()
      // macOS temp paths resolve through /private; match git's canonical form.
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
  return { tmp, linked: linked }
}

describe("workflow validate: worktree mismatch", () => {
  it("warns when an instruction names a linked worktree the workflow will not run in", async () => {
    const { tmp, linked } = await gitRepoWithLinkedWorktree()
    await using _ = tmp
    const result = await validate({ directory: tmp.path, instruction: `Make the change in ${linked}.` })
    expect(result.valid).toBe(true)
    expect(mismatchWarnings(result)).toEqual([
      expect.objectContaining({
        severity: "warning",
        path: "nodes[n1].prompt_template.inline",
        message: expect.stringContaining(linked),
      }),
    ])
  })

  it("does not warn when the instruction names the execution directory", async () => {
    const { tmp } = await gitRepoWithLinkedWorktree()
    await using _ = tmp
    const result = await validate({ directory: tmp.path, instruction: `Make the change in ${tmp.path}.` })
    expect(mismatchWarnings(result)).toEqual([])
  })

  it("warns on the objective too", async () => {
    const { tmp, linked } = await gitRepoWithLinkedWorktree()
    await using _ = tmp
    const result = await validate({
      directory: tmp.path,
      objective: `Deliver from ${linked}.`,
      instruction: "No absolute path here.",
    })
    expect(mismatchWarnings(result)).toEqual([
      expect.objectContaining({ path: "config.objective", message: expect.stringContaining(linked) }),
    ])
  })

  it("skips the check outside git", async () => {
    await using tmp = await tmpdir()
    const result = await validate({ directory: tmp.path, instruction: `Make the change in ${tmp.path}/sub.` })
    expect(mismatchWarnings(result)).toEqual([])
  })
})

function isolationNode(overrides: Partial<NodeConfig> = {}): NodeConfig {
  return {
    id: "n1",
    name: "N1",
    worker_type: "build",
    depends_on: [],
    prompt_template: { inline: "do work" },
    ...overrides,
  }
}

function validateNodes(input: {
  directory: string
  nodes: NodeConfig[]
  profile?: "environment" | "portable"
  workspace?: string
}) {
  return Effect.runPromise(
    DagValidation.validatePostCompile({
      source: "test",
      profile: input.profile ?? "environment",
      config: input.workspace ? { workspace: input.workspace } : {},
      nodes: input.nodes,
      directory: input.directory,
      structural: false,
    }),
  )
}

function isolationErrors(result: Awaited<ReturnType<typeof validateNodes>>) {
  return result.errors.filter((error) => error.code === DagValidation.DIAGNOSTIC_CODES.isolationInvalid)
}

describe("workflow validate: isolation", () => {
  it("accepts a writer in a clean git target", async () => {
    await using tmp = await tmpdir({ git: true })
    const result = await validateNodes({
      directory: tmp.path,
      nodes: [isolationNode({ isolation: "worktree" })],
    })
    expect(isolationErrors(result)).toEqual([])
    expect(result.valid).toBe(true)
  })

  it("rejects isolation combined with workspace", async () => {
    await using tmp = await tmpdir({ git: true })
    const result = await validateNodes({
      directory: tmp.path,
      nodes: [isolationNode({ isolation: "worktree", workspace: tmp.path })],
    })
    expect(isolationErrors(result).map((error) => error.path)).toEqual(["nodes[n1].isolation"])
    expect(isolationErrors(result)[0]?.message).toContain("mutually exclusive")
  })

  it("rejects a review node", async () => {
    await using tmp = await tmpdir({ git: true })
    const result = await validateNodes({
      directory: tmp.path,
      nodes: [isolationNode({ isolation: "worktree", review: { phase: "design" } })],
    })
    expect(isolationErrors(result)[0]?.message).toContain("review node")
  })

  it("rejects read-only builtin workers", async () => {
    await using tmp = await tmpdir({ git: true })
    const result = await validateNodes({
      directory: tmp.path,
      nodes: [isolationNode({ isolation: "worktree", worker_type: "explore" })],
    })
    expect(isolationErrors(result)[0]?.message).toContain("not write-capable")
  })

  it("rejects a non-git target", async () => {
    await using tmp = await tmpdir()
    const result = await validateNodes({
      directory: tmp.path,
      nodes: [isolationNode({ isolation: "worktree" })],
    })
    expect(isolationErrors(result)[0]?.message).toContain("requires a git target")
  })

  it("rejects a dirty target", async () => {
    await using tmp = await tmpdir({ git: true })
    await fs.writeFile(path.join(tmp.path, "dirty.txt"), "dirty")
    const result = await validateNodes({
      directory: tmp.path,
      nodes: [isolationNode({ isolation: "worktree" })],
    })
    expect(isolationErrors(result)[0]?.message).toContain("requires a clean target")
  })

  it("keeps git facts out of the portable profile", async () => {
    await using tmp = await tmpdir()
    const result = await validateNodes({
      directory: tmp.path,
      profile: "portable",
      nodes: [isolationNode({ isolation: "worktree" })],
    })
    expect(isolationErrors(result)).toEqual([])
  })

  it("decodes only the literal worktree value", () => {
    const decode = Schema.decodeUnknownSync(DagValidation.NodeSchema)
    expect(
      decode({
        id: "n1",
        name: "N1",
        worker_type: "build",
        depends_on: [],
        prompt_template: { inline: "do work" },
        isolation: "worktree",
      }).isolation,
    ).toBe("worktree")
    expect(() =>
      decode({
        id: "n1",
        name: "N1",
        worker_type: "build",
        depends_on: [],
        prompt_template: { inline: "do work" },
        isolation: "container",
      }),
    ).toThrow()
  })
})
