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

  test("ignores inherited OpenCode and historical GraphAgent dev tags", () => {
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

  test("rejects dev and feature branch releases", () => {
    for (const branch of ["dev", "feat/example", ""]) {
      expect(() => resolveReleaseVersion({ branch, tags: [] })).toThrow("GraphAgent releases require main")
    }
  })

  test("wires one resolved version into both the build and GitHub Release", async () => {
    const workflow = await Bun.file(new URL("../../../.azure-pipelines/release.yml", import.meta.url)).text()

    expect(workflow).not.toContain("0.0.0-")
    expect(workflow).toContain("OPENCODE_CHANNEL: latest")
    expect(workflow).toContain("OPENCODE_VERSION: $[ dependencies.version.outputs['resolve.version'] ]")
    expect(workflow).toContain('gh release create "$RELEASE_TAG"')
    expect(workflow).toContain("RELEASE_TAG: $[ dependencies.version.outputs['resolve.tag'] ]")
    expect(workflow).toContain("--latest")
    expect(workflow).not.toContain("--prerelease")
    expect(workflow).toContain('"$(Build.SourceBranch)" != "refs/heads/main"')
    expect(workflow).toContain("task.setvariable variable=$key;isOutput=true")
    expect(workflow).toContain("dependencies.version.outputs['resolve.previous_tag']")
  })

  test("prepares a complete candidate even when publication is disabled", async () => {
    const workflow = await Bun.file(new URL("../../../.azure-pipelines/release.yml", import.meta.url)).text()
    const prepare = workflow.slice(workflow.indexOf("\n  - job: prepare_release"), workflow.indexOf("\n  - ${{ if parameters.createRelease }}:"))
    const publish = workflow.slice(workflow.indexOf("\n  - ${{ if parameters.createRelease }}:"))

    expect(workflow).toMatch(/name: createRelease\n[^\n]*\n    type: boolean\n    default: false/)
    expect(prepare).toContain("Generate SHA256SUMS")
    expect(prepare).toContain("Render release notes (fail closed)")
    expect(prepare).toContain("Verify release candidate")
    expect(prepare).toContain("artifact: release-candidate-$(RELEASE_VERSION)")
    expect(publish).toContain("job: publish_release")
    expect(publish).toContain("artifact: release-candidate-$(RELEASE_VERSION)")
    expect(publish).toContain("GH_TOKEN: $(GITHUB_RELEASE_TOKEN)")
  })
})
