import type { SavedDraft } from "../../../../src/contracts/project-sessions/saved-draft-data";
import { describe, expect, it } from "vitest";
import { fakeSavedDrafts } from "../fakes/saved-drafts";
import { fixtureTimestamp, projectRecord } from "../fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "../renderer-store-fixture";

// Retain this narrow authority-to-identity regression until the real Session Registry
// permits a temporary identity to adopt its activated Working Directory. materializeIdentity
// currently checks the old location before relocating, throwing "Session ID collision detected".
// saved-draft-workflow.test.tsx supplies the corresponding visible Chat/sidebar regression;
// other saved-draft, staged-command, naming, and configuration journeys live in their workflows.
describe("Project pending-session authority integration", () => {
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
