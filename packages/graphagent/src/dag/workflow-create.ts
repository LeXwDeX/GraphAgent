// SPDX-FileCopyrightText: 2026 LeXwDeX
// SPDX-License-Identifier: Apache-2.0

export * as DagWorkflowCreate from "./workflow-create"

import { DateTime, Effect, Exit, Option } from "effect"
import { DagEvent } from "@graphagent/schema/dag-event"
import type { BatchEvent } from "@graphagent/core/event"
import { transitionAdmission, validateAdmission } from "./admission"
import { bindWorkspace, normalizeWorkflowConfig } from "./workflow-config"
import { readUserMaxTotalNodes, type DagCommandCore } from "./command-core"
import { DagValidation, StructuralValidationError } from "./validation"
import { DagLocation } from "./location"
import { SessionLocation } from "@/session/location"
import { SessionID } from "@/session/schema"
import { InstanceRef } from "@/effect/instance-ref"
import type { WorkflowConfig, WorkflowWorktreeConfig } from "./dag"

/**
 * The workflow creation command: it validates the workflow config, resolves
 * the owner and execution directories, creates the workflow-level worktree when
 * the config asks for one, and publishes the creation batch in one transaction,
 * removing the worktree again when that publish does not commit. It runs on the
 * one `Core` the layer built, so it sees the same services as every other
 * command module.
 */
