import { Effect, Queue, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { AutomationCatalogUpdate } from "../../../../src/contracts/automations/automation-control";
import type { ConversationUpdate } from "../../../../src/contracts/conversations/conversation-data";
import { createModelObserver } from "../../../../src/renderer/observers/models";
import { createRendererStoreFixture } from "../renderer-store-fixture";
import {
  automationId,
  automationSession,
  automationSummary,
} from "../fixtures/automation-fixtures";
import { observerClient, observerRuntime } from "./observer-test-runtime";

describe("automation authoritative observations", () => {
  it("observes the catalog and real AutomationSession identity, removes auto-resolved placement and cancels closed conversations", async () => {
    using fixture = createRendererStoreFixture();
    const updates = Effect.runSync(Queue.unbounded<AutomationCatalogUpdate>());
    const conversationUpdates = Effect.runSync(Queue.unbounded<ConversationUpdate>());
    const canceled = vi.fn();
    const observe = vi.fn(() =>
      Stream.fromQueue(conversationUpdates).pipe(Stream.ensuring(Effect.sync(canceled))),
    );
    const client = observerClient({
      projects: { observeCatalog: () => Stream.never },
      managedWorktrees: {
        observeCatalog: () => Stream.never,
        observeOperations: () => Stream.never,
      },
      automations: { observe: () => Stream.fromQueue(updates) },
      conversations: { observe },
    });
    const runtime = observerRuntime(client);
    const observer = createModelObserver(runtime);
    const { root, models } = fixture;
    observer.observe({
      projection: models,
      projectSessionCatalogQueries: () => [],
      cakeChatCatalogQueries: () => [],
      projectSessionTargets: () => [],
      cakeChatTargets: () => [],
      automationSessionTargets: () => root.automationSessionsStore.observationTargets,
    });
    try {
      await Effect.runPromise(
        Queue.offer(updates, {
          _tag: "Snapshot",
          snapshot: {
            revision: 1,
            automations: [automationSummary()],
            unresolvedSessions: [automationSession()],
          },
        }),
      );
      await Effect.runPromise(Queue.take(runtime.consumed));
      expect(root.automationsStore.runningAutomationCount).toBe(1);
      expect(root.automationSessionsStore.openSession("automation-run-1")).toBe(true);
      const session = root.automationSessionsStore.selectedSession!;
      await Effect.runPromise(
        Queue.offer(conversationUpdates, {
          _tag: "Snapshot",
          revision: 1,
          snapshot: {
            sessionId: session.sessionId,
            sessionFile: "/sessions/run.jsonl",
            parts: [
              {
                id: "reply",
                kind: "text",
                role: "assistant",
                text: "Review complete",
                status: "complete",
              },
            ],
            models: [],
            thinkingLevel: "off",
            availableThinkingLevels: [],
            streaming: false,
            diagnostics: [],
            commands: [],
            compatibility: { resources: [], diagnostics: [] },
            extensionUi: { statuses: [] },
            tree: [],
          },
        }),
      );
      await Effect.runPromise(Queue.take(runtime.consumed));
      expect(observe).toHaveBeenCalledWith({
        _tag: "AutomationSession",
        sessionId: "automation-run-1",
      });
      expect(session.model.uiParts[0]).toMatchObject({ text: "Review complete" });
      expect(models.projectConversations).toHaveLength(0);
      await Effect.runPromise(
        Queue.offer(updates, {
          _tag: "Event",
          revision: 2,
          event: { _tag: "SessionRemoved", sessionId: session.sessionId },
        }),
      );
      await Effect.runPromise(Queue.take(runtime.consumed));
      expect(models.automations.unresolvedSessions).toHaveLength(0);
      expect(session.resolved).toBe(true);
      expect(models.automations.automations[0]?.id).toBe(automationId);
      root.automationSessionsStore.closeSession(session.sessionId);
      expect(models.automationConversations).toHaveLength(0);
    } finally {
      observer.stop();
      await runtime.dispose();
    }
    expect(canceled).toHaveBeenCalledTimes(1);
  });
});
