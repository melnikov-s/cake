import { toSnapshot, type StoreSnapshot } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import { piBuiltinSlashCommands } from "../../../../src/contracts/conversations/session-contract";
import { applySessionCatalogGroupUpdate } from "../../../../src/renderer/reducers/CatalogReducer";
import { applyConversationUpdate } from "../../../../src/renderer/reducers/ConversationReducer";
import { sessionSummary } from "../fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "../renderer-store-fixture";

function registryFixture(snapshot?: StoreSnapshot) {
  return createRendererStoreFixture({
    snapshot: snapshot ? { state: {}, children: { sessionRegistry: snapshot } } : undefined,
  });
}
function observe(
  fixture: ReturnType<typeof registryFixture>,
  sessionId: string,
  streaming = false,
  revision = 1,
) {
  applyConversationUpdate(fixture.models.projectConversation(sessionId, "/project"), {
    _tag: "Snapshot",
    revision,
    snapshot: {
      sessionId,
      sessionFile: `/project/${sessionId}.jsonl`,
      parts: [],
      models: [],
      thinkingLevel: "off",
      availableThinkingLevels: ["off"],
      streaming,
      diagnostics: [],
      commands: piBuiltinSlashCommands,
      compatibility: { resources: [], diagnostics: [] },
      extensionUi: { statuses: [] },
      tree: [],
    },
  });
}