export const make = (environment: DagCommandCore.Core) =>
  Effect.gen(function* () {
    const { events, store } = environment
    const create = Effect.fn("Dag.create")(function* (input: {
      projectID: string
      sessionID: string
      title: string
      config: WorkflowConfig
      blockCompiled?: boolean
    }) {
      const config = normalizeWorkflowConfig(input.config)
      // Structural validation first, via the shared authority (the same one
      // the workflow validate action runs): duplicate ids would silently
      // merge via the projector's upsert, and a dangling depends_on reference
      // would silently drop the edge in buildGraph — turning a typo'd
      // dependency into an immediately-runnable root node. Rejection happens
      // before any event publication. The node ceiling is the lower of the
      // document's declaration and the user's global `dag.max_total_nodes`.
      const structural = DagValidation.structuralDiagnostics({
        nodes: config.nodes,
        delivery_node: config.delivery_node,
        mode: config.mode,
        review_gate: config.review_gate,
        max_total_nodes: config.max_total_nodes,
        user_max_total_nodes: yield* readUserMaxTotalNodes(),
        acceptance: config.acceptance,
        ...(input.blockCompiled === true ? { compiler_owns_skip_ok: true } : {}),
      })
      const structuralErrors = DagValidation.sortDiagnostics(structural.filter((d) => d.severity === "error"))
      for (const warning of structural.filter((d) => d.severity === "warning")) {
        yield* Effect.logWarning("DAG structural validation diagnostic", { diagnostic: warning })
      }
      if (structuralErrors.length > 0) {
        return yield* Effect.fail(new StructuralValidationError({ diagnostics: structuralErrors }))
      }
      // #1030 D9-g: the workflow-level worktree and a bound workspace are two
      // different execution bindings. Authoring reports the diagnostic; this
      // repeats the check for direct Dag.create callers and fail-closes
      // before any worktree or event exists.
      if (config.isolation !== undefined && config.workspace !== undefined) {
        return yield* Effect.fail(
          new Error("Invalid workflow config: config.isolation and config.workspace are mutually exclusive"),
        )
      }
      // #1030 D9-g: workflow-level isolation owns the single checkout every
      // child shares. A node bound to its own workspace or nested worktree
      // would contradict its execution-context prompt and its changes would
      // never reach the workflow's completion commit/patch. Authoring reports
      // the diagnostic; this repeats the check for direct Dag.create callers.
      if (
        config.isolation === "worktree" &&
        config.nodes.some((node) => node.workspace !== undefined || node.isolation !== undefined)
      ) {
        return yield* Effect.fail(
          new Error(
            "Invalid workflow config: config.isolation and node-level workspace/isolation are mutually exclusive",
          ),
        )
      }
      if (config.mode === "deep") {
        if (!config.admission) {
          return yield* Effect.fail(
            new Error(
              "Deep workflow admission blocked: admission is required; complete parent-session QA or provide an informed waiver",
            ),
          )
        }
        const admission = validateAdmission(config.admission)
        const stateAccepted = config.admission.state === "READY" || config.admission.state === "WAIVED"
        if (!admission.valid || !stateAccepted) {
          const errors = [
            ...(!stateAccepted
              ? [`state ${config.admission.state} cannot start a deep workflow; expected READY or WAIVED`]
              : []),
            ...(!admission.valid ? admission.errors : []),
            ...config.admission.brief.blocking_questions,
          ]
          return yield* Effect.fail(
            new Error(
              `Deep workflow admission blocked: ${errors.join("; ")}. Answer blockers, reduce scope, use standard mode, or provide an informed waiver`,
            ),
          )
        }
      }
      // #943: ownerDirectory keeps the DAG-LOC-01 ownership key; the workspace
      // is a separate execution binding resolved once and persisted on the
      // workflow row. The authoring boundary already checked it; this repeats
      // the resolution for direct Dag.create callers and stores realpaths.
      const ownerDirectory = yield* Effect.flatMap(
        SessionLocation.sessionDirectory(SessionID.make(input.sessionID)),
        (durable) =>
          durable._tag === "Some"
            ? Effect.succeed(DagLocation.canonicalDirectory(durable.value))
            : DagLocation.stampDirectory(),
      )
      // #1030 D9-g: fail closed before creating the workflow worktree. A
      // non-git or dirty owner checkout cannot produce a clean isolated tree;
      // the environment-profile diagnostics already reported the same facts to
      // authoring callers.
      if (config.isolation === "worktree") {
        if (!DagLocation.isGitWorktree(ownerDirectory)) {
          return yield* Effect.fail(
            new Error(
              `Invalid workflow config: workflow worktree isolation requires a git target, but "${ownerDirectory}" is not a git repository`,
            ),
          )
        }
        if (!DagLocation.isCleanWorktree(ownerDirectory)) {
          return yield* Effect.fail(
            new Error(
              `Invalid workflow config: workflow worktree isolation requires a clean target; commit or stash changes in "${ownerDirectory}" before starting`,
            ),
          )
        }
      }
      // #1030 D9-g: the workflow-level worktree is created BEFORE any event, so a
      // creation failure leaves zero durable trace. Both services are lazy for
      // the same bootstrap-cycle reason as spawn.ts/recovery.ts; tests without
      // them keep the pre-#1030 path unless config.isolation is set (then
      // create fail-closes).
      const dagID = DagEvent.DagID.create()
      const { Worktree } = yield* Effect.promise(() => import("@/worktree"))
      const worktreeSvc = Option.getOrUndefined(yield* Effect.serviceOption(Worktree.Service))
      const { InstanceStore } = yield* Effect.promise(() => import("@/project/instance-store"))
      const instanceStore = Option.getOrUndefined(yield* Effect.serviceOption(InstanceStore.Service))
      const instance = yield* Effect.serviceOption(InstanceRef)
      const ambient = Option.isSome(instance) ? instance.value : undefined
      const ambientReal = ambient?.directory ? DagLocation.canonicalDirectory(ambient.directory) : undefined
      const inOwnerInstance = <A, E, R>(
        directory: string | undefined,
        effect: Effect.Effect<A, E, R>,
      ): Effect.Effect<A, E, R> => {
        const real = directory ? DagLocation.canonicalDirectory(directory) : undefined
        return instanceStore && real && real !== ambientReal
          ? instanceStore.provide({ directory: real, trustProject: ambient?.trustProject === true }, effect)
          : effect
      }

      let workflowWorktree: WorkflowWorktreeConfig | undefined
      if (config.isolation === "worktree") {
        if (!worktreeSvc) {
          return yield* Effect.fail(new Error("Invalid workflow config: workflow worktree isolation requires the Worktree service"))
        }
        // Deterministic name prefix (dag-<dagID>-) lets a future reconciler find
        // an orphaned worktree after a crash between creation and the first
        // event. The Worktree service slugifies and appends a suffix on
        // collision, so the durable pointer always comes from its return value.
        const created = yield* inOwnerInstance(
          ownerDirectory,
          worktreeSvc.create({ name: `dag-${dagID}-workflow` }),
        ).pipe(Effect.result)
        if (created._tag === "Failure") {
          return yield* Effect.fail(new Error(`workflow worktree create failed: ${created.failure.message}`))
        }
        const directory = DagLocation.canonicalDirectory(created.success.directory)
        const baseHead = DagLocation.gitHead(directory)
        const branch = DagLocation.gitBranch(directory) ?? created.success.branch
        workflowWorktree = {
          directory,
          ...(branch ? { branch } : {}),
          ...(baseHead ? { baseHead } : {}),
        }
      }

      // A bound workspace and a workflow-level worktree are alternative
      // execution bindings; isolation skips workspace resolution entirely.
      const bound = yield* Effect.try({
        try: () =>
          workflowWorktree
            ? { config, workspace: workflowWorktree.directory }
            : bindWorkspace(config, ownerDirectory),
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      })
      const boundConfig: WorkflowConfig = workflowWorktree
        ? { ...bound.config, worktree: workflowWorktree }
        : bound.config
      const durableConfig =
        boundConfig.mode === "deep" && boundConfig.admission
          ? {
              ...boundConfig,
              admission: {
                ...boundConfig.admission,
                state: transitionAdmission(boundConfig.admission.state, "CONSUMED"),
              },
            }
          : boundConfig

      // Roll back the created worktree (directory and branch) when the creation
      // batch fails before committing. The whole create sequence is published in
      // ONE durable transaction, so a projector/handler failure leaves zero
      // events. But `publishMany` masks interruption only around the commit +
      // durable wake: an interrupt delivered during the NOTIFY phase (or between
      // the commit returning and this effect returning) surfaces as a failed
      // exit even though the batch is already durable, and that WorkflowCreated
      // row references this directory. So the rollback must first prove the
      // durable workflow is absent; a committed workflow keeps its directory and
      // is left to the orphan-pending sweep (event log has all three events).
      const removeWorkflowWorktree = () =>
        workflowWorktree && worktreeSvc
          ? inOwnerInstance(
              ownerDirectory,
              worktreeSvc.remove({ directory: workflowWorktree.directory, keepBranch: false }),
            ).pipe(Effect.ignore)
          : Effect.void
      // Safe direction: an unreadable store keeps the directory. A leaked
      // worktree is recoverable; deleting one that a durable workflow references
      // is not.
      const rollbackWorkflowWorktree = Effect.gen(function* () {
        if (!workflowWorktree) return
        const workflow = yield* store.getWorkflow(dagID)
        if (workflow) return
        yield* removeWorkflowWorktree()
      })
      return yield* Effect.gen(function* () {
        // #944: the target identity is captured from the bound execution
        // directory (the owner directory when no workspace is bound). Non-git
        // directories get the stable `none` marker. #1344: it waits for git, so
        // it runs inside the rollback scope below: an interrupt during the wait
        // must still remove the worktree created above.
        const targetFingerprint = yield* DagLocation.fingerprintTarget(bound.workspace ?? ownerDirectory)
        const ts = yield* DateTime.now
        const startTs = yield* DateTime.now
        // Same aggregate → one transaction with contiguous seqs (replan uses
        // the same publishMany contract). Per-event publishes would commit
        // WorkflowCreated/NodeRegistered independently: a later failure would
        // roll the worktree back while durable rows still reference it.
        const batch: BatchEvent[] = [
          {
            definition: DagEvent.WorkflowCreated,
            data: {
              dagID,
              projectID: input.projectID as never,
              sessionID: input.sessionID as never,
              title: input.title,
              config: JSON.stringify(durableConfig),
              status: "pending",
              timestamp: ts,
              // DAG-LOC-01 stamp (P2-F): the execution-location key is the
              // TARGET SESSION's durable directory — the single source of
              // truth. Stamping the ambient request instance's directory would
              // let a request on directory A create a workflow for B's session
              // stamped A, orphaning it from B's loops. Fall back to the
              // ambient instance only when the session has no durable row (the
              // workflow insert would fail its session FK anyway).
              directory: ownerDirectory,
              ...(bound.workspace !== undefined ? { executionDirectory: bound.workspace } : {}),
              targetFingerprint,
            },
          },
          ...durableConfig.nodes.map((node) => ({
            definition: DagEvent.NodeRegistered,
            data: {
              dagID,
              nodeID: node.id as never,
              name: node.name,
              workerType: node.worker_type,
              dependsOn: node.depends_on.map((d) => d as never),
              required: node.required ?? false,
              model: node.model as never,
              timestamp: ts,
            },
          })),
          { definition: DagEvent.WorkflowStarted, data: { dagID, timestamp: startTs } },
        ]
        yield* events.publishMany(batch)
        return dagID
      }).pipe(
        // onExit (not onError): an interruption before the uninterruptible
        // commit must also remove the worktree; a failure after the commit
        // (notify-phase interrupt) keeps it because the durable check in
        // rollbackWorkflowWorktree sees the committed workflow.
        Effect.onExit((exit) =>
          Exit.isSuccess(exit) ? Effect.void : Effect.uninterruptible(rollbackWorkflowWorktree),
        ),
      )
    })

    return { create }
  })
