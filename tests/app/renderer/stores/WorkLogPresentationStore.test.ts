import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationSnapshot } from "../../../../src/contracts/conversations/conversation-data";
import { applyConversationUpdate } from "../../../../src/renderer/reducers/ConversationReducer";
import { projectRecord, sessionSummary } from "../fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "../renderer-store-fixture";

// Resource-only integration exception. Visible elapsed history, disclosure pruning,
// assistant streaming and independent Chat presentation live in the React workflow.
// A frozen/removed label cannot prove an interval was released. Observe the timer
// boundary with real Root/Registry/Conversation/Chat/WorkLog Stores, not a synthetic
// Chat props object, manual syncTimers call, or spy on a collaborating Store.
describe("Work-log resources through the real session lifecycle", () => {
  afterEach(() => vi.useRealTimers());

  it("stops idle clocks, restarts for new work and releases only the removed session's interval", () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(1_000_000);
    const idleTimers = vi.getTimerCount();
    {
      using fixture = createRendererStoreFixture({
        projects: [projectRecord({ path: "/project" })],
        sessions: ["first", "second"].map((sessionId) =>
          sessionSummary({ sessionId, projectPath: "/project" }),
        ),
      });
      const first = fixture.root.sessionRegistry.load("first", "/project");
      const second = fixture.root.sessionRegistry.load("second", "/project");
      // Materialize the same lazy Chat children that the product Chat consumes.
      void first.conversationSessionStore.chatStore.workLogPresentation;
      void second.conversationSessionStore.chatStore.workLogPresentation;
      let revision = 0;
      function publish(
        sessionId: string,
        state: "running" | "success" | "removed",
        toolId = "shared-tool",
      ) {
        const snapshot: ConversationSnapshot = {
          sessionId,
          sessionFile: `/project/${sessionId}.jsonl`,
          parts:
            state === "removed"
              ? []
              : [{ id: toolId, kind: "tool", name: "bash", input: "echo hi", state }],
          models: [],
          thinkingLevel: "off",
          availableThinkingLevels: ["off"],
          streaming: state === "running",
          diagnostics: [],
          commands: [],
          compatibility: { resources: [], diagnostics: [] },
          extensionUi: { statuses: [] },
          tree: [],
        };
        applyConversationUpdate(fixture.models.projectConversation(sessionId, "/project"), {
          _tag: "Snapshot",
          revision: ++revision,
          snapshot,
        });
      }

      publish("first", "running");
      publish("second", "running");
      expect(vi.getTimerCount()).toBe(idleTimers + 2);
      fixture.root.sessionRegistry.removeSession("first");
      expect(vi.getTimerCount()).toBe(idleTimers + 1);
      publish("second", "success");
      expect(vi.getTimerCount()).toBe(idleTimers);
      publish("second", "running", "next-tool");
      expect(vi.getTimerCount()).toBe(idleTimers + 1);
      publish("second", "removed");
      expect(vi.getTimerCount()).toBe(idleTimers);
      publish("second", "running", "third-tool");
      expect(vi.getTimerCount()).toBe(idleTimers + 1);
    }
    expect(vi.getTimerCount()).toBe(idleTimers);
  });
});
