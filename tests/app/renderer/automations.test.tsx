import { describe, expect, it, vi } from "vitest";
import { TurnId } from "../../../src/contracts/conversations/conversation-data";
import { AutomationOccurrenceId } from "../../../src/contracts/automations/automation-data";
import type { Client } from "../../../src/renderer/client/Client";
import type { AutomationInspection } from "../../../src/contracts/automations/automation-control";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import { applyAutomationCatalogUpdate } from "../../../src/renderer/reducers/AutomationReducer";
import {
  automation,
  automationDefinition,
  automationId,
  automationOccurrence,
  automationRun,
  automationSession,
  automationSummary,
  occurrenceId,
  runId,
  secondAutomationId,
} from "./fixtures/automation-fixtures";

// Nonvisual integration checkpoint explicitly authorized while the accepted prototype is missing.
// Keep the real Root/Models/Stores and fake only the typed external Client boundary.
describe("automation workflow state", () => {
  it("derives distinct running-automation, active-session and queued counts and filters authoritative definitions", () => {
    using fixture = createRendererStoreFixture();
    const { root, models } = fixture;
    applyAutomationCatalogUpdate(models.automations, {
      _tag: "Snapshot",
      snapshot: {
        revision: 1,
        automations: [
          automationSummary(),
          automationSummary({
            id: secondAutomationId,
            context: { _tag: "Project", projectPath: "/project" },
            state: { _tag: "suspended", reason: "Project is no longer trusted" },
            activity: { runningSessions: 0, queuedOccurrences: 1 },
          }),
        ],
        unresolvedSessions: [
          automationSession(),
          automationSession({
            identity: { ...automationSession().identity, sessionId: "automation-run-2" },
          }),
        ],
      },
    });
    const hub = root.automationsStore;
    expect([hub.runningAutomationCount, hub.activeSessionCount, hub.queuedOccurrenceCount]).toEqual(
      [1, 2, 4],
    );
    expect(models.sessionCatalog.sessions).toHaveLength(0);
    hub.setContext({ _tag: "Global" });
    expect(hub.filtered.map((item) => item.id)).toEqual([automationId]);
    hub.setContext({ _tag: "Project", projectPath: "/project" });
    hub.setState("suspended");
    expect(hub.filtered[0]?.state).toEqual({
      _tag: "suspended",
      reason: "Project is no longer trusted",
    });
    hub.setState("active");
    expect(hub.filtered).toHaveLength(0);
    hub.setContext(undefined);
    hub.setState(undefined);
    expect(hub.filtered).toHaveLength(2);
  });

  it("creates and edits an explicit definition through separate Context, Trigger and Task steps", async () => {
    const create = vi.fn(async () => automation());
    const update = vi.fn(async () => automation());
    using fixture = createRendererStoreFixture({ client: { automations: { create, update } } });
    const hub = fixture.root.automationsStore;
    const definition = automationDefinition({
      context: { _tag: "Project", projectPath: "/project" },
      trigger: {
        _tag: "Event",
        filter: {
          event: "assistant-response-completed",
          scope: { _tag: "Any" },
          sessionKinds: ["family-root", "family-child"],
          sessionId: "source-session",
          contentContains: "ready",
        },
      },
    });
    create.mockImplementation(async () => automation({ definition }));
    hub.beginCreate(definition);
    expect(hub.editor.step).toBe("context");
    hub.editor.setStep("trigger");
    hub.editor.setStep("task");
    hub.editor.initialState = "paused";
    await hub.save();
    expect(create).toHaveBeenCalledWith(
      { definition, initialState: "paused" },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(hub.selectedId).toBe(automationId);
    hub.editor.patch({ overlap: "parallel", completion: "auto-resolve" });
    await hub.save();
    expect(update).toHaveBeenCalledWith(
      {
        automationId,
        definition: { ...definition, overlap: "parallel", completion: "auto-resolve" },
      },
      expect.anything(),
    );
  });

  it("keeps a newly selected definition when an earlier inspection finishes late", async () => {
    const first = Promise.withResolvers<AutomationInspection>();
    const inspect = vi.fn<Client["automations"]["inspect"]>(async ({ automationId: id }) =>
      id === automationId
        ? first.promise
        : {
            automation: automation({
              id: secondAutomationId,
              state: { _tag: "suspended", reason: "Model unavailable" },
            }),
            activity: { runningSessions: 0, queuedOccurrences: 0 },
          },
    );
    using fixture = createRendererStoreFixture({ client: { automations: { inspect } } });
    const hub = fixture.root.automationsStore;
    const pending = hub.select(automationId);
    await hub.select(secondAutomationId);
    first.resolve({
      automation: automation(),
      activity: { runningSessions: 0, queuedOccurrences: 0 },
    });
    await pending;
    expect(hub.selectedId).toBe(secondAutomationId);
    expect(hub.editor.automation?.id).toBe(secondAutomationId);
    expect(hub.editor.automation?.state).toEqual({
      _tag: "suspended",
      reason: "Model unavailable",
    });
    expect(hub.history.automationId).toBe(secondAutomationId);
    expect(hub.memory.automationId).toBe(secondAutomationId);
  });

  it("pauses without stopping sessions or hiding accepted queue and exposes a manual queued result", async () => {
    const pause = vi.fn(async () => automation({ state: { _tag: "paused" } }));
    const trigger = vi.fn(async () => ({ _tag: "queued" as const, occurrenceId }));
    using fixture = createRendererStoreFixture({ client: { automations: { pause, trigger } } });
    const { root, models } = fixture;
    applyAutomationCatalogUpdate(models.automations, {
      _tag: "Snapshot",
      snapshot: {
        revision: 1,
        automations: [automationSummary()],
        unresolvedSessions: [automationSession()],
      },
    });
    await root.automationsStore.pause(automationId);
    applyAutomationCatalogUpdate(models.automations, {
      _tag: "Event",
      revision: 2,
      event: { _tag: "Upserted", summary: automationSummary({ state: { _tag: "paused" } }) },
    });
    expect(root.automationsStore.filtered[0]?.activity).toEqual({
      runningSessions: 2,
      queuedOccurrences: 3,
    });
    expect(models.automations.unresolvedSessions[0]?.running).toBe(true);
    await root.automationsStore.runNow(automationId);
    expect(root.automationsStore.lastTrigger).toEqual({ _tag: "queued", occurrenceId });
    expect(root.automationSessionsStore.identities).toHaveLength(0);
    expect(pause).toHaveBeenCalledTimes(1);
  });

  it("requires an explicit archive decision when runs are active and does not stop them on let-finish", async () => {
    const archive = vi.fn(async () => automation({ state: { _tag: "archived" } }));
    using fixture = createRendererStoreFixture({ client: { automations: { archive } } });
    applyAutomationCatalogUpdate(fixture.models.automations, {
      _tag: "Snapshot",
      snapshot: {
        revision: 1,
        automations: [automationSummary()],
        unresolvedSessions: [automationSession()],
      },
    });
    const hub = fixture.root.automationsStore;
    expect(await hub.requestArchive(automationId)).toBe(false);
    expect(archive).not.toHaveBeenCalled();
    expect(hub.archiveConfirmationId).toBe(automationId);
    await hub.archive(automationId, "let-finish");
    expect(archive).toHaveBeenCalledWith(
      { automationId, runningSessions: "let-finish" },
      expect.anything(),
    );
    expect(hub.archiveConfirmationId).toBeUndefined();
  });

  it("pages occurrence provenance and opens/restores a resolved real run without firing or Project lookup", async () => {
    const run = automationRun({
      status: { _tag: "completed", finishedAt: "2030-01-01T09:01:00.000Z" },
    });
    const history = vi.fn<Client["automations"]["history"]>(async ({ offset }) =>
      offset
        ? {
            occurrences: ["skipped", "blocked", "canceled"].map((tag, index) =>
              automationOccurrence({
                id: AutomationOccurrenceId.make(`30000000-0000-4000-8000-00000000000${index + 3}`),
                disposition:
                  tag === "skipped"
                    ? { _tag: "skipped", reason: "Overlap policy" }
                    : tag === "blocked"
                      ? { _tag: "blocked", reason: "Project unavailable" }
                      : { _tag: "canceled", reason: "Archived" },
              }),
            ),
            runs: [],
            total: 5,
            nextOffset: null,
          }
        : {
            occurrences: [
              automationOccurrence(),
              automationOccurrence({
                id: AutomationOccurrenceId.make("30000000-0000-4000-8000-000000000002"),
                source: {
                  _tag: "Event",
                  eventId: "source-event",
                  event: "assistant-response-completed",
                  sourceSessionId: "source-session",
                  sourceMessageId: "source-message",
                },
                disposition: { _tag: "queued" },
              }),
            ],
            runs: [run],
            total: 5,
            nextOffset: 2,
          },
    );
    const restore = vi.fn(async () => {});
    using fixture = createRendererStoreFixture({
      client: {
        automations: { history },
        projectSessions: {
          restore,
          lookup: async () => {
            throw new Error("Automation must never use Project lookup");
          },
        },
      },
    });
    applyAutomationCatalogUpdate(fixture.models.automations, {
      _tag: "Snapshot",
      snapshot: {
        revision: 1,
        automations: [
          automationSummary({ activity: { runningSessions: 0, queuedOccurrences: 0 } }),
        ],
        unresolvedSessions: [],
      },
    });
    const { root, models } = fixture;
    root.automationsStore.history.select(automationId);
    await root.automationsStore.showTab("runs");
    expect(root.automationsStore.history.occurrences[0]?.disposition).toEqual({
      _tag: "started",
      runId,
    });
    await root.automationsStore.history.load(true);
    expect(root.automationsStore.history.occurrences.map((item) => item.disposition._tag)).toEqual([
      "started",
      "queued",
      "skipped",
      "blocked",
      "canceled",
    ]);
    expect(root.automationsStore.history.occurrences[1]?.source).toMatchObject({
      _tag: "Event",
      sourceSessionId: "source-session",
      sourceMessageId: "source-message",
    });
    expect(history).toHaveBeenLastCalledWith(
      { automationId, offset: 2, limit: 20 },
      expect.anything(),
    );
    root.automationSessionsStore.openRun(root.automationsStore.history.runs[0]!);
    const session = root.automationSessionsStore.selectedSession!;
    expect(session.identity).toMatchObject({
      _tag: "AutomationSession",
      context: { _tag: "Global" },
      workingDirectory: "/home/user",
    });
    expect(session.resolved).toBe(true);
    expect(await session.setResolved(false)).toBe(true);
    expect(restore).toHaveBeenCalledWith(
      { sessionId: run.sessionId, userInitiated: true },
      expect.anything(),
    );
    expect(models.projectConversations).toHaveLength(0);
    expect(models.automationConversations).toHaveLength(1);
    expect(root.automationsStore.tab).toBe("runs");
  });

  it("uses the shared Chat Store for follow-up prompt and stop while multiple real automation runs coexist", async () => {
    const prompt = vi.fn(async () => TurnId.make("50000000-0000-4000-8000-000000000001"));
    const abort = vi.fn(async () => {});
    using fixture = createRendererStoreFixture({ client: { sessionChats: { prompt, abort } } });
    const { root, models } = fixture;
    applyAutomationCatalogUpdate(models.automations, {
      _tag: "Snapshot",
      snapshot: {
        revision: 1,
        automations: [automationSummary()],
        unresolvedSessions: [
          automationSession(),
          automationSession({
            identity: { ...automationSession().identity, sessionId: "automation-run-2" },
          }),
        ],
      },
    });
    expect(root.automationSessionsStore.openSession("automation-run-1")).toBe(true);
    expect(root.automationSessionsStore.openSession("automation-run-2")).toBe(true);
    const session = root.automationSessionsStore.selectedSession!;
    session.model.observedSnapshotRevision = 1;
    const chat = session.conversationSessionStore.chatStore;
    chat.setDraft("Continue reviewing");
    await chat.submit();
    expect(prompt).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "automation-run-2", text: "Continue reviewing" }),
      expect.anything(),
    );
    session.model.streaming = true;
    await chat.abort();
    expect(abort).toHaveBeenCalledWith(
      { sessionId: "automation-run-2", stop: { by: "user" } },
      expect.anything(),
    );
    expect(root.automationSessionsStore.sessions).toHaveLength(2);
    expect(models.projectConversations).toHaveLength(0);
  });

  it("zooms shared memory branches to exact paged originals and returns without losing selection", async () => {
    const range = { id: 0, n: 2 };
    const original = { id: 0, n: 1 };
    const readMemory = vi.fn(async () => ({
      lines: [{ range, text: "Summary", depth: 1 }],
      bytes: 7,
      budgetBytes: 10000,
      sourceCount: 2,
    }));
    const zoomMemory = vi.fn<Client["automations"]["zoomMemory"]>(async ({ range, offset }) =>
      range.n === 2
        ? {
            _tag: "Branch",
            children: [
              { range: original, text: "First note", depth: 0 },
              { range: { id: 1, n: 1 }, text: "Second note", depth: 0 },
            ],
          }
        : {
            _tag: "Original",
            sourceId: "note-0",
            text: offset ? "world" : "Hello ",
            offset: offset ?? 0,
            totalChars: 11,
            nextOffset: offset ? null : 6,
          },
    );
    using fixture = createRendererStoreFixture({
      client: { automations: { readMemory, zoomMemory } },
    });
    const hub = fixture.root.automationsStore;
    hub.selectedId = automationId;
    hub.memory.select(automationId);
    await hub.showTab("memory");
    expect(hub.memory.view?.budgetBytes).toBe(10000);
    await hub.memory.zoom(range);
    expect(hub.memory.lines).toHaveLength(2);
    await hub.memory.zoom(original);
    await hub.memory.loadMoreOriginal();
    expect(hub.memory.current?.zoom).toMatchObject({
      _tag: "Original",
      text: "Hello world",
      offset: 0,
      nextOffset: null,
    });
    hub.memory.back();
    expect(hub.memory.lines).toHaveLength(2);
    hub.memory.back();
    expect(hub.memory.lines[0]?.text).toBe("Summary");
    expect(hub.selectedId).toBe(automationId);
    expect(zoomMemory).toHaveBeenLastCalledWith(
      { automationId, range: original, offset: 6, maxChars: 8000 },
      expect.anything(),
    );
  });
});

describe("automation visual workflows awaiting the exact approved prototype", () => {
  it.todo("opens the global hub and shows automation sessions in project/global sidebar sections");
  it.todo("preselects the project from its New automation context-menu action");
  it.todo("creates schedules using friendly once/interval/calendar timezone controls");
  it.todo(
    "shows Definition, Runs and Memory as independent panes and opens real run conversations",
  );
  it.todo(
    "verifies composer focus, actual typing, retained input and submission in hidden Electron",
  );
});
