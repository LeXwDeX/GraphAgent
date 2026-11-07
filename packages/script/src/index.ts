import { $ } from "bun"
import { checkToolchain } from "../../../script/toolchain.mjs"
import { artifactPrefix } from "./brand"

export { artifactPrefix }

checkToolchain()

const env = {
  GRAPHAGENT_CHANNEL: process.env["GRAPHAGENT_CHANNEL"],
  GRAPHAGENT_VERSION: process.env["GRAPHAGENT_VERSION"],
  GRAPHAGENT_RELEASE: process.env["GRAPHAGENT_RELEASE"],
}
const CHANNEL = await (async () => {
  if (env.GRAPHAGENT_CHANNEL) return env.GRAPHAGENT_CHANNEL
  if (env.GRAPHAGENT_VERSION && !env.GRAPHAGENT_VERSION.startsWith("0.0.0-")) return "latest"
  return await $`git branch --show-current`.text().then((x) => x.trim())
})()
const IS_PREVIEW = CHANNEL !== "latest"

const VERSION = await (async () => {
  if (env.GRAPHAGENT_VERSION) return env.GRAPHAGENT_VERSION
  if (IS_PREVIEW) return `0.0.0-${CHANNEL}-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}`
  throw new Error("GRAPHAGENT_VERSION is required for a stable build")
})()

export const Script = {
  get artifactPrefix() {
    return artifactPrefix
  },
  get channel() {
    return CHANNEL
  },
  get version() {
    return VERSION
  },
  get preview() {
    return IS_PREVIEW
  },
  get release(): boolean {
    return !!env.GRAPHAGENT_RELEASE
  },
}
console.log(`opencode script`, JSON.stringify(Script, null, 2))
