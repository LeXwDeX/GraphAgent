import { describe, expect, test } from "bun:test"
import path from "path"
import { assertProjectRootWritable, hasProjectLayer, HOME_ROOT_ERROR, resolveProjectRoot } from "@/project/project-root"

type Case = {
  name: string
  directory: string
  home: string
  toplevel?: string
  agents: string[]
  expected: string
}

const cases = (await Bun.file(
  path.join(import.meta.dir, "../fixtures/project-root-cases.json"),
).json()) as Case[]

const HOME = "/home/tester"
const expand = (value: string) => value.replaceAll("$HOME", HOME)

describe("resolveProjectRoot", () => {
  for (const item of cases) {
    test(item.name, () => {
      const agents = new Set(item.agents.map(expand))
      expect(
        resolveProjectRoot(expand(item.directory), {
          home: expand(item.home),
          toplevel: item.toplevel ? expand(item.toplevel) : undefined,
          isDirectory: (candidate) => agents.has(candidate),
        }),
      ).toBe(expand(item.expected))
    })
  }
})

describe("assertProjectRootWritable", () => {
  test("rejects $HOME as the project root", () => {
    expect(() => assertProjectRootWritable(HOME, HOME)).toThrow(HOME_ROOT_ERROR)
  })

  test("allows a project root below $HOME", () => {
    expect(() => assertProjectRootWritable(path.join(HOME, "repo"), HOME)).not.toThrow()
  })
})

describe("hasProjectLayer", () => {
  test("treats $HOME as carrying no project layer", () => {
    expect(hasProjectLayer(HOME, HOME)).toBe(false)
  })

  test("treats a directory below $HOME as a project layer", () => {
    expect(hasProjectLayer(path.join(HOME, "repo"), HOME)).toBe(true)
  })
})
