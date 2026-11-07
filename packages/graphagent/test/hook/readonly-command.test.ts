import { describe, expect, test } from "bun:test"
import { parseReadonlyCommand, whitelistReject } from "@/hook/readonly-command"

describe("agent read-only command boundary", () => {
  for (const command of [
    "find . -delete",
    "find . -exec touch marker",
    "find . -fprint marker",
    "sort input -o marker",
    "sort --output=marker input",
    "sort --compress-program=sh input",
    "file -z archive.gz",
    "uniq input marker",
    "uniq -- input marker",
    "git diff --output=marker",
    "git diff --ext-diff",
    "git show --textconv",
    "git -c alias.status=evil status",
    "git log --format=x --output=marker",
    "sed -n '1w marker' input",
    "sed -n '1e touch marker' input",
    "awk 'BEGIN {system(\"touch marker\")}'",
    "echo safe\ntouch marker",
    "echo safe\rtouch marker",
    "echo safe; touch marker",
    "echo $(touch marker)",
    "echo `touch marker`",
    "cat input > marker",
    "/tmp/cat input",
    "./git status",
    "echo 'unterminated",
  ]) {
    test(`rejects ${JSON.stringify(command)}`, () => expect(whitelistReject(command)).not.toBeNull())
  }

  for (const command of [
    "ls -la",
    "cat 'file with spaces.txt'",
    "grep -n needle src/file.ts",
    "find . -name '*.ts' -type f",
    "git status --short",
    "git log -n 2 --oneline",
    "git diff --stat",
    "git show HEAD -- src/file.ts",
    "head -n 10 input",
    "tail -f input",
    "sort -nu input",
    "uniq -c input",
    "sed -n '1,10p' input",
  ]) {
    test(`accepts ${command}`, () => expect(whitelistReject(command)).toBeNull())
  }

  test("preserves quoted arguments without shell expansion", () => {
    expect(parseReadonlyCommand("cat 'a b' \"c d\" e\\ f")).toEqual({ name: "cat", args: ["a b", "c d", "e f"] })
  })
})
