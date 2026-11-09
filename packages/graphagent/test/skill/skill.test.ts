import { describe, expect } from "bun:test"
import { Effect, Layer, Logger } from "effect"
import { Skill } from "../../src/skill"
import { Config } from "../../src/config/config"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Discovery } from "../../src/skill/discovery"
import { CrossSpawnSpawner } from "@graphagent/core/cross-spawn-spawner"
import { FSUtil } from "@graphagent/core/fs-util"
import { Global } from "@graphagent/core/global"
import { provideInstance, provideTmpdirInstance, testInstanceStoreLayer, tmpdir } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import path from "path"
import fs from "fs/promises"

const node = CrossSpawnSpawner.defaultLayer

const it = testEffect(Layer.mergeAll(Skill.defaultLayer, node, testInstanceStoreLayer))

let pulledUrls: string[] = []
let pulledSkillDirs: (url: string) => string[] = () => []

// Inject Discovery so the URL source is asserted without a network call or a
// shared download cache.
const urlSkillLayer = Skill.layer.pipe(
  Layer.provide(
    Layer.succeed(Discovery.Service, {
      pull: (url: string) =>
        Effect.sync(() => {
          pulledUrls.push(url)
          return pulledSkillDirs(url)
        }),
    }),
  ),
  Layer.provide(Config.defaultLayer),
  Layer.provide(EventV2Bridge.defaultLayer),
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(Global.layer),
)
const urlIt = testEffect(Layer.mergeAll(urlSkillLayer, node, testInstanceStoreLayer))

async function createClaudeGlobalSkill(homeDir: string) {
  const skillDir = path.join(homeDir, ".claude", "skills", "global-test-skill")
  await fs.mkdir(skillDir, { recursive: true })
  await Bun.write(
    path.join(skillDir, "SKILL.md"),
    `---
name: global-test-skill
description: A global skill from ~/.claude/skills for testing.
---

# Global Test Skill
`,
  )
}

const withHome = <A, E, R>(home: string, self: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const prev = process.env.GRAPHAGENT_TEST_HOME
      process.env.GRAPHAGENT_TEST_HOME = home
      return prev
    }),
    () => self,
    (prev) =>
      Effect.sync(() => {
        process.env.GRAPHAGENT_TEST_HOME = prev
      }),
  )

const withConfigDir = <A, E, R>(dir: string, self: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const prev = process.env.GRAPHAGENT_TEST_CONFIG_DIR
      process.env.GRAPHAGENT_TEST_CONFIG_DIR = dir
      return prev
    }),
    () => self,
    (prev) =>
      Effect.sync(() => {
        if (prev === undefined) delete process.env.GRAPHAGENT_TEST_CONFIG_DIR
        else process.env.GRAPHAGENT_TEST_CONFIG_DIR = prev
      }),
  )

const writeSkill = (file: string, name: string, extra: Record<string, unknown> = {}) =>
  Effect.promise(async () => {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await Bun.write(
      file,
      `---\n${JSON.stringify({ name, description: `${name} fixture`, ...extra })}\n---\n\n# ${name}\n`,
    )
  })

