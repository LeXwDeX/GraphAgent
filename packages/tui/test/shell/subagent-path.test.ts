// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test"
import {
  DESCRIPTION_SEPARATOR,
  MAX_CHAIN_DEPTH,
  PATH_SEPARATOR,
  SUBAGENT_MARKER_GLYPH,
  layoutSubagentPath,
  sameSubagentView,
  subagentDescription,
  subagentKind,
  subagentMarker,
  subagentMarkerToken,
  subagentView,
  type SubagentLookup,
  type SubagentPathInput,
  type SubagentPathLayout,
  type SubagentPathPart,
  type SubagentView,
} from "../../src/shell/subagent-path"
import { cellWidth, type AmbiguousWidth } from "../../src/ui/width"

/** The path as the top bar draws it, minus the separator in front of the first part. */
function textOf(layout: SubagentPathLayout | undefined) {
  const text = (part: SubagentPathPart) =>
    part.type === "current"
      ? part.glyph + part.kind + (part.description ? DESCRIPTION_SEPARATOR + part.description : "")
      : part.text
  return layout?.parts.map(text).join(PATH_SEPARATOR)
}

const root = { id: "ses_root", title: "Upgrade toolchain and all dependencies" }
const middle = { id: "ses_middle", title: "Check breaking changes" }
const description = "scan for breaking changes in the API surface"

function input(extra: Partial<SubagentPathInput> = {}): SubagentPathInput {
  return {
    ancestors: [root],
    kind: "explore",
    description,
    budget: 200,
    ambiguousWidth: 1,
    ...extra,
  }
}

test("depth 1 is the root title, then the kind and the description", () => {
  const layout = layoutSubagentPath(
    input({ ancestors: [{ id: "ses_root", title: "升级工具链与全部依赖" }], description: "扫描破坏性变更" }),
  )
  expect(textOf(layout)).toBe("升级工具链与全部依赖 › explore · 扫描破坏性变更")
  expect(layout?.parts.map((part) => part.type)).toEqual(["ancestor", "current"])
  expect(layout?.width).toBe(cellWidth("升级工具链与全部依赖 › explore · 扫描破坏性变更"))
})

test("depth 2 is three segments, and the ancestors carry the session to open", () => {
  const layout = layoutSubagentPath(input({ ancestors: [root, middle] }))
  expect(textOf(layout)).toBe(`${root.title} › ${middle.title} › explore · ${description}`)
  expect(layout?.parts.map((part) => part.type)).toEqual(["ancestor", "ancestor", "current"])
  expect(layout?.parts.flatMap((part) => (part.type === "ancestor" ? [part.id] : []))).toEqual([
    "ses_root",
    "ses_middle",
  ])
})

test("the marker glyph leads the kind, and a missing marker adds nothing", () => {
  for (const marker of ["running", "failed", "done"] as const) {
    expect(textOf(layoutSubagentPath(input({ marker })))).toBe(
      `${root.title} › ${SUBAGENT_MARKER_GLYPH[marker]} explore · ${description}`,
    )
  }
  expect(textOf(layoutSubagentPath(input()))).toBe(`${root.title} › explore · ${description}`)
})

test("a segment without a description is the kind alone, and one without ancestors is the current segment alone", () => {
  expect(textOf(layoutSubagentPath(input({ description: "" })))).toBe(`${root.title} › explore`)
  expect(textOf(layoutSubagentPath(input({ ancestors: [] })))).toBe(`explore · ${description}`)
})

test("a narrow terminal gives way in order: description, middle segments, root title, description again", () => {
  const deep = input({ ancestors: [root, middle], marker: "running" })
  const at = (budget: number, ambiguousWidth: AmbiguousWidth = 1) =>
    layoutSubagentPath({ ...deep, budget, ambiguousWidth })

  // Whole: 38 + 22 + 56 cells and two separators.
  expect(textOf(at(122))).toBe(`${root.title} › ${middle.title} › ● explore · ${description}`)

  // 1. The description is cut; the middle segment and the root stay whole.
  const cut = textOf(at(110))!
  expect(cut.startsWith(`${root.title} › ${middle.title} › ● explore · scan for breaking`)).toBe(true)
  expect(cut.endsWith("…")).toBe(true)
  expect(cellWidth(cut)).toBe(110)

  // 2. Cutting the description to its floor would not be enough: the middle segment folds, the description recovers.
  const folded = at(80)
  expect(textOf(folded)).toBe(`${root.title} › … › ● explore · scan for breaking chan…`)
  expect(folded?.parts.map((part) => part.type)).toEqual(["ancestor", "fold", "current"])

  // 3. The root title is cut; the description sits at its floor of 8 cells.
  const rootCut = textOf(at(60))!
  expect(rootCut.endsWith(" › … › ● explore · scan fo…")).toBe(true)
  expect(rootCut.startsWith("Upgrade toolchain")).toBe(true)
  expect(rootCut.includes(root.title)).toBe(false)
  expect(cellWidth(rootCut)).toBe(60)

  // 4. The description goes before the root is cut below its floor.
  expect(textOf(at(30))).toBe("Upgrade toolc… › … › ● explore")
})

