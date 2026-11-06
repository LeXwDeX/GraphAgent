import path from "node:path"

type Report = {
  scenarios: Record<string, Record<string, Record<string, number | string>>>
}

const [baselinePath, currentPath] = process.argv.slice(2)
if (!baselinePath || !currentPath) {
  console.error("usage: bun test/perf/compare.ts <baseline.json> <current.json>")
  process.exit(2)
}

// oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- generated benchmark report
const baseline = (await Bun.file(path.resolve(baselinePath)).json()) as Report
// oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- generated benchmark report
const current = (await Bun.file(path.resolve(currentPath)).json()) as Report
const rows: Array<Record<string, number | string>> = []

for (const [size, scenarios] of Object.entries(current.scenarios)) {
  for (const [id, metrics] of Object.entries(scenarios)) {
    const before = baseline.scenarios[size]?.[id]
    if (!before) continue
    for (const [metric, value] of Object.entries(metrics)) {
      const old = before[metric]
      if (typeof value !== "number" || typeof old !== "number") continue
      rows.push({ size, id, metric, baseline: old, current: value, ratio: old === 0 ? 0 : Number((value / old).toFixed(3)) })
    }
  }
}

console.log(JSON.stringify({ baseline: path.resolve(baselinePath), current: path.resolve(currentPath), rows }, null, 2))
