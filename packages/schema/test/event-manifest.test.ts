import { describe, expect, test } from "bun:test"
import {
  Event,
  FileSystem,
  Integration,
  Permission,
  Project,
  ProjectTrust,
  Reference,
  Session,
  Workspace,
} from "../src"
import { DagEvent } from "../src/dag-event"
import { EventManifest } from "../src/event-manifest"
import { IdeEvent } from "../src/ide-event"
import { SessionEvent } from "../src/session-event"
import { SessionTodo } from "../src/session-todo"
import { SessionV1 } from "../src/session-v1"
import { WorkspaceEvent } from "../src/workspace-event"

describe("public event manifest", () => {
  test("owns the complete public event surface", () => {
    expect(EventManifest.ServerDefinitions.length).toBe(27)
    expect(EventManifest.Definitions.length).toBe(66)
    expect([...SessionV1.Event.Definitions]).toEqual([
      SessionV1.Event.Created,
      SessionV1.Event.Updated,
      SessionV1.Event.Deleted,
      SessionV1.Event.MessageUpdated,
      SessionV1.Event.MessageRemoved,
      SessionV1.Event.PartUpdated,
      SessionV1.Event.PartRemoved,
      SessionV1.Event.AgentSwitched,
      SessionV1.Event.ModelSwitched,
      SessionV1.Event.PartDelta,
      SessionV1.Event.PartPreview,
      SessionV1.Event.Diff,
      SessionV1.Event.Error,
    ])
    expect(EventManifest.Latest.size).toBe(66)
    expect(EventManifest.Durable.size).toBe(31)
  })

  test("uses canonical definitions for current public events", () => {
    expect(Session.Event).toBe(SessionEvent)
    expect(Session.Event.Definitions).toBe(SessionEvent.Definitions)
    expect(Workspace.Event).toBe(WorkspaceEvent)
    expect(Workspace.Event.Definitions).toBe(WorkspaceEvent.Definitions)
    expect(EventManifest.Latest.get("session.next.moved")).toBe(SessionEvent.Moved)
    expect(EventManifest.Latest.get("todo.updated")).toBe(SessionTodo.Event.Updated)
    expect(EventManifest.Latest.get("project.updated")).toBe(Project.Event.Updated)
    expect(EventManifest.Latest.get("project.trust.updated")).toBe(ProjectTrust.Event.Updated)
    expect(Project.Event.Definitions).toEqual([Project.Event.Updated])
    expect(FileSystem.Event.Definitions).toEqual([FileSystem.Event.Edited])
    expect(Integration.Event.Definitions).toEqual([Integration.Event.Updated, Integration.Event.ConnectionUpdated])
    expect(Permission.Event.Definitions).toEqual([Permission.Event.Asked, Permission.Event.Replied])
    expect(Reference.Event.Definitions).toEqual([Reference.Event.Updated])
    expect(EventManifest.Latest.has("ide.installed")).toBe(false)
    expect(IdeEvent.Definitions).toEqual([IdeEvent.Installed])
    expect(EventManifest.Definitions.slice(15, 19)).toEqual([
      SessionV1.Event.PartDelta,
      SessionV1.Event.PartPreview,
      SessionV1.Event.Diff,
      SessionV1.Event.Error,
    ])
    expect(EventManifest.Durable.get("session.next.moved.1")).toBe(SessionEvent.Moved)
    expect(EventManifest.Durable.has("session.next.step.ended.2")).toBe(false)
  })

  test("registers every DAG durable event under its versioned public key", () => {
    DagEvent.DurableDefinitions.forEach((definition) => {
      if (!definition.durable) throw new Error(`${definition.type} is missing durable metadata`)
      expect(EventManifest.Durable.get(Event.versionedType(definition.type, definition.durable.version))).toBe(
        definition,
      )
    })
  })
})