test("the root and the current segment survive until the very last resort", () => {
  const deep = input({ ancestors: [root, middle], marker: "running" })
  const at = (budget: number) => layoutSubagentPath({ ...deep, budget })
  expect(textOf(at(20))).toBe("Upg… › … › ● explore")
  // Too narrow for the root: only the current segment remains, cut to fit.
  expect(textOf(at(10))).toBe("● explore")
  expect(textOf(at(7))).toBe("● expl…")
  expect(at(2)).toBeUndefined()
  expect(at(0)).toBeUndefined()
})

test("the description keeps at least its floor before anything else gives way, unless it is shorter", () => {
  // A one-word description is not cut below itself: the root takes the cut instead.
  const layout = layoutSubagentPath(input({ description: "scan", budget: 30 }))
  expect(textOf(layout)).toBe("Upgrade tool… › explore · scan")
})

for (const ambiguousWidth of [1, 2] as const) {
  test(`the path never exceeds its budget at ambiguous_width ${ambiguousWidth}`, () => {
    const views: SubagentPathInput[] = [
      input({ ancestors: [root, middle], marker: "running" }),
      input({ ancestors: [root, middle, { id: "ses_third", title: "Third level" }], marker: "failed" }),
      input({
        ancestors: [{ id: "ses_root", title: "升级工具链与全部依赖" }],
        description: "扫描破坏性变更并给出结论",
      }),
      input({ ancestors: [], marker: "done" }),
      input({ ancestors: [root], description: "" }),
    ]
    for (const view of views) {
      for (let budget = 0; budget <= 140; budget++) {
        const layout = layoutSubagentPath({ ...view, budget, ambiguousWidth })
        if (!layout) continue
        const label = `budget ${budget}`
        expect({ label, fits: cellWidth(textOf(layout)!, ambiguousWidth) <= budget }).toEqual({ label, fits: true })
        expect({ label, width: layout.width }).toEqual({ label, width: cellWidth(textOf(layout)!, ambiguousWidth) })
        // Whatever else is cut, the last part is the current segment and a longer path starts at the root.
        expect(layout.parts.at(-1)?.type).toBe("current")
        if (layout.parts.length > 1)
          expect(layout.parts[0]).toMatchObject({ type: "ancestor", id: view.ancestors[0]?.id })
      }
    }
  })
}

test("a layout is made for every width that holds the current segment, so the path never vanishes early", () => {
  const view = input({ ancestors: [root, middle], marker: "running" })
  // `● explore` is 9 cells; from there on something is always drawn.
  for (let budget = 9; budget <= 140; budget++) {
    expect({ budget, layout: layoutSubagentPath({ ...view, budget }) !== undefined }).toEqual({ budget, layout: true })
  }
})

test("kind comes from the session, then the parent's Task input, then the title, then plain agent", () => {
  const titled = { title: "scan (@general subagent)" }
  expect(subagentKind({ ...titled, agent: "explore" }, { kind: "plan" })).toBe("explore")
  expect(subagentKind(titled, { kind: "plan" })).toBe("plan")
  expect(subagentKind(titled)).toBe("general")
  expect(subagentKind({ title: "scan (@code-explorer subagent)" })).toBe("code-explorer")
  expect(subagentKind({ title: "scan (DAG node)" })).toBe("agent")
  expect(subagentKind({ title: "" })).toBe("agent")
  // Blank values do not count as an answer.
  expect(subagentKind({ ...titled, agent: "  " }, { kind: "" })).toBe("general")
  // A remote string cannot restyle the terminal.
  expect(subagentKind({ title: "scan", agent: "ex\u001b[31mplore\u0007" })).toBe("explore")
})

test("description comes from the Task input, else from the title without its subagent tail", () => {
  expect(subagentDescription({ title: "title text (@explore subagent)" }, { description: "from the task" })).toBe(
    "from the task",
  )
  expect(subagentDescription({ title: "scan the repo (@explore subagent)" })).toBe("scan the repo")
  expect(subagentDescription({ title: "scan the repo (@code-explorer subagent)" }, { description: " " })).toBe(
    "scan the repo",
  )
  expect(subagentDescription({ title: "build step (DAG node)" })).toBe("build step (DAG node)")
  expect(subagentDescription({ title: "(@explore subagent)" })).toBe("")
  expect(subagentDescription({ title: "x" }, { description: "two\nlines" })).toBe("two lines")
})

