import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { seriesFileFor, validateAndRender } from "../script/release-notes"

// Fixtures derive their headings from the live template so that editing a
// template emoji, order, or heading count changes test outcome instead of
// silently drifting away from the grammar the validator enforces.
const template = await Bun.file(new URL("../../../.github/RELEASE_NOTES_TEMPLATE.md", import.meta.url)).text()
const headings = template.split(/\r?\n/).filter((line) => line.startsWith("### "))

const input = {
  version: "1.0.10",
  channel: "main",
  branch: "main",
  tag: "graphagent-v1.0.10",
  previousTag: "graphagent-v1.0.9",
  repo: "LeXwDeX/OpenCode-GraphAgent",
} as const

const devInput = {
  version: "1.0.10-dev.3",
  channel: "dev",
  branch: "dev",
  tag: "graphagent-v1.0.10-dev.3",
  previousTag: "graphagent-v1.0.9",
  repo: input.repo,
} as const

type Section = { heading: string; body: string }

const defaultIntro = "{Prerelease/Stable} release from `{branch}` branch. Ships the fail-closed release notes harness."

function changelogLine(repo: string) {
  return `**Full changelog:** [\`{previous_tag}\`...\`{current_tag}\`](https://github.com/${repo}/compare/{previous_tag}...{current_tag})`
}

function expectedFinalLine(source: { previousTag: string; tag: string; repo: string }) {
  return `**Full changelog:** [\`${source.previousTag}\`...\`${source.tag}\`](https://github.com/${source.repo}/compare/${source.previousTag}...${source.tag})`
}

function defaultSections(): Section[] {
  return [
    {
      heading: headings[0],
      body: "- **Notes harness**: Series files render through a validator that fails closed on every rule.",
    },
    { heading: headings[1], body: "- **Placeholder notes**: Releases no longer publish a placeholder body." },
    {
      heading: headings[2],
      body: "- **Renderer**: One script renders and validates the series file before the release exists.",
    },
    {
      heading: headings[3],
      body: "- The release job renders notes from the committed series file before creating the release.",
    },
    { heading: headings[4], body: "- No dependency changes in this series." },
    {
      heading: headings[5],
      body: "```\nrelease-notes: 12 pass\ntotal: 12 tests, 0 failures\ntypecheck: 1/1 packages green\n```",
    },
    { heading: headings[6], body: "Rendered with bun test from packages/opencode and mutation-checked rule by rule." },
  ]
}

function buildSource(options: { sections?: Section[]; intro?: string; title?: string; finalLine?: string }) {
  return [
    options.title ?? "## opencode {VERSION}",
    "",
    options.intro ?? defaultIntro,
    "",
    "---",
    "",
    ...(options.sections ?? defaultSections()).flatMap((section) => [section.heading, "", section.body, "", "---", ""]),
    options.finalLine ?? changelogLine(input.repo),
  ].join("\n")
}

describe("release notes series resolution", () => {
  test("maps both channels of one series to the same series file", () => {
    expect(seriesFileFor("1.0.10")).toBe(".github/releases/v1.0.10.md")
    expect(seriesFileFor("1.0.10-dev.3")).toBe(".github/releases/v1.0.10.md")
  })

  test("rejects malformed versions", () => {
    expect(() => seriesFileFor("main")).toThrow()
    expect(() => seriesFileFor("1.0")).toThrow()
    expect(() => seriesFileFor("")).toThrow()
  })
})

describe("release notes rendering", () => {
  test("renders a valid stable series file", () => {
    const rendered = validateAndRender(buildSource({}), input)

    expect(rendered).toContain("## opencode 1.0.10")
    expect(rendered).toContain("Stable release from `main` branch.")
    expect(rendered).not.toContain("{")
    expect(rendered).not.toContain("}")
    expect(rendered.endsWith(expectedFinalLine(input))).toBe(true)
  })

  test("renders the same series file for a dev prerelease of that series", () => {
    const rendered = validateAndRender(buildSource({}), devInput)

    expect(rendered).toContain("## opencode 1.0.10-dev.3")
    expect(rendered).toContain("Prerelease release from `dev` branch.")
    expect(rendered.endsWith(expectedFinalLine(devInput))).toBe(true)
    expect(rendered).not.toContain("{")
  })
})

