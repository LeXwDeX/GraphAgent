// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test"
import {
  formatResult,
  isPrivateHostname,
  isPrivateIPv4,
  parsePatterns,
  scanText,
} from "./check-private-hosts"

const ip = (...octets: number[]) => octets.join(".")
const host = (...labels: string[]) => labels.join(".")

test("flags every private IPv4 range", () => {
  for (const address of [ip(10, 0, 0, 1), ip(172, 16, 0, 1), ip(172, 31, 255, 255), ip(192, 168, 0, 1)])
    expect(isPrivateIPv4(address)).toBe(true)
})

test("does not flag public, documentation, loopback or invalid IPv4", () => {
  for (const address of [
    "172.15.0.1",
    "172.32.0.1",
    "192.169.0.1",
    "10.999.0.1",
    "192.0.2.1",
    "198.51.100.1",
    "203.0.113.1",
    "127.0.0.1",
    "8.8.8.8",
  ])
    expect(isPrivateIPv4(address)).toBe(false)
})

test("flags private host suffixes", () => {
  for (const name of [host("foo", "local"), host("a", "b", "internal"), host("host", "lan")])
    expect(isPrivateHostname(name)).toBe(true)
})

test("does not flag localhost or public host names", () => {
  for (const name of ["localhost", "example.com", host("foo", "local", "example", "com"), "config.local.ts"])
    expect(isPrivateHostname(name)).toBe(false)
})

test("rule 2 catches private IPv4 in text", () => {
  const text = [ip(10, 0, 0, 1), ip(172, 16, 0, 1), ip(192, 168, 0, 1)].join("\n")
  expect(scanText("fixture.txt", text, []).violations).toEqual([
    { file: "fixture.txt", line: 1, rule: 2 },
    { file: "fixture.txt", line: 2, rule: 2 },
    { file: "fixture.txt", line: 3, rule: 2 },
  ])
})

test("rule 2 allows documentation ranges, loopback and localhost", () => {
  const text = ["192.0.2.1", "198.51.100.1", "203.0.113.1", "127.0.0.1", "localhost"].join("\n")
  expect(scanText("fixture.txt", text, []).violations).toEqual([])
})

test("rule 2 catches private host suffixes in URLs and host keys", () => {
  for (const text of [
    `curl http://${host("foo", "local")}`,
    `curl https://user:secret@${host("mirror", "internal")}/pkg`,
    `host: "${host("foo", "local")}"`,
  ])
    expect(scanText("fixture.txt", text, []).violations).toEqual([{ file: "fixture.txt", line: 1, rule: 2 }])
})

test("rule 2 ignores identifier-shaped dotted names", () => {
  for (const text of [
    "projects.local",
    "ConfigV2.Reference.Local",
    "netInfo.internal",
    `id: "demo.local"`,
    "workspace.type.local",
  ])
    expect(scanText("fixture.txt", text, []).violations).toEqual([])
})

test("rule 2 ignores IPv4-shaped number sequences", () => {
  const text = "9.876.042 10.142.22.65.442"
  expect(scanText("fixture.txt", text, []).violations).toEqual([])
})

test("rule 1 catches non-allowlisted lock hosts", () => {
  const text = `"pkg": "https://mirror.example.com/pkg.tgz"`
  expect(scanText("bun.lock", text, []).violations).toEqual([{ file: "bun.lock", line: 1, rule: 1 }])
})

test("rule 1 allows the public registry only", () => {
  const text = `"a": "https://registry.npmjs.org/a.tgz"`
  expect(scanText("bun.lock", text, []).violations).toEqual([])
  const other = `"c": "https://pkg.pr.new/@solidjs/start@dfb2020"`
  expect(scanText("bun.lock", other, []).violations).toEqual([{ file: "bun.lock", line: 1, rule: 1 }])
})

test("rule 3 reads extra patterns and skips when empty", () => {
  const parsed = parsePatterns("mirror\\.example\\.com,internal-mirror")
  expect(parsed.skipped).toBe(false)
  expect(parsed.patterns).toHaveLength(2)
  expect(scanText("fixture.txt", "internal-mirror", parsed.patterns).violations).toEqual([
    { file: "fixture.txt", line: 1, rule: 3 },
  ])
  expect(parsePatterns(undefined).skipped).toBe(true)
  expect(parsePatterns("$(PRIVATE_HOST_PATTERNS)").skipped).toBe(true)
  expect(() => parsePatterns("[")).toThrow("entry 1")
})

test("inline allow entries are counted and skipped", () => {
  const marker = ["check-private-hosts:", "allow", "test fixture"].join(" ")
  const text = `${ip(10, 0, 0, 1)} // ${marker}`
  expect(scanText("fixture.txt", text, [])).toEqual({ violations: [], allowed: 1 })
})

test("output contains only file, line and rule", () => {
  const result = scanText("bun.lock", `"pkg": "https://mirror.example.com/pkg.tgz"`, [])
  const output = formatResult({ ...result, rule3Skipped: true })
  expect(output).toContain("bun.lock:1 rule 1")
  expect(output).toContain("1 violation(s), 0 allowed line(s)")
  expect(output).toContain("rule 3 skipped")
  expect(output).not.toContain("mirror.example.com")
})