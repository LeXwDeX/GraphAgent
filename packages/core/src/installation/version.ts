declare global {
  const GRAPHAGENT_VERSION: string
  const GRAPHAGENT_CHANNEL: string
}

export const InstallationVersion = typeof GRAPHAGENT_VERSION === "string" ? GRAPHAGENT_VERSION : "local"
export const InstallationChannel = typeof GRAPHAGENT_CHANNEL === "string" ? GRAPHAGENT_CHANNEL : "local"
export const InstallationLocal = InstallationChannel === "local"