describe("release notes grammar (fail closed)", () => {
  test("rejects a title that does not match the released version", () => {
    expect(() => validateAndRender(buildSource({ title: "## opencode 9.9.9" }), input)).toThrow("[release-notes]")
  })

  test("rejects a hardcoded channel or branch word in the intro", () => {
    const stableWord = "Stable release from `dev` branch. Ships the harness."
    expect(() => validateAndRender(buildSource({ intro: stableWord }), devInput)).toThrow("[release-notes]")
    const mainBranch = "Prerelease release from `main` branch. Ships the harness."
    expect(() => validateAndRender(buildSource({ intro: mainBranch }), devInput)).toThrow("[release-notes]")
  })

  test("rejects unknown, de-variated, duplicated, or reordered headings", () => {
    const sections = defaultSections()
    const unknown = sections.toSpliced(0, 1, { heading: "### 🎁 Gifts", body: sections[0].body })
    expect(() => validateAndRender(buildSource({ sections: unknown }), input)).toThrow("[release-notes]")

    for (const index of [2, 3]) {
      const devariated = sections.toSpliced(index, 1, {
        heading: headings[index].replaceAll("\uFE0F", ""),
        body: sections[index].body,
      })
      expect(() => validateAndRender(buildSource({ sections: devariated }), input)).toThrow("[release-notes]")
    }

    const duplicated = [sections[0], sections[0], ...sections.slice(1)]
    expect(() => validateAndRender(buildSource({ sections: duplicated }), input)).toThrow("[release-notes]")

    const reordered = [sections[1], sections[0], ...sections.slice(2)]
    expect(() => validateAndRender(buildSource({ sections: reordered }), input)).toThrow("[release-notes]")
  })

  test("rejects a missing Test Summary or Verification section", () => {
    expect(() => validateAndRender(buildSource({ sections: defaultSections().toSpliced(5, 1) }), input)).toThrow(
      "[release-notes]",
    )
    expect(() => validateAndRender(buildSource({ sections: defaultSections().toSpliced(6, 1) }), input)).toThrow(
      "[release-notes]",
    )
  })

  test("rejects a file with no change section at all", () => {
    expect(() => validateAndRender(buildSource({ sections: defaultSections().slice(5) }), input)).toThrow(
      "[release-notes]",
    )
  })

  test("rejects an empty section body", () => {
    const emptied = defaultSections().toSpliced(0, 1, { heading: headings[0], body: "" })
    expect(() => validateAndRender(buildSource({ sections: emptied }), input)).toThrow("[release-notes]")
  })

  test("rejects a Test Summary without a non-empty fenced block", () => {
    const plain = defaultSections().toSpliced(5, 1, { heading: headings[5], body: "All 12 tests passed." })
    expect(() => validateAndRender(buildSource({ sections: plain }), input)).toThrow("[release-notes]")
    const emptyFence = defaultSections().toSpliced(5, 1, { heading: headings[5], body: "```\n```" })
    expect(() => validateAndRender(buildSource({ sections: emptyFence }), input)).toThrow("[release-notes]")
  })

  test("rejects doubled, missing, or stray --- separators", () => {
    const source = buildSource({})
    const doubled = source.replace(`---\n\n${headings[0]}`, `---\n\n---\n\n${headings[0]}`)
    expect(() => validateAndRender(doubled, input)).toThrow("[release-notes]")
    const missing = source.replace(`\n\n---\n\n${headings[0]}`, `\n\n${headings[0]}`)
    expect(() => validateAndRender(missing, input)).toThrow("[release-notes]")
    const stray = defaultSections().toSpliced(1, 1, { heading: headings[1], body: "- One fix.\n---\n- Another fix." })
    expect(() => validateAndRender(buildSource({ sections: stray }), input)).toThrow("[release-notes]")
  })

  test("rejects a wrong final changelog line", () => {
    const bareRange = "**Full changelog:** `{previous_tag}...{current_tag}`"
    expect(() => validateAndRender(buildSource({ finalLine: bareRange }), input)).toThrow("[release-notes]")
    const wrongRepo = changelogLine("some-other/repo")
    expect(() => validateAndRender(buildSource({ finalLine: wrongRepo }), input)).toThrow("[release-notes]")
    const wrongTag = expectedFinalLine(input).replaceAll(input.tag, "graphagent-v1.0.11")
    expect(() => validateAndRender(buildSource({ finalLine: wrongTag }), input)).toThrow("[release-notes]")
    expect(() => validateAndRender(buildSource({ finalLine: "That is all." }), input)).toThrow("[release-notes]")
  })

  test("rejects an empty previous tag or a tag that does not match the version", () => {
    expect(() => validateAndRender(buildSource({}), { ...input, previousTag: "" })).toThrow("[release-notes]")
    expect(() => validateAndRender(buildSource({}), { ...input, tag: "graphagent-v9.9.9" })).toThrow("[release-notes]")
  })

  test("rejects residual placeholders anywhere in the rendered notes", () => {
    const residual = defaultSections().toSpliced(0, 1, {
      heading: headings[0],
      body: "- **Notes harness**: Uses {summary} to describe the change.",
    })
    expect(() => validateAndRender(buildSource({ sections: residual }), input)).toThrow("[release-notes]")
  })

  test("rejects non-ASCII prose outside the emoji headings", () => {
    const accented = defaultSections().toSpliced(0, 1, { heading: headings[0], body: "- Adds café support." })
    expect(() => validateAndRender(buildSource({ sections: accented }), input)).toThrow("[release-notes]")
    const emDash = "Stable release from `main` branch. Adds rich text — with an em dash."
    expect(() => validateAndRender(buildSource({ intro: emDash }), input)).toThrow("[release-notes]")
  })
})

