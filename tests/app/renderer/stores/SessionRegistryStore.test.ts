import { toSnapshot, type StoreSnapshot } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import { piBuiltinSlashCommands } from "../../../../src/contracts/conversations/session-contract";
import { applyConversationUpdate } from "../../../../src/renderer/reducers/ConversationReducer";
import { createRendererStoreFixture } from "../renderer-store-fixture";
import type { TestClientOverrides } from "../test-client";

function registryFixture(snapshot?: StoreSnapshot, client?: TestClientOverrides) {
  return createRendererStoreFixture({
    snapshot: snapshot ? { state: {}, children: { sessionRegistry: snapshot } } : undefined,
    client,
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
// Startup/selected/archive demand and visible/running LRU transitions now enter through real
// App navigation in session-observation-workflow. Visible identity persistence and authority
// precedence/removal are in session-identity-workflow; navigation/layout, saved-draft,
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
    restored.root.navigationStore.selectProjectSession("session-1");
    restored.root.navigationStore.selectProjectSession("session-2");
    expect(registry.findSession("session-1")).toBe(first);
    expect(registry.findSession("session-2")).toBe(second);
    expect(sessionsGetter).not.toHaveBeenCalled();
  });

  it("registers a main-created family child through agent control without quadratic scans or unsafe continuation capabilities", async () => {
    using fixture = registryFixture(
      {
        state: {
          targets: Array.from({ length: 100 }, (_, index) => ({
            sessionId: `session-${index}`,
            workspacePath: "/project",
          })),
        },
        children: {},
      },
      { projectSessions: { open: async () => undefined, respondControl: async () => undefined } },
    );
    const { models, root } = fixture;
    const registry = root.sessionRegistry;
    const parent = registry.findSession("session-0")!;
    const other = registry.findSession("session-99")!;
    const scans = [
      vi.spyOn(models.discussionCatalogs, "find"),
      vi.spyOn(models.subagentCatalogs, "find"),
      vi.spyOn(models.scheduledMessageCatalogs, "find"),
    ];
    await root.applicationControlStore.handleProjectSessionRequest({
      sessionId: parent.sessionId,
      controlRequestId: "00000000-0000-4000-8000-000000000001",
      invocation: {
        _tag: "ProjectChildSession",
        childSessionId: "child",
        workingDirectory: "/project",
        title: "Child task",
        familyId: "family",
        familyChildOrder: 1,
        familyDepth: 1,
        placement: "none",
      },
    });
    const child = registry.findSession("child")!;
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
});