test("the marker follows the summary: running while busy or retrying, failed with an error, done when idle", () => {
  expect(subagentMarker({ status: "busy" })).toBe("running")
  expect(subagentMarker({ status: "retry" })).toBe("running")
  // An error left from an earlier turn does not hide that the session runs again.
  expect(subagentMarker({ status: "busy", error: "boom" })).toBe("running")
  expect(subagentMarker({ status: "idle", error: "boom" })).toBe("failed")
  expect(subagentMarker({ status: "idle" })).toBe("done")
  expect(subagentMarker({ status: "unknown" })).toBeUndefined()
  expect(subagentMarker(undefined)).toBeUndefined()
  expect(subagentMarkerToken("running")).toBe("primary")
  expect(subagentMarkerToken("failed")).toBe("error")
  expect(subagentMarkerToken("done")).toBe("success")
})

function lookupOf(
  sessions: Record<string, { parentID?: string; title?: string; agent?: string }>,
  extra: Partial<Pick<SubagentLookup, "task" | "summary">> = {},
): SubagentLookup {
  return {
    session: (id) => {
      const found = sessions[id]
      return found ? { id, parentID: found.parentID, title: found.title ?? id, agent: found.agent } : undefined
    },
    task: extra.task ?? (() => undefined),
    summary: extra.summary ?? (() => undefined),
  }
}

test("the view of a session walks its parents up to the root", () => {
  const lookup = lookupOf(
    {
      root: { title: "Root title" },
      middle: { parentID: "root", title: "Middle title" },
      leaf: { parentID: "middle", title: "scan (@explore subagent)" },
    },
    {
      task: (id) => (id === "leaf" ? { kind: "explore", description: "scan the repo" } : undefined),
      summary: (id) => (id === "leaf" ? { status: "busy" } : undefined),
    },
  )
  expect(subagentView(lookup, "leaf")).toEqual({
    ancestors: [
      { id: "root", title: "Root title" },
      { id: "middle", title: "Middle title" },
    ],
    kind: "explore",
    description: "scan the repo",
    marker: "running",
  })
  expect(subagentView(lookup, "middle")?.ancestors).toEqual([{ id: "root", title: "Root title" }])
})

test("a session without a parent, or one that is not loaded, has no sub-agent view", () => {
  const lookup = lookupOf({ root: {}, child: { parentID: "root" } })
  expect(subagentView(lookup, "root")).toBeUndefined()
  expect(subagentView(lookup, "missing")).toBeUndefined()
})

test("a parent that is not loaded leaves the path with the segments that are", () => {
  const lookup = lookupOf({ child: { parentID: "gone", title: "scan (@explore subagent)" } })
  expect(subagentView(lookup, "child")).toMatchObject({ ancestors: [], kind: "explore", description: "scan" })
  const partial = lookupOf({ middle: { parentID: "gone", title: "Middle" }, leaf: { parentID: "middle" } })
  expect(subagentView(partial, "leaf")?.ancestors).toEqual([{ id: "middle", title: "Middle" }])
})

test("a loop of parents ends, and so does a chain longer than the limit", () => {
  const loop = lookupOf({ a: { parentID: "b", title: "A" }, b: { parentID: "a", title: "B" } })
  expect(subagentView(loop, "a")?.ancestors).toEqual([{ id: "b", title: "B" }])

  const sessions: Record<string, { parentID?: string; title?: string }> = {}
  for (let index = 0; index < MAX_CHAIN_DEPTH * 3; index++) {
    sessions[`s${index}`] = { parentID: index + 1 < MAX_CHAIN_DEPTH * 3 ? `s${index + 1}` : undefined }
  }
  const chain = subagentView(lookupOf(sessions), "s0")
  expect(chain?.ancestors).toHaveLength(MAX_CHAIN_DEPTH)
  // The nearest parent stays last; the cut falls on the far end.
  expect(chain?.ancestors.at(-1)?.id).toBe("s1")
})

test("an ancestor without a usable title shows its id, and its title loses control characters", () => {
  const lookup = lookupOf({
    root: { title: "  " },
    mid: { parentID: "root", title: "Mid\u001b[31m\ntitle" },
    leaf: { parentID: "mid" },
  })
  expect(subagentView(lookup, "leaf")?.ancestors).toEqual([
    { id: "root", title: "root" },
    { id: "mid", title: "Mid title" },
  ])
})

test("two views are the same when they draw the same path", () => {
  const base: SubagentView = { ancestors: [root], kind: "explore", description: "scan", marker: "running" }
  expect(sameSubagentView(base, { ...base, ancestors: [{ ...root }] })).toBe(true)
  expect(sameSubagentView(base, undefined)).toBe(false)
  expect(sameSubagentView(undefined, undefined)).toBe(true)
  expect(sameSubagentView(base, { ...base, marker: "done" })).toBe(false)
  expect(sameSubagentView(base, { ...base, kind: "plan" })).toBe(false)
  expect(sameSubagentView(base, { ...base, description: "scan more" })).toBe(false)
  expect(sameSubagentView(base, { ...base, ancestors: [{ ...root, title: "Renamed" }] })).toBe(false)
  expect(sameSubagentView(base, { ...base, ancestors: [root, middle] })).toBe(false)
})
