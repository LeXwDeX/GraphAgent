export const hookCommand = (program: string) => {
  const quote = (value: string) =>
    process.platform === "win32" ? '"' + value.replaceAll('"', '\\"') + '"' : "'" + value.replaceAll("'", "'\\''") + "'"
  return `${quote(process.execPath)} -e ${quote(program.replaceAll("\n", " "))}`
}

// A strict Claude-style consumer: wrong casing/Read path silently produces no context.
export const claudeHookCommand = hookCommand(`
  const input = JSON.parse(await Bun.stdin.text());
  if (["Bash", "Read", "Write", "Edit", "Grep", "Glob"].includes(input.tool_name)
      && (input.tool_name !== "Read" || input.tool_input.file_path)) {
    console.log(JSON.stringify({hookSpecificOutput: {
      hookEventName: input.hook_event_name,
      additionalContext: "CLAUDE_CONTEXT:" + JSON.stringify(input)
    }}));
  }
`)

export const nativeHookCommand = hookCommand(`
  const input = JSON.parse(await Bun.stdin.text());
  console.log(JSON.stringify({hookSpecificOutput: {
    hookEventName: input.hook_event_name,
    additionalContext: "NATIVE_CONTEXT:" + JSON.stringify(input)
  }}));
`)

// A silent hook: it records that it ran and never writes to stdout, so it
// cannot change the turn through additionalContext or a block decision. Paths
// are relative to CLAUDE_PROJECT_DIR, which the hook shell always exports.
export const auditHookCommand = (file = ".agents/hook-audit.jsonl") => hookCommand(`
  const fs = require("node:fs");
  const path = require("node:path");
  const input = JSON.parse(await Bun.stdin.text());
  fs.appendFileSync(path.join(process.env.CLAUDE_PROJECT_DIR, ${JSON.stringify(file)}),
    JSON.stringify({ event: input.hook_event_name, tool: input.tool_name ?? null }) + "\\n");
`)
