import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, unlink } from "fs/promises"
import os from "os"
import path from "path"
import {
  APACHE_COPYRIGHT,
  APACHE_IDENTIFIER,
  CONTRIBUTING_REQUIRED_VALUES,
  FORBIDDEN_LICENSE_CODE,
  NOTICE_REQUIRED_VALUES,
  checkLicense,
} from "../../../script/check-license"

const tempRoots: string[] = []
const upstreamA = "src/upstream-a.ts"
const upstreamB = "src/upstream-b.ts"
const forkFile = "src/fork.ts"

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("license model", () => {
  test("accepts a repository that follows the two rules", async () => {
    const fixture = await createFixture()
    expect(await checkLicense(fixture.root, { trackedFiles: fixture.tracked })).toEqual([])
  })

  test("rejects an unsorted upstream list", async () => {
    const fixture = await createFixture({ upstreamList: `${upstreamB}\n${upstreamA}\n` })
    expect(codes(await checkLicense(fixture.root, { trackedFiles: fixture.tracked }))).toContain(
      "upstream-list-unsorted",
    )
  })

  test("rejects duplicate upstream entries", async () => {
    const fixture = await createFixture({ upstreamList: `${upstreamA}\n${upstreamA}\n${upstreamB}\n` })
    expect(codes(await checkLicense(fixture.root, { trackedFiles: fixture.tracked }))).toContain(
      "upstream-list-duplicate",
    )
  })

  test("rejects an upstream entry that is not a tracked file", async () => {
    const fixture = await createFixture({ upstreamList: `${upstreamA}\n${upstreamB}\nsrc/deleted.ts\n` })
    expect(codes(await checkLicense(fixture.root, { trackedFiles: fixture.tracked }))).toContain("stale-upstream-entry")
  })

  test("rejects a fork source file without the Apache header", async () => {
    const fixture = await createFixture({ forkHeader: "export const fork = true\n" })
    expect(codes(await checkLicense(fixture.root, { trackedFiles: fixture.tracked }))).toContain(
      "missing-apache-header",
    )
  })

  test("rejects an Apache header on an upstream file", async () => {
    const fixture = await createFixture({ upstreamHeader: apacheHeader() })
    expect(codes(await checkLicense(fixture.root, { trackedFiles: fixture.tracked }))).toContain(
      "wrong-header-on-upstream",
    )
  })

  test("rejects a leftover reference to the retired license", async () => {
    const retired = ["a", "g", "p", "l"].join("")
    const fixture = await createFixture({ forbidden: `// SPDX-License-Identifier: ${retired}-3.0-or-later\n` })
    expect(codes(await checkLicense(fixture.root, { trackedFiles: fixture.tracked }))).toContain(FORBIDDEN_LICENSE_CODE)
  })

  test("rejects a package.json license that disagrees with its file set", async () => {
    const fixture = await createFixture({ packageLicense: "MIT" })
    expect(codes(await checkLicense(fixture.root, { trackedFiles: fixture.tracked }))).toContain(
      "package-license-mismatch",
    )
  })

  test("rejects a missing license text", async () => {
    const fixture = await createFixture()
    await unlink(path.join(fixture.root, "LICENSE-APACHE"))
    expect(codes(await checkLicense(fixture.root, { trackedFiles: fixture.tracked }))).toContain("missing-license-file")
  })

  test("rejects a NOTICE without the attribution statement", async () => {
    const fixture = await createFixture({
      notice: `${NOTICE_REQUIRED_VALUES.filter((value) => value !== "Apache-2.0").join("\n")}\n`,
    })
    expect(codes(await checkLicense(fixture.root, { trackedFiles: fixture.tracked }))).toContain("notice-missing-value")
  })
})

type FixtureOptions = {
  upstreamList?: string
  forkHeader?: string
  upstreamHeader?: string
  forbidden?: string
  packageLicense?: string
  notice?: string
}

async function createFixture(options: FixtureOptions = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "license-"))
  tempRoots.push(root)
  await mkdir(path.join(root, "src"), { recursive: true })
  await mkdir(path.join(root, "config_assistant"), { recursive: true })
  const tracked = [
    "LICENSE",
    "LICENSE-APACHE",
    "NOTICE",
    "CONTRIBUTING.md",
    "config_assistant/LICENSE",
    "LICENSE-UPSTREAM.txt",
    upstreamA,
    upstreamB,
    forkFile,
    "package.json",
  ]
  await Promise.all([
    Bun.write(path.join(root, "LICENSE"), "MIT\n"),
    Bun.write(path.join(root, "LICENSE-APACHE"), "Apache-2.0\n"),
    Bun.write(path.join(root, "NOTICE"), options.notice ?? `${NOTICE_REQUIRED_VALUES.join("\n")}\n`),
    Bun.write(path.join(root, "CONTRIBUTING.md"), `${CONTRIBUTING_REQUIRED_VALUES.join("\n")}\n`),
    Bun.write(path.join(root, "config_assistant", "LICENSE"), "Apache-2.0\n"),
    Bun.write(path.join(root, "LICENSE-UPSTREAM.txt"), options.upstreamList ?? `${upstreamA}\n${upstreamB}\n`),
    Bun.write(path.join(root, upstreamA), options.upstreamHeader ?? "export const upstreamA = true\n"),
    Bun.write(path.join(root, upstreamB), "export const upstreamB = true\n"),
    Bun.write(path.join(root, forkFile), options.forbidden ?? options.forkHeader ?? apacheHeader()),
    Bun.write(
      path.join(root, "package.json"),
      JSON.stringify({ name: "fixture", license: options.packageLicense ?? "Apache-2.0 AND MIT" }),
    ),
  ])
  return { root, tracked }
}

function apacheHeader() {
  return `// ${APACHE_COPYRIGHT}\n// ${APACHE_IDENTIFIER}\n\nexport const fork = true\n`
}

function codes(issues: { code: string }[]) {
  return issues.map((issue) => issue.code)
}
