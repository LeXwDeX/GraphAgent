import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

const src = path.resolve(import.meta.dir, "../src")
const source = fs.readFileSync(path.join(src, "attention/index.ts"), "utf8")
const imports = [...source.matchAll(/^import \w+ from "(.+\.mp3)" with \{ type: "file" \}$/gm)].map((match) => match[1])

describe("attention audio assets", () => {
  test("every imported audio file exists", () => {
    expect(imports).toHaveLength(6)
    for (const file of imports) expect(fs.existsSync(path.resolve(src, "attention", file))).toBe(true)
  })

  test("asset directory contains exactly the imported files", async () => {
    const dir = path.resolve(import.meta.dir, "../assets/audio")
    const files = (await Array.fromAsync(new Bun.Glob("*.mp3").scan({ cwd: dir }))).sort()
    const imported = [...new Set(imports.map((file) => path.basename(file)))].sort()
    expect(imported).toHaveLength(5)
    expect(files).toEqual(imported)
  })
})