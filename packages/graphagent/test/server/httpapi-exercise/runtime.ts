export type Runtime = {
  PublicApi: (typeof import("../../../src/server/routes/instance/httpapi/public"))["PublicApi"]
  HttpApiApp: (typeof import("../../../src/server/routes/instance/httpapi/server"))["HttpApiApp"]
  AppLayer: (typeof import("../../../src/effect/app-runtime"))["AppLayer"]
  memoMap: import("effect").Layer.MemoMap
  InstanceRef: (typeof import("../../../src/effect/instance-ref"))["InstanceRef"]
  InstanceStore: (typeof import("../../../src/project/instance-store"))["InstanceStore"]
  Session: (typeof import("../../../src/session/session"))["Session"]
  Goal: (typeof import("../../../src/goal/goal"))["Goal"]
  Todo: (typeof import("../../../src/session/todo"))["Todo"]
  ReminderClock: (typeof import("../../../src/reminder/clock"))["ReminderClock"]
  EngineProcess: (typeof import("../../../src/session/engine-process"))["EngineProcess"]
  BackgroundJob: (typeof import("../../../src/background/job"))["BackgroundJob"]
  ChildRegistry: (typeof import("../../../src/session/child/registry"))["ChildRegistry"]
  Worktree: (typeof import("../../../src/worktree"))["Worktree"]
  Project: (typeof import("../../../src/project/project"))["Project"]
  Dag: typeof import("../../../src/dag/dag")
  disposeAllInstances: (typeof import("../../fixture/fixture"))["disposeAllInstances"]
  tmpdir: (typeof import("../../fixture/fixture"))["tmpdir"]
  resetDatabase: (typeof import("../../fixture/db"))["resetDatabase"]
}

let runtimePromise: Promise<Runtime> | undefined

export function runtime() {
  return (runtimePromise ??= (async () => {
    const publicApi = await import("../../../src/server/routes/instance/httpapi/public")
    const httpApiServer = await import("../../../src/server/routes/instance/httpapi/server")
    const appRuntime = await import("../../../src/effect/app-runtime")
    const { Layer } = await import("effect")
    const instanceRef = await import("../../../src/effect/instance-ref")
    const instanceStore = await import("../../../src/project/instance-store")
    const session = await import("../../../src/session/session")
    const goal = await import("../../../src/goal/goal")
    const todo = await import("../../../src/session/todo")
    const reminderClock = await import("../../../src/reminder/clock")
    const engineProcess = await import("../../../src/session/engine-process")
    const backgroundJob = await import("../../../src/background/job")
    const childRegistry = await import("../../../src/session/child/registry")
    const worktree = await import("../../../src/worktree")
    const project = await import("../../../src/project/project")
    const dag = await import("../../../src/dag/dag")
    const fixture = await import("../../fixture/fixture")
    const db = await import("../../fixture/db")
    return {
      PublicApi: publicApi.PublicApi,
      HttpApiApp: httpApiServer.HttpApiApp,
      AppLayer: appRuntime.AppLayer,
      memoMap: Layer.makeMemoMapUnsafe(),
      InstanceRef: instanceRef.InstanceRef,
      InstanceStore: instanceStore.InstanceStore,
      Session: session.Session,
      Goal: goal.Goal,
      Todo: todo.Todo,
      ReminderClock: reminderClock.ReminderClock,
      EngineProcess: engineProcess.EngineProcess,
      BackgroundJob: backgroundJob.BackgroundJob,
      ChildRegistry: childRegistry.ChildRegistry,
      Worktree: worktree.Worktree,
      Project: project.Project,
      Dag: dag,
      disposeAllInstances: fixture.disposeAllInstances,
      tmpdir: fixture.tmpdir,
      resetDatabase: db.resetDatabase,
    }
  })())
}
