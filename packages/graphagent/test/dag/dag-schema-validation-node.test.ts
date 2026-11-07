import { expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  buildNodeSchemaWorker,
  NODE_SCHEMA_WORKER_DEFINES,
  NODE_SCHEMA_WORKER_NAME,
} from "../../script/schema-worker-build"

async function runNode(file: string, cwd: string) {
  const child = Bun.spawn(["node", file], { cwd, stdout: "pipe", stderr: "pipe" })
  const watchdog = setTimeout(() => child.kill(), 5_000)
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(stderr).toBe("")
    expect(code).toBe(0)
    return JSON.parse(stdout)
  } finally {
    clearTimeout(watchdog)
    child.kill()
  }
}

test("native Node runs source schema workers without a global Worker shim", async () => {
  const result = await runNode(
    fileURLToPath(new URL("./fixture/schema-validation-node.ts", import.meta.url)),
    os.tmpdir(),
  )
  expect(result).toMatchObject({ normal: true, deadline: true, cancelled: true })
})

test("Node bundle resolves the emitted worker beside its module from another cwd", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "schema-validation-node-"))
  await buildNodeSchemaWorker(directory)
  const bundled = await Bun.build({
    target: "node",
    entrypoints: [fileURLToPath(new URL("./fixture/schema-validation-node-capture.ts", import.meta.url))],
    outdir: directory,
    format: "esm",
    naming: "capture.mjs",
    define: NODE_SCHEMA_WORKER_DEFINES,
  })
  expect(bundled.success).toBe(true)
  expect(await Bun.file(path.join(directory, NODE_SCHEMA_WORKER_NAME)).exists()).toBe(true)
  expect(await runNode(path.join(directory, "capture.mjs"), os.tmpdir())).toMatchObject({
    normal: true,
    deadline: true,
    cancelled: true,
    aba: true,
    review: true,
  })
})
