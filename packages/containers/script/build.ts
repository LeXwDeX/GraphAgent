#!/usr/bin/env bun

import { $ } from "bun"
import { fileURLToPath } from "url"
import { checkToolchain, readToolchain } from "../../../script/toolchain.mjs"

const rootDir = fileURLToPath(new URL("../../..", import.meta.url))
process.chdir(rootDir)

const reg = process.env.REGISTRY ?? "ghcr.io/lexwdex"
const tag = process.env.TAG ?? "24.04"
const push = process.argv.includes("--push") || process.env.PUSH === "1"

checkToolchain()
const { bun, node, rust } = readToolchain()

const images = ["base", "bun-node", "rust", "tauri-linux", "publish"]

const setup = async () => {
  if (!push) return
  const list = await $`docker buildx ls`.text()
  if (list.includes("graphagent")) {
    await $`docker buildx use graphagent`
    return
  }
  await $`docker buildx create --name graphagent --use`
}

await setup()

const platform = "linux/amd64,linux/arm64"

for (const name of images) {
  const image = `${reg}/build/${name}:${tag}`
  const file = `packages/containers/${name}/Dockerfile`
  if (name === "base") {
    if (push) {
      console.log(`docker buildx build --platform ${platform} -f ${file} -t ${image} --push .`)
      await $`docker buildx build --platform ${platform} -f ${file} -t ${image} --push .`
    }
    if (!push) {
      console.log(`docker build -f ${file} -t ${image} .`)
      await $`docker build -f ${file} -t ${image} .`
    }
  }
  if (name === "bun-node") {
    if (push) {
      console.log(
        `docker buildx build --platform ${platform} -f ${file} -t ${image} --build-arg REGISTRY=${reg} --build-arg BUN_VERSION=${bun} --build-arg NODE_VERSION=${node} --push .`,
      )
      await $`docker buildx build --platform ${platform} -f ${file} -t ${image} --build-arg REGISTRY=${reg} --build-arg BUN_VERSION=${bun} --build-arg NODE_VERSION=${node} --push .`
    }
    if (!push) {
      console.log(
        `docker build -f ${file} -t ${image} --build-arg REGISTRY=${reg} --build-arg BUN_VERSION=${bun} --build-arg NODE_VERSION=${node} .`,
      )
      await $`docker build -f ${file} -t ${image} --build-arg REGISTRY=${reg} --build-arg BUN_VERSION=${bun} --build-arg NODE_VERSION=${node} .`
    }
  }
  if (name !== "base" && name !== "bun-node") {
    const args = name === "rust" ? ["--build-arg", `RUST_TOOLCHAIN=${rust}`] : []
    if (push) {
      console.log(
        `docker buildx build --platform ${platform} -f ${file} -t ${image} --build-arg REGISTRY=${reg} ${args.join(" ")} --push .`,
      )
      await $`docker buildx build --platform ${platform} -f ${file} -t ${image} --build-arg REGISTRY=${reg} ${args} --push .`
    }
    if (!push) {
      console.log(`docker build -f ${file} -t ${image} --build-arg REGISTRY=${reg} ${args.join(" ")} .`)
      await $`docker build -f ${file} -t ${image} --build-arg REGISTRY=${reg} ${args} .`
    }
  }

  if (push) {
    console.log(`pushed ${image}`)
  }
}
