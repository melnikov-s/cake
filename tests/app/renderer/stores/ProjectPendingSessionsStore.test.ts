import type { SavedDraft } from "../../../../src/contracts/project-sessions/saved-draft-data";
import { applySnapshot, effect, toSnapshot } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import { fakeSavedDrafts } from "../fakes/saved-drafts";
import { fixtureTimestamp, projectRecord, sessionSummary } from "../fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "../renderer-store-fixture";

// Retain this narrow authority-to-identity regression until the real Session Registry
// permits a temporary identity to adopt its activated Working Directory. materializeIdentity
// currently checks the old location before relocating, throwing "Session ID collision detected".
// saved-draft-workflow.test.tsx supplies the corresponding visible Chat/sidebar regression;
// other saved-draft, staged-command, naming, and configuration journeys live in their workflows.
describe("Project pending-session authority integration", () => {
  // Lookup membership is the cache contract, independent of the saved-draft UI workflow.
  it("keeps pending-conversation lookups reactive across insertion, removal, and ID reuse", () => {
    using fixture = createRendererStoreFixture();
    const pending = fixture.root.sessionRegistry.pendingSessions;
    const observed: Array<ReturnType<typeof pending.conversation>> = [];
    const stop = effect(() => {
      observed.push(pending.conversation("one"));
    });
    try {
      expect(observed.at(-1)).toBeUndefined();
      pending.prepareStaged("/project", "one");
      const first = pending.conversation("one");
      expect(first).toBeDefined();
      expect(observed.at(-1)).toBe(first);

      pending.prepareStaged("/project", "two");
      expect(pending.conversation("one")).toBe(first);
      first!.setName("Renamed");
      expect(pending.conversation("one")?.title).toBe("Renamed");

      fixture.root.sessionRegistry.removeSession("one");
      expect(observed.at(-1)).toBeUndefined();
      expect(pending.conversation("two")).toBeDefined();

      pending.prepareStaged("/project", "one");
      expect(pending.conversation("one")).not.toBe(first);
      expect(observed.at(-1)).toBe(pending.conversation("one"));
    } finally {
      stop();
    }
  });

  // The persisted phase is a structural invariant; visible failure/retry coverage lives in
  // session-management and staged-session-command workflows.
  it("keeps one phase through staging, submission, failure, retry, and materialization", () => {
    using fixture = createRendererStoreFixture();
    const registry = fixture.root.sessionRegistry;
    const pending = registry.pendingSessions;
    const session = pending.prepareStaged("/project", "one");
    const conversation = pending.conversation("one");
    pending.prepareStaged("/project", "two");
    pending.trackFamilyParent("one", "family");
    const phases = () => toSnapshot(pending).state.sessionsById;
    expect(phases()).toEqual({ one: { phase: "staged" }, two: { phase: "staged" } });
    pending.projectSubmission("one", "First turn");
    expect(phases()).toEqual({ one: { phase: "submitting" }, two: { phase: "staged" } });
    expect(pending.isStaged("one")).toBe(false);
    expect(pending.summaries.map(({ sessionId }) => sessionId)).toEqual(["one"]);
    pending.cancelSubmission("one");
    expect(phases()).toEqual({ one: { phase: "staged" }, two: { phase: "staged" } });
    expect(pending.summaries).toEqual([]);
    expect(pending.conversation("one")).toBe(conversation);
    pending.projectSubmission("one", "Retry");
    pending.materialize("one", "/project");
    // A late failure cannot put a materialized identity back into the staged phase.
    pending.cancelSubmission("one");
    expect(phases()).toMatchObject({ one: { phase: "unlisted" }, two: { phase: "staged" } });
    expect(pending.isTemporary("one")).toBe(false);
    expect(pending.canCreateRuntime("one")).toBe(true);
    expect(pending.summaries[0]).toMatchObject({
      title: "Retry",
      draft: false,
      familyId: "family",
    });
    expect(registry.findSession("one")).toBe(session);
    expect(pending.conversation("two")).toBeDefined();
    applySnapshot(fixture.models.sessionCatalog, {
      sessions: [sessionSummary({ sessionId: "one", projectPath: "/project" })],
      resolvedHasMoreByProject: {},
    });
    expect(phases()).toEqual({ two: { phase: "staged" } });
    expect(pending.canCreateRuntime("one")).toBe(false);
    expect(registry.findSession("one")).toBe(session);
  });

  it("hydrates through explicit refresh and pushed authority, not construction or catalog reconciliation", async () => {
    const sessionId = "00000000-0000-4000-8000-000000000001";
    const startedId = "00000000-0000-4000-8000-000000000002";
    const projectPath = "/project";
    const saved: SavedDraft = {
      sessionId,
      projectPath,
      workingDirectory: projectPath,
      title: "Shared task",
      text: "First turn",
      attachments: [],
      labelIds: [],
      resolved: false,
      createdAt: fixtureTimestamp,
      modifiedAt: fixtureTimestamp,
      revision: 1,
      status: "saved",
    };
    const drafts = fakeSavedDrafts();
    drafts.records.set(sessionId, saved);
    const list = vi.fn(drafts.client.list);
    using fixture = createRendererStoreFixture({
      projects: [projectRecord({ path: projectPath, name: "Project" })],
      client: { savedDrafts: { ...drafts.client, list } },
    });
    const registry = fixture.root.sessionRegistry;
    const pending = registry.pendingSessions;
    expect(list).not.toHaveBeenCalled();
    expect(pending.savedRecord(sessionId)).toBeUndefined();

    // Catalog registration must still reconcile a newly materialized identity,
    // but an independent catalog update is not a Saved Draft loading boundary.
    const started = pending.prepareStaged(projectPath, startedId);
    pending.materialize(startedId, projectPath);
    expect(pending.summaries.map((summary) => summary.sessionId)).toContain(startedId);
    applySnapshot(fixture.models.sessionCatalog, {
      sessions: [sessionSummary({ sessionId: startedId, projectPath })],
      resolvedHasMoreByProject: {},
    });
    expect(pending.summaries.map((summary) => summary.sessionId)).not.toContain(startedId);
    expect(registry.findSession(startedId)).toBe(started);
    expect(list).not.toHaveBeenCalled();

    // Bootstrap still has an explicit initial read, and current-first observation
    // can subsequently update the same projected identity without another read.
    await pending.refreshSavedDrafts();
    expect(list).toHaveBeenCalledTimes(1);
    expect(pending.savedRecord(sessionId)).toEqual(saved);
    const session = registry.findSession(sessionId);
    expect(session).toBeDefined();
    expect(
      session?.conversationSessionStore.composerStore.pendingSessionDraftStore.prompt?.text,
    ).toBe("First turn");
    const updated = { ...saved, text: "Updated by another device", revision: 2 };
    drafts.records.set(sessionId, updated);
    pending.applySavedDraftSnapshot(drafts.snapshot());
    expect(registry.findSession(sessionId)).toBe(session);
    expect(pending.savedRecord(sessionId)).toEqual(updated);
    expect(
      session?.conversationSessionStore.composerStore.pendingSessionDraftStore.prompt?.text,
    ).toBe(updated.text);
    expect(list).toHaveBeenCalledTimes(1);
  });
});
