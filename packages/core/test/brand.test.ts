import { describe, expect, test } from "bun:test"
import { APP_NAME, PROJECT_DIR } from "../src/brand"
import { artifactPrefix } from "../../script/src/brand"

describe("brand constants", () => {
  test("the build artifact prefix matches the application name", () => {
    expect(artifactPrefix).toBe(APP_NAME)
  })

  test("the project directory is the industry-standard agents directory", () => {
    expect(PROJECT_DIR).toBe(".agents")
  })
})
