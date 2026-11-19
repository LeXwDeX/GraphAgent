// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test"
import { resolveReleaseVersion } from "../script/release-version"

describe("GraphAgent release versions", () => {
  test("starts the independent main release line at 1.0.0", () => {
    expect(resolveReleaseVersion({ branch: "main", tags: [] })).toEqual({
      channel: "main",
      version: "1.0.0",
      tag: "graphagent-v1.0.0",
      prerelease: false,
      latest: true,
      previous_tag: "",
    })
  })

  test("ignores inherited upstream and historical GraphAgent dev tags", () => {
    expect(
      resolveReleaseVersion({
        branch: "main",
        tags: ["v1.17.11-main.10", "v0.0.0-202608082302", "graphagent-v1.0.0-dev.4"],
      }).version,
    ).toBe("1.0.0")
  })

  test("increments from the latest stable tag despite higher historical dev tags", () => {
    expect(
      resolveReleaseVersion({
        branch: "main",
        tags: ["graphagent-v1.0.9", "graphagent-v1.0.10-dev.2", "graphagent-v1.0.8"],
      }),
    ).toEqual({
      channel: "main",
      version: "1.0.10",
      tag: "graphagent-v1.0.10",
      prerelease: false,
      latest: true,
      previous_tag: "graphagent-v1.0.9",
    })
  })

  test("raises the release to the version floor when the latest stable tag is below it", () => {
    expect(
      resolveReleaseVersion({
        branch: "main",
        tags: ["graphagent-v1.0.96", "graphagent-v1.0.97", "graphagent-v1.0.98-dev.1"],
        floor: "2.0.0",
      }),
    ).toEqual({
      channel: "main",
      version: "2.0.0",
      tag: "graphagent-v2.0.0",
      prerelease: false,
      latest: true,
      previous_tag: "graphagent-v1.0.97",
    })
  })

  test("applies the version floor when no stable tag exists", () => {
    expect(resolveReleaseVersion({ branch: "main", tags: [], floor: "2.0.0" })).toEqual({
      channel: "main",
      version: "2.0.0",
      tag: "graphagent-v2.0.0",
      prerelease: false,
      latest: true,
      previous_tag: "",
    })
  })

  test("continues patch increments once the latest stable tag has reached the floor", () => {
    expect(
      resolveReleaseVersion({
        branch: "main",
        tags: ["graphagent-v1.0.97", "graphagent-v2.0.0"],
        floor: "2.0.0",
      }),
    ).toEqual({
      channel: "main",
      version: "2.0.1",
      tag: "graphagent-v2.0.1",
      prerelease: false,
      latest: true,
      previous_tag: "graphagent-v2.0.0",
    })
  })

  test("ignores a floor that does not exceed the next patch version", () => {
    const tags = ["graphagent-v1.0.97"]

    expect(resolveReleaseVersion({ branch: "main", tags, floor: "1.0.5" }).version).toBe("1.0.98")
    expect(resolveReleaseVersion({ branch: "main", tags, floor: "1.0.98" }).version).toBe("1.0.98")
  })

  test("takes the larger of the floor and the next patch version, comparing segments numerically", () => {
    expect(resolveReleaseVersion({ branch: "main", tags: ["graphagent-v1.0.97"], floor: "1.0.99" }).version).toBe(
      "1.0.99",
    )
    expect(resolveReleaseVersion({ branch: "main", tags: ["graphagent-v1.9.5"], floor: "1.10.0" }).version).toBe(
      "1.10.0",
    )
    expect(resolveReleaseVersion({ branch: "main", tags: ["graphagent-v1.10.0"], floor: "1.9.9" }).version).toBe(
      "1.10.1",
    )
  })

  test("rejects malformed version floors even when the floor would be ignored", () => {
    for (const floor of ["2.0", "v2.0.0", "", "2.0.0.0", "2.0.x", "2.0.0-rc.1", " 2.0.0", "2.0.0\n"]) {
      expect(() => resolveReleaseVersion({ branch: "main", tags: ["graphagent-v2.5.0"], floor })).toThrow(
        "Invalid GraphAgent release floor",
      )
    }
  })

  test("rejects dev and feature branch releases", () => {
    for (const branch of ["dev", "feat/example", ""]) {
      expect(() => resolveReleaseVersion({ branch, tags: [] })).toThrow("GraphAgent releases require main")
    }
  })

  test("wires one resolved version into both the build and GitHub Release", async () => {
    const workflow = await Bun.file(new URL("../../../.github/workflows/release-fork.yml", import.meta.url)).text()

    expect(workflow).not.toContain("inputs.version")
    expect(workflow).not.toContain("0.0.0-")
    expect(workflow).toContain("GRAPHAGENT_CHANNEL: latest")
    expect(workflow).toContain("GRAPHAGENT_VERSION: ${{ needs.version.outputs.version }}")
    expect(workflow).toContain('gh release create "${{ needs.version.outputs.tag }}"')
    expect(workflow).toContain("--latest")
    expect(workflow).not.toContain("--prerelease")
    expect(workflow).toContain("github.ref == 'refs/heads/main'")
    expect(workflow).toContain("previous_tag: ${{ steps.release-version.outputs.previous_tag }}")
    expect(workflow).toContain("needs.version.outputs.previous_tag")
  })

  test("prepares a complete candidate even when publication is disabled", async () => {
    const workflow = await Bun.file(new URL("../../../.github/workflows/release-fork.yml", import.meta.url)).text()
    const prepare = workflow.slice(workflow.indexOf("\n  prepare-release:"), workflow.indexOf("\n  publish-release:"))
    const publish = workflow.slice(workflow.indexOf("\n  publish-release:"), workflow.indexOf("\n  # No-op job"))

    expect(workflow).toContain("default: false")
    expect(prepare).toContain("Generate SHA256SUMS")
    expect(prepare).toContain("Render Release Notes (fail closed)")
    expect(prepare).toContain("Verify Release Candidate")
    expect(prepare).toContain("release-candidate-${{ needs.version.outputs.version }}")
    expect(publish).toContain("if: inputs.create_release")
    expect(publish).toContain("name: release-candidate-${{ needs.version.outputs.version }}")
  })
})