const notesScript = path.resolve(import.meta.dir, "../script/release-notes.ts")

async function runNotesScript(options: { dir: string; out: string; version?: string }) {
  const version = options.version ?? input.version
  const child = Bun.spawn(
    [
      "bun",
      "run",
      notesScript,
      "--notes-dir",
      ".github/releases",
      "--version",
      version,
      "--channel",
      input.channel,
      "--branch",
      input.branch,
      "--tag",
      `graphagent-v${version}`,
      "--previous-tag",
      input.previousTag,
      "--repo",
      input.repo,
      "--out",
      options.out,
    ],
    { cwd: options.dir, stdout: "pipe", stderr: "pipe" },
  )
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { stdout, stderr, exitCode }
}

describe("release notes CLI", () => {
  test("fails closed when the series file is missing or from another series", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "release-notes-"))
    try {
      const out = path.join(dir, "RELEASE_NOTES.md")

      const missing = await runNotesScript({ dir, out })
      expect(missing.exitCode).not.toBe(0)
      expect(missing.stderr).toContain("[release-notes]")
      expect(missing.stderr).toContain("v1.0.10.md")

      await mkdir(path.join(dir, ".github/releases"), { recursive: true })
      await writeFile(path.join(dir, ".github/releases/v1.0.10.md"), buildSource({}))
      const wrongSeries = await runNotesScript({ dir, out, version: "1.0.11" })
      expect(wrongSeries.exitCode).not.toBe(0)
      expect(wrongSeries.stderr).toContain("[release-notes]")
      expect(wrongSeries.stderr).toContain("v1.0.11.md")

      expect(await Bun.file(out).exists()).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("renders the series file to --out only after validation succeeds", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "release-notes-"))
    try {
      await mkdir(path.join(dir, ".github/releases"), { recursive: true })
      await writeFile(path.join(dir, ".github/releases/v1.0.10.md"), buildSource({}))
      const out = path.join(dir, "RELEASE_NOTES.md")

      const result = await runNotesScript({ dir, out })

      expect(result.exitCode).toBe(0)
      expect((await Bun.file(out).text()).trim()).toBe(validateAndRender(buildSource({}), input).trim())
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe("release notes template and workflow wiring", () => {
  test("template stays the grammar authority the fixtures are derived from", () => {
    expect(headings).toHaveLength(7)
    expect(new Set(headings).size).toBe(7)
    expect(template).toContain("**Full changelog:** [`{previous_tag}`...`{current_tag}`](https://github.com/")
    expect(template).toContain("/compare/{previous_tag}...{current_tag})")
  })

  test("candidate preparation renders notes before the isolated publish job", async () => {
    const workflow = await Bun.file(new URL("../../../.azure-pipelines/release.yml", import.meta.url)).text()
    const prepare = workflow.slice(workflow.indexOf("\n  - job: prepare_release"), workflow.indexOf("\n  - ${{ if parameters.createRelease }}:"))
    const publish = workflow.slice(workflow.indexOf("\n      - job: publish_release"))

    expect(workflow).not.toContain('--notes "GraphAgent release from branch')
    expect(prepare).toContain("script/release-notes.ts")
    expect(prepare).toContain('--notes-dir ".github/releases"')
    expect(prepare).toContain('--previous-tag "$RELEASE_PREVIOUS_TAG"')
    expect(prepare).toContain("dependencies.version.outputs['resolve.previous_tag']")
    expect(prepare).toContain('--out "$(Build.SourcesDirectory)/release-assets/RELEASE_NOTES.md"')
    expect(prepare).toContain("template: templates/toolchain.yml")
    expect(prepare).not.toContain("gh release create")
    expect(publish).toContain('gh release create "$RELEASE_TAG"')
    expect(publish).toContain('--notes-file "$dir/RELEASE_NOTES.md"')
    expect(publish).toContain("- prepare_release")
  })
})