describe("skill", () => {
  it.live("does not register workflow as a built-in skill", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const skill = yield* Skill.Service
          expect(yield* skill.get("workflow")).toBeUndefined()
          expect(
            (yield* skill.all()).filter((item) => item.location.startsWith("/builtin/")).map((item) => item.name),
          ).toEqual(["customize-opencode", "configure-hooks", "git-workflow"])
          expect(yield* skill.get("orchestration-router")).toBeUndefined()
        }),
      { git: true },
    ),
  )

  it.live("still discovers a user-defined workflow skill", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Bun.write(
              path.join(dir, ".agents", "skills", "workflow", "SKILL.md"),
              `---
name: workflow
description: User-defined workflow guidance.
---

# User Workflow
`,
            ),
          )

          const skill = yield* Skill.Service
          expect(yield* skill.get("workflow")).toMatchObject({
            name: "workflow",
            description: "User-defined workflow guidance.",
          })
          expect((yield* skill.get("workflow"))?.location).not.toStartWith("/builtin/")
        }),
      { git: true },
    ),
  )

  it.live("discovers skills from .agents/skills/ directory", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Bun.write(
              path.join(dir, ".agents", "skills", "test-skill", "SKILL.md"),
              `---
name: test-skill
description: A test skill for verification.
---

# Test Skill

Instructions here.
`,
            ),
          )

          const skill = yield* Skill.Service
          const list = (yield* skill.all()).filter((s) => !s.location.startsWith("/builtin/"))
          expect(list.length).toBe(1)
          const item = list.find((x) => x.name === "test-skill")
          expect(item).toBeDefined()
          expect(item!.description).toBe("A test skill for verification.")
          expect(item!.location).toContain(path.join("skills", "test-skill", "SKILL.md"))
        }),
      { git: true },
    ),
  )

  it.live("returns skill directories from Skill.dirs", () =>
    provideTmpdirInstance(
      (dir) =>
        // Keep the isolated user home distinct from the project root: a root
        // that equals $HOME carries no project layer, which this fixture does
        // not model.
        withHome(
          path.join(dir, ".home"),
          Effect.gen(function* () {
            yield* Effect.promise(() =>
              Bun.write(
                path.join(dir, ".agents", "skills", "dir-skill", "SKILL.md"),
                `---
name: dir-skill
description: Skill for dirs test.
---

# Dir Skill
`,
              ),
            )

            const skill = yield* Skill.Service
            const dirs = yield* skill.dirs()
            expect(dirs).toContain(path.join(dir, ".agents", "skills", "dir-skill"))
            expect(dirs.length).toBe(1)
          }),
        ),
      { git: true },
    ),
  )

  it.live("discovers multiple skills from .agents/skills/ directory", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Promise.all([
              Bun.write(
                path.join(dir, ".agents", "skills", "skill-one", "SKILL.md"),
                `---
name: skill-one
description: First test skill.
---

# Skill One
`,
              ),
              Bun.write(
                path.join(dir, ".agents", "skills", "skill-two", "SKILL.md"),
                `---
name: skill-two
description: Second test skill.
---

# Skill Two
`,
              ),
            ]),
          )

          const skill = yield* Skill.Service
          const list = (yield* skill.all()).filter((s) => !s.location.startsWith("/builtin/"))
          expect(list.length).toBe(2)
          expect(list.find((x) => x.name === "skill-one")).toBeDefined()
          expect(list.find((x) => x.name === "skill-two")).toBeDefined()
        }),
      { git: true },
    ),
  )

  it.live("skips skills with missing frontmatter", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Bun.write(
              path.join(dir, ".agents", "skills", "no-frontmatter", "SKILL.md"),
              `# No Frontmatter

Just some content without YAML frontmatter.
`,
            ),
          )

          const skill = yield* Skill.Service
          expect((yield* skill.all()).filter((s) => !s.location.startsWith("/builtin/"))).toEqual([])
        }),
      { git: true },
    ),
  )

  it.live("discovers skills without descriptions", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Bun.write(
              path.join(dir, ".agents", "skills", "manual-skill", "SKILL.md"),
              `---
name: manual-skill
---

# Manual Skill

Instructions here.
`,
            ),
          )

          const skill = yield* Skill.Service
          const list = (yield* skill.all()).filter((s) => !s.location.startsWith("/builtin/"))
          expect(list.length).toBe(1)
          const item = list.find((x) => x.name === "manual-skill")
          expect(item).toBeDefined()
          expect(item!.description).toBeUndefined()
          expect(Skill.fmt(list, { verbose: false })).toBe("No skills are currently available.")
          expect(Skill.fmt(list, { verbose: true })).toBe("No skills are currently available.")
        }),
      { git: true },
    ),
  )

  it.live("does not discover skills from .claude/skills/ directory", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Bun.write(
              path.join(dir, ".claude", "skills", "claude-skill", "SKILL.md"),
              `---
name: claude-skill
description: A skill in the .claude/skills directory.
---

# Claude Skill
`,
            ),
          )

          const skill = yield* Skill.Service
          const list = (yield* skill.all()).filter((s) => !s.location.startsWith("/builtin/"))
          expect(list).toEqual([])
        }),
      { git: true },
    ),
  )

  it.live("does not discover global skills from ~/.claude/skills/ directory", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir({ git: true })),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )

      yield* withHome(
        tmp.path,
        Effect.gen(function* () {
          yield* Effect.promise(() => createClaudeGlobalSkill(tmp.path))
          yield* Effect.gen(function* () {
            const skill = yield* Skill.Service
            const list = (yield* skill.all()).filter((s) => !s.location.startsWith("/builtin/"))
            expect(list).toEqual([])
          }).pipe(provideInstance(tmp.path))
        }),
      )
    }),
  )

  it.live("marks workspace skills project-owned and user-root skills user-owned", () =>
    Effect.gen(function* () {
      const home = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir({ git: true })),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      const workspace = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir({ git: true })),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      const hooks = { Stop: [{ hooks: [{ type: "command", command: "printf hooked" }] }] }
      const write = (file: string, name: string) =>
        Effect.promise(() =>
          Bun.write(
            file,
            `---\n${JSON.stringify({ name, description: `${name} fixture`, hooks })}\n---\n\n# ${name}\n`,
          ),
        )
      const workspaceSkill = path.join(workspace.path, ".agents", "skills", "workspace-hooked", "SKILL.md")
      const userSkill = path.join(home.path, ".agents", "skills", "user-hooked", "SKILL.md")
      yield* write(workspaceSkill, "workspace-hooked")
      yield* write(userSkill, "user-hooked")

      yield* withHome(
        home.path,
        Effect.gen(function* () {
          const skill = yield* Skill.Service
          const workspaceItem = yield* skill.require("workspace-hooked")
          const userItem = yield* skill.require("user-hooked")
          // Provenance is what decides whether frontmatter hooks may run before
          // the folder is trusted: a repository's own skill is project-owned.
          expect(workspaceItem.hookSource).toBe("project")
          expect(workspaceItem.hookOrigin).toBe(`skill:${workspaceSkill}`)
          expect(workspaceItem.hooks).toEqual(hooks)
          expect(userItem.hookSource).toBe("user")
          expect(userItem.hookOrigin).toBe(`skill:${userSkill}`)
        }).pipe(provideInstance(workspace.path)),
      )
    }),
  )

  it.live("returns empty array when no skills exist", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const skill = yield* Skill.Service
          expect((yield* skill.all()).filter((s) => !s.location.startsWith("/builtin/"))).toEqual([])
        }),
      { git: true },
    ),
  )

  it.live("fails with typed error when requiring a missing skill", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const skill = yield* Skill.Service
          const error = yield* Effect.flip(skill.require("missing-skill"))
          expect(error).toBeInstanceOf(Skill.NotFoundError)
          expect(error._tag).toBe("Skill.NotFoundError")
          expect(error.name).toBe("missing-skill")
          expect(error.message).toContain('Skill "missing-skill" not found.')
        }),
      { git: true },
    ),
  )

  it.effect("exposes tagged expected skill failure classes", () =>
    Effect.sync(() => {
      const invalid = new Skill.InvalidError({ path: "/tmp/SKILL.md", message: "Invalid skill frontmatter" })
      const mismatch = new Skill.NameMismatchError({
        path: "/tmp/SKILL.md",
        expected: "expected-skill",
        actual: "actual-skill",
      })

      expect(invalid).toBeInstanceOf(Skill.InvalidError)
      expect(invalid._tag).toBe("SkillInvalidError")
      expect(mismatch).toBeInstanceOf(Skill.NameMismatchError)
      expect(mismatch._tag).toBe("SkillNameMismatchError")
    }),
  )

  it.live("discovers skills from .agents/skills/ directory", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Bun.write(
              path.join(dir, ".agents", "skills", "agent-skill", "SKILL.md"),
              `---
name: agent-skill
description: A skill in the .agents/skills directory.
---

# Agent Skill
`,
            ),
          )

          const skill = yield* Skill.Service
          const list = (yield* skill.all()).filter((s) => !s.location.startsWith("/builtin/"))
          expect(list.length).toBe(1)
          const item = list.find((x) => x.name === "agent-skill")
          expect(item).toBeDefined()
          expect(item!.location).toContain(path.join(".agents", "skills", "agent-skill", "SKILL.md"))
        }),
      { git: true },
    ),
  )

  it.live("discovers global skills from ~/.agents/skills/ directory", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir({ git: true })),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )

      yield* withHome(
        tmp.path,
        Effect.gen(function* () {
          const skillDir = path.join(tmp.path, ".agents", "skills", "global-agent-skill")
          yield* Effect.promise(() => fs.mkdir(skillDir, { recursive: true }))
          yield* Effect.promise(() =>
            Bun.write(
              path.join(skillDir, "SKILL.md"),
              `---
name: global-agent-skill
description: A global skill from ~/.agents/skills for testing.
---

# Global Agent Skill

This skill is loaded from the global home directory.
`,
            ),
          )

          yield* Effect.gen(function* () {
            const skill = yield* Skill.Service
            const list = (yield* skill.all()).filter((s) => !s.location.startsWith("/builtin/"))
            expect(list.length).toBe(1)
            expect(list[0].name).toBe("global-agent-skill")
            expect(list[0].description).toBe("A global skill from ~/.agents/skills for testing.")
            expect(list[0].location).toContain(path.join(".agents", "skills", "global-agent-skill", "SKILL.md"))
          }).pipe(provideInstance(tmp.path))
        }),
      )
    }),
  )

  it.live("discovers only .agents/skills/ when both .claude/skills/ and .agents/skills/ exist", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Promise.all([
              Bun.write(
                path.join(dir, ".claude", "skills", "claude-skill", "SKILL.md"),
                `---
name: claude-skill
description: A skill in the .claude/skills directory.
---

# Claude Skill
`,
              ),
              Bun.write(
                path.join(dir, ".agents", "skills", "agent-skill", "SKILL.md"),
                `---
name: agent-skill
description: A skill in the .agents/skills directory.
---

# Agent Skill
`,
              ),
            ]),
          )

          const skill = yield* Skill.Service
          const list = (yield* skill.all()).filter((s) => !s.location.startsWith("/builtin/"))
          expect(list.map((s) => s.name)).toEqual(["agent-skill"])
        }),
      { git: true },
    ),
  )

  it.live("properly resolves directories that skills live in", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Promise.all([
              Bun.write(
                path.join(dir, ".agents", "skills", "agent-skill", "SKILL.md"),
                `---
name: agent-skill
description: A skill in the .agents/skills directory.
---

# Agent Skill
`,
              ),
              Bun.write(
                path.join(dir, ".agents", "skills", "second-skill", "SKILL.md"),
                `---
name: second-skill
description: A second skill in the .agents/skills directory.
---

# Second Skill
`,
              ),
            ]),
          )

          const skill = yield* Skill.Service
          expect((yield* skill.dirs()).length).toBe(2)
        }),
      { git: true },
    ),
  )

  it.live("keeps a hidden skill loadable by name", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* writeSkill(path.join(dir, ".agents", "skills", "reference-only", "SKILL.md"), "reference-only", {
            hidden: true,
          })

          const skill = yield* Skill.Service
          expect(yield* skill.get("reference-only")).toMatchObject({ name: "reference-only", hidden: true })
        }),
      { git: true },
    ),
  )

  it.live("does not load the singular skill directory", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* writeSkill(path.join(dir, ".agents", "skill", "singular-skill", "SKILL.md"), "singular-skill")

          const skill = yield* Skill.Service
          expect(yield* skill.get("singular-skill")).toBeUndefined()
        }),
      { git: true },
    ),
  )

  it.live("skips .claude segments in skills.paths while loading ordinary configured paths", () =>
    Effect.gen(function* () {
      const home = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir({ git: true })),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      const extra = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )

      yield* withHome(
        home.path,
        provideTmpdirInstance(
          (dir) =>
            Effect.gen(function* () {
              yield* writeSkill(
                path.join(dir, "x", ".claude", "skills", "hidden-relative", "SKILL.md"),
                "hidden-relative",
              )
              yield* writeSkill(path.join(home.path, ".claude", "skills", "hidden-home", "SKILL.md"), "hidden-home")
              yield* writeSkill(path.join(extra.path, ".claude", "hidden-absolute", "SKILL.md"), "hidden-absolute")
              yield* writeSkill(path.join(extra.path, "visible", "SKILL.md"), "visible-path")
              yield* writeSkill(path.join(dir, ".agents", "skills", "project-visible", "SKILL.md"), "project-visible")

              const skill = yield* Skill.Service
              // Ordinary project and configured paths are unaffected.
              expect(yield* skill.get("project-visible")).toBeDefined()
              expect(yield* skill.get("visible-path")).toBeDefined()
              // A `.claude` segment is skipped however the path was written.
              expect(yield* skill.get("hidden-relative")).toBeUndefined()
              expect(yield* skill.get("hidden-home")).toBeUndefined()
              expect(yield* skill.get("hidden-absolute")).toBeUndefined()
            }),
          {
            git: true,
            config: {
              skills: {
                paths: [
                  "./x/.claude/skills",
                  "~/.claude/skills",
                  path.join(extra.path, ".claude"),
                  path.join(extra.path, "visible"),
                ],
              },
            },
          },
        ),
      )
    }),
  )

  urlIt.live("discovers skills.urls after skills.paths and lets the later source win", () =>
    Effect.gen(function* () {
      pulledUrls = []
      const extra = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      const url = "https://skills.example.test/index.json"
      const urlRoot = path.join(extra.path, "url-source")

      yield* provideTmpdirInstance(
        (dir) =>
          Effect.gen(function* () {
            yield* writeSkill(path.join(dir, "configured", "shared-name", "SKILL.md"), "shared-name")
            yield* writeSkill(path.join(urlRoot, "from-url", "SKILL.md"), "from-url")
            yield* writeSkill(path.join(urlRoot, "shared-name", "SKILL.md"), "shared-name")
            pulledSkillDirs = (requested) => (requested === url ? [urlRoot] : [])

            const skill = yield* Skill.Service
            expect(yield* skill.get("from-url")).toMatchObject({
              location: path.join(urlRoot, "from-url", "SKILL.md"),
            })
            // urls are discovered after skills.paths, so their copy overrides.
            expect((yield* skill.require("shared-name")).location).toBe(path.join(urlRoot, "shared-name", "SKILL.md"))
            expect(pulledUrls).toEqual([url])
          }),
        { git: true, config: { skills: { paths: ["./configured"], urls: [url] } } },
      )
    }),
  )

  it.live("merges skill sources in priority order", () =>
    Effect.gen(function* () {
      const home = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir({ git: true })),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      const extra = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      const configDir = path.join(home.path, ".config", "graphagent")

      yield* withHome(
        home.path,
        withConfigDir(
          configDir,
          provideTmpdirInstance(
            (dir) =>
              Effect.gen(function* () {
                yield* writeSkill(
                  path.join(home.path, ".agents", "skills", "dup-user-project", "SKILL.md"),
                  "dup-user-project",
                )
                yield* writeSkill(
                  path.join(dir, ".agents", "skills", "dup-user-project", "SKILL.md"),
                  "dup-user-project",
                )
                yield* writeSkill(
                  path.join(home.path, ".agents", "skills", "dup-user-config", "SKILL.md"),
                  "dup-user-config",
                )
                yield* writeSkill(path.join(configDir, "skills", "dup-user-config", "SKILL.md"), "dup-user-config")
                yield* writeSkill(
                  path.join(configDir, "skills", "dup-config-project", "SKILL.md"),
                  "dup-config-project",
                )
                yield* writeSkill(
                  path.join(dir, ".agents", "skills", "dup-config-project", "SKILL.md"),
                  "dup-config-project",
                )
                yield* writeSkill(
                  path.join(dir, ".agents", "skills", "dup-path-project", "SKILL.md"),
                  "dup-path-project",
                )
                yield* writeSkill(path.join(extra.path, "dup-path-project", "SKILL.md"), "dup-path-project")
                yield* writeSkill(path.join(dir, ".agents", "skills", "git-workflow", "SKILL.md"), "git-workflow")

                const skill = yield* Skill.Service
                expect((yield* skill.require("dup-user-project")).location).toContain(path.join(dir, ".agents"))
                expect((yield* skill.require("dup-user-config")).location).toContain(path.join(configDir, "skills"))
                expect((yield* skill.require("dup-config-project")).location).toContain(path.join(dir, ".agents"))
                expect((yield* skill.require("dup-path-project")).location).toContain(extra.path)
                // A project skill may shadow a built-in of the same name.
                expect((yield* skill.require("git-workflow")).location).not.toStartWith("/builtin/")
              }),
            { git: true, config: { skills: { paths: [extra.path] } } },
          ),
        ),
      )
    }),
  )

  it.live("does not walk above the project root", () =>
    Effect.gen(function* () {
      const parent = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir({ git: true })),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      const root = path.join(parent.path, "project")
      yield* Effect.promise(() => fs.mkdir(path.join(root, ".agents", "skills"), { recursive: true }))

      yield* writeSkill(path.join(parent.path, ".agents", "skills", "parent-skill", "SKILL.md"), "parent-skill")
      yield* writeSkill(path.join(root, ".agents", "skills", "child-skill", "SKILL.md"), "child-skill")

      yield* withHome(
        path.join(parent.path, "home"),
        Effect.gen(function* () {
          const skill = yield* Skill.Service
          expect(yield* skill.get("parent-skill")).toBeUndefined()
          expect(yield* skill.get("child-skill")).toBeDefined()
        }).pipe(provideInstance(root)),
      )
    }),
  )

  it.effect("applies same-name overrides in discovery order when parsing completes out of order", () =>
    Effect.gen(function* () {
      const logs: string[] = []
      const logger = Logger.make((options) => logs.push(JSON.stringify(options.message)))
      const matches = ["/skills/early/SKILL.md", "/skills/late/SKILL.md"]

      for (let attempt = 0; attempt < 50; attempt++) {
        const state: Skill.State = { skills: {}, dirs: new Set() }
        yield* Skill.loadSkills(state, { matches, dirs: [] }, {} as never, (match) =>
          // Real timers, not Effect.sleep: `it.effect` provides TestClock, which
          // would suspend until the test clock is advanced.
          Effect.promise(
            () =>
              new Promise((resolve) =>
                setTimeout(
                  () => resolve({ match, name: "duplicate", description: match, content: match }),
                  Math.floor(Math.random() * 20),
                ),
              ),
          ),
        ).pipe(Effect.withLogger(logger))

        // Discovery order, not parse completion order, picks the winner.
        expect(state.skills.duplicate?.location).toBe(matches[1])
      }

      expect(logs.filter((line) => line.includes("duplicate skill name"))).toHaveLength(50)
    }),
  )
})