// Narrow unavailable contracts: valid UI cannot request a conflicting directory for one ID;
// React text assertions cannot detect keyed-collection or catalog scan complexity. Main-created
// family registration enters through agent control, not a user-facing creation control.
// Observation demand is the real Root output consumed by Model synchronization. Do not invent
// an observer/transport to claim that manual snapshots prove subscription acquisition/eviction.
// Visible identity persistence is in session-identity-workflow; navigation/layout, saved-draft,
// staged-command, session-management, assistant, and catalog workflows own the replaced journeys.
describe("Session Registry identity and observation integration", () => {
  it("preserves keyed identity and rejects a conflicting Working Directory", () => {
    using fixture = registryFixture();
    const registry = fixture.root.sessionRegistry;
    const first = registry.load("session-1", "/project");
    const conversation = first.conversationSessionStore;
    const composer = conversation.composerStore;
    const configuration = conversation.configurationStore;
    const chat = conversation.chatStore;

    expect(registry.load("session-1", "/project")).toBe(first);
    expect(first.conversationSessionStore).toBe(conversation);
    expect(conversation.composerStore).toBe(composer);
    expect(conversation.configurationStore).toBe(configuration);
    expect(conversation.chatStore).toBe(chat);
    expect(() => registry.load("session-1", "/other-project")).toThrow(
      "Session ID collision detected: session-1",
    );
    expect(registry.findSession("session-1")).toBe(first);
  });

  it("indexes restored keyed Stores and avoids reconciling them on lookup or selection", () => {
    let snapshot: StoreSnapshot;
    {
      using fixture = registryFixture();
      fixture.root.sessionRegistry.load("session-1", "/project");
      fixture.root.sessionRegistry.load("session-2", "/project");
      snapshot = toSnapshot(fixture.root.sessionRegistry);
    }
    using restored = registryFixture(snapshot);
    const registry = restored.root.sessionRegistry;
    const first = registry.findSession("session-1");
    expect(first).toBeDefined();
    const sessionsGetter = vi.spyOn(registry, "sessions", "get");
    const second = registry.findSession("session-2");
    expect(second?.sessionId).toBe("session-2");
    restored.root.appShellStore.selectProjectSession("session-1");
    restored.root.appShellStore.selectProjectSession("session-2");
    expect(registry.findSession("session-1")).toBe(first);
    expect(registry.findSession("session-2")).toBe(second);
    expect(sessionsGetter).not.toHaveBeenCalled();
  });

  it("registers a main-created family child without quadratic scans or unsafe continuation capabilities", () => {
    using fixture = registryFixture({
      state: {
        targets: Array.from({ length: 100 }, (_, index) => ({
          sessionId: `session-${index}`,
          workspacePath: "/project",
        })),
      },
      children: {},
    });
    const { models, root } = fixture;
    const registry = root.sessionRegistry;
    const parent = registry.findSession("session-0")!;
    const other = registry.findSession("session-99")!;
    const scans = [
      vi.spyOn(models.discussionCatalogs, "find"),
      vi.spyOn(models.subagentCatalogs, "find"),
      vi.spyOn(models.scheduledMessageCatalogs, "find"),
    ];
    const child = registry.loadUnlistedFamilySession("child", "/project", "Child task", {
      familyId: "family",
      parentSessionId: parent.sessionId,
      childOrder: 1,
      depth: 1,
    });
    expect(registry.findSession(parent.sessionId)).toBe(parent);
    expect(registry.findSession(other.sessionId)).toBe(other);
    expect(registry.findSession("child")).toBe(child);
    expect(child.model).toBe(models.findProjectConversation("child"));
    expect(child.props.discussionCatalog).toBe(models.discussionCatalog("child"));
    expect(child.props.subagentCatalog).toBe(models.subagentCatalog("child"));
    expect(child.props.scheduledMessageCatalog).toBe(models.scheduledMessageCatalog("child"));
    expect(root.sessionCatalogStore.find("child")).toMatchObject({
      title: "Child task",
      familyParentSessionId: parent.sessionId,
      familyId: "family",
      familyChildOrder: 1,
      pending: true,
    });
    for (const scan of scans) expect(scan).not.toHaveBeenCalled();

    const sessionsGetter = vi.spyOn(registry, "sessions", "get");
    observe(fixture, parent.sessionId);
    observe(fixture, child.sessionId, true);
    const names = ["compact", "model", "name", "sidechat", "schedule", "toolcompact"];
    for (const session of [parent, child])
      expect(session.conversationSessionStore.chatStore.commands.map(({ name }) => name)).toEqual(
        names,
      );
    expect(sessionsGetter).not.toHaveBeenCalled();
    expect(registry.findSession("child")).toBe(child);
    expect(root.projectSessionObservationTargets).toEqual([
      { sessionId: "child", workingDirectory: "/project", allowCreate: true },
    ]);
  });

  it("does not restore warm observation demand, but pins selection and observes opened archives", () => {
    using fixture = registryFixture({
      state: {
        targets: [
          { sessionId: "session-1", workspacePath: "/project" },
          { sessionId: "session-2", workspacePath: "/project" },
        ],
      },
      children: {
        observationRetention: {
          state: { materializedSessionIds: ["session-1", "session-2"] },
          children: {},
        },
      },
    });
    const { root, models } = fixture;
    expect(root.projectSessionObservationTargets).toEqual([]);
    root.appShellStore.selectProjectSession("session-1");
    expect(root.projectSessionObservationTargets).toEqual([
      { sessionId: "session-1", workingDirectory: "/project", allowCreate: false },
    ]);
    root.sessionRegistry.observationRetention.retain("session-2");
    expect(root.projectSessionObservationTargets.map(({ sessionId }) => sessionId)).toEqual([
      "session-1",
      "session-2",
    ]);

    applySessionCatalogGroupUpdate(
      models.sessionCatalog,
      { projectPath: "/project", resolved: true },
      {
        _tag: "Snapshot",
        revision: 1,
        sessions: [
          sessionSummary({ sessionId: "archive", projectPath: "/project", resolved: true }),
        ],
      },
    );
    root.sessionRegistry.load("archive", "/project");
    expect(root.projectSessionObservationTargets).toContainEqual({
      sessionId: "archive",
      workingDirectory: "/project",
      allowCreate: false,
    });
  });

  it("keeps a running session outside the four idle observations and trims again when it settles", () => {
    using fixture = registryFixture();
    const { root } = fixture;
    root.sessionRegistry.load("running", "/project");
    observe(fixture, "running", true);
    for (let index = 0; index < 5; index += 1)
      root.sessionRegistry.load(`idle-${index}`, "/project");
    const demand = () => root.projectSessionObservationTargets.map(({ sessionId }) => sessionId);
    expect(demand()).toHaveLength(5);
    expect(demand()).toContain("running");
    expect(demand()).not.toContain("idle-0");

    observe(fixture, "running", false, 2);
    expect(demand()).toHaveLength(4);
    expect(demand()).toContain("running");
    expect(demand()).not.toContain("idle-1");
  });
});
