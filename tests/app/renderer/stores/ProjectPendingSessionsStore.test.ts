import type { SavedDraft } from "../../../../src/contracts/project-sessions/saved-draft-data";
import { applySnapshot } from "r-state-tree";
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
    expect(pending.conversation(sessionId)?.draftPrompt?.text).toBe("First turn");
    const updated = { ...saved, text: "Updated by another device", revision: 2 };
    drafts.records.set(sessionId, updated);
    pending.applySavedDraftSnapshot(drafts.snapshot());
    expect(registry.findSession(sessionId)).toBe(session);
    expect(pending.savedRecord(sessionId)).toEqual(updated);
    expect(pending.conversation(sessionId)?.draftPrompt?.text).toBe(updated.text);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it.fails("relocates an activated Draft from another client to its authoritative Working Directory", async () => {
    const sessionId = "00000000-0000-4000-8000-000000000001";
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
    using fixture = createRendererStoreFixture({
      projects: [projectRecord({ path: projectPath, name: "Project" })],
      client: { savedDrafts: drafts.client },
    });
    const registry = fixture.root.sessionRegistry;
    await registry.pendingSessions.refreshSavedDrafts();
    const session = registry.findSession(sessionId);
    expect(session).toBeDefined();
    expect(session?.workspacePath).toBe(projectPath);

    const activated: SavedDraft = {
      ...saved,
      status: "activated",
      workingDirectory: "/worktrees/task",
      revision: 3,
    };
    drafts.records.set(sessionId, activated);
    // This is the main-owned Saved Draft snapshot delivery used by renderer synchronization.
    registry.pendingSessions.applySavedDraftSnapshot([activated]);

    expect(registry.findSession(sessionId)).toBe(session);
    expect(session?.workspacePath).toBe(activated.workingDirectory);
    expect(registry.pendingSessions.isTemporary(sessionId)).toBe(false);
  });
});
