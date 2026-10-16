import { expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Layer, Option } from "effect"
import { FileMutation } from "@opencode-ai/core/file-mutation"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Location } from "@opencode-ai/core/location"
import { LocationMutation } from "@opencode-ai/core/location-mutation"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { PermissionHookScope } from "@opencode-ai/core/permission/hook-scope"
import { SessionConversationHooks } from "@opencode-ai/core/session/conversation-hooks"
import { SessionV2 } from "@opencode-ai/core/session"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { WriteTool } from "@opencode-ai/core/tool/write"
import { EditTool } from "@opencode-ai/core/tool/edit"
import { ApplyPatchTool } from "@opencode-ai/core/tool/apply-patch"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { settleTool, toolIdentity } from "./lib/tool"
const it = testEffect(Layer.empty)
for (const name of ["write", "edit", "apply_patch"] as const)
  for (const deny of [false, true])
    it.live(`native ${name} permission rewrites the final canonical tool (deny=${deny})`, () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) =>
          Effect.gen(function* () {
            yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "target.txt"), "before"))
            const original =
              name === "write"
                ? { path: "original.txt", content: "wrong" }
                : name === "edit"
                  ? { path: "target.txt", oldString: "before", newString: "wrong" }
                  : { patchText: "*** Begin Patch\n*** Add File: original.txt\n+wrong\n*** End Patch" }
            const replacement =
              name === "write"
                ? { path: "target.txt", content: "approved" }
                : name === "edit"
                  ? { path: "target.txt", oldString: "before", newString: "approved" }
                  : { patchText: "*** Begin Patch\n*** Update File: target.txt\n@@\n-before\n+approved\n*** End Patch" }
            let calls = 0
            const permission = Layer.succeed(
              PermissionV2.Service,
              PermissionV2.Service.of({
                assert: () =>
                  Effect.gen(function* () {
                    calls++
                    const state = Option.getOrUndefined(yield* Effect.serviceOption(PermissionHookScope.Service))
                    if (!state) return yield* Effect.die("missing invocation permission scope")
                    if (calls === 1) {
                      state.pendingInput = replacement
                      return yield* new PermissionV2.RejectedError()
                    }
                    if (deny) return yield* new PermissionV2.DeniedError({ rules: [] })
                    return undefined
                  }),
                ask: () => Effect.die("unused"),
                reply: () => Effect.die("unused"),
                get: () => Effect.die("unused"),
                forSession: () => Effect.die("unused"),
                list: () => Effect.die("unused"),
              }),
            )
            const active = Layer.succeed(
              Location.Service,
              Location.Service.of(location({ directory: AbsolutePath.make(tmp.path) })),
            )
            const resolution = LocationMutation.layer.pipe(Layer.provide(FSUtil.defaultLayer), Layer.provide(active))
            const mutation = FileMutation.layer.pipe(Layer.provide(FSUtil.defaultLayer))
            const registry = ToolRegistry.defaultLayer
            const leaves = Layer.mergeAll(WriteTool.layer, EditTool.layer, ApplyPatchTool.layer).pipe(
              Layer.provide(registry),
              Layer.provide(permission),
              Layer.provide(resolution),
              Layer.provide(mutation),
              Layer.provide(FSUtil.defaultLayer),
            )
            const host = SessionConversationHooks.Service.of({
              admit: () => Effect.void,
              beforeTool: ({ toolInput }) =>
                Effect.succeed({
                  toolInput,
                  permissionHooks: {
                    policy: () => Effect.succeed({ rules: [] }),
                    request: () => Effect.succeed({}),
                    confirm: () => Effect.void,
                  },
                }),
              afterTool: () => Effect.succeed({}),
            })
            const result = yield* Effect.gen(function* () {
              const tools = yield* ToolRegistry.Service
              return yield* settleTool(tools, {
                sessionID: SessionV2.ID.make("ses_rewrite"),
                ...toolIdentity,
                call: { type: "tool-call", id: "rewrite", name, input: original },
              })
            }).pipe(
              Effect.provideService(SessionConversationHooks.Service, host),
              Effect.provide(Layer.mergeAll(registry, leaves)),
            )
            expect(calls).toBe(2)
            expect(result.result.type).toBe(deny ? "error" : "text")
            expect(yield* Effect.promise(() => fs.readFile(path.join(tmp.path, "target.txt"), "utf8"))).toBe(
              deny ? "before" : name === "apply_patch" ? "approved\n" : "approved",
            )
            expect(
              yield* Effect.promise(() =>
                fs.access(path.join(tmp.path, "original.txt")).then(
                  () => true,
                  () => false,
                ),
              ),
            ).toBe(false)
          }),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      ),
    )
