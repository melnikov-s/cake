import { describe, expect, it, vi } from "vitest";
import { TurnId } from "../../../../src/contracts/conversations/conversation-data";
import type { Client } from "../../../../src/renderer/client/Client";
import { fakeSavedDrafts } from "../fakes/saved-drafts";
import { projectRecord, sessionSummary } from "../fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "../renderer-store-fixture";
import type { TestClientOverrides } from "../test-client";

function loadedWorkbench(client: TestClientOverrides = {}) {
  const fixture = createRendererStoreFixture({
    client,
    projects: [projectRecord({ path: "/project" })],
    sessions: [sessionSummary({ sessionId: "session-1", projectPath: "/project" })],
  });
  const session = fixture.root.sessionRegistry.load("session-1", "/project");
  fixture.root.navigationStore.selectProjectSession("session-1");
  fixture.root.projectWorkbenchStore.showLoadedSession("session-1");
  return { ...fixture, session };
}

// GUI navigation, staged-composer restoration and resolved-session editing policy
// are covered by project-navigation, root-app, session-identity and workbench workflows.
// The cached-session failure/error journey now lives in workbench-lifecycle-workflow.
// Restored bootstrap authorization and native editor request routing now render
// the real App in workbench-lifecycle-workflow. Selection-coordinate conversion
// stays covered at its utility boundary in tests/app/utils/editor-selection.test.ts.
// Remaining native/agent-originated entries have no honest initiating React control.
describe("Project workbench external-control integration", () => {
  it.each(["draft", "prompted"] as const)(
    "creates an agent-originated %s session without replacing the visible conversation",
    async (kind) => {
      const drafts = fakeSavedDrafts();
      const start = vi.fn<Client["projectSessions"]["start"]>(async () =>
        TurnId.make("10000000-0000-4000-8000-000000000001"),
      );
      using fixture = loadedWorkbench({
        savedDrafts: drafts.client,
        projectSessions: { start },
      });
      // Let the mount-time Saved Draft refresh settle before creating a new authority record.
      await fixture.root.sessionRegistry.pendingSessions.refreshSavedDrafts();
      const creation = fixture.root.projectSessionCreationStore;

      const created =
        kind === "draft"
          ? await creation.createDraft("/other-project", "Background", "Run the tests")
          : await creation.createPrompted("/other-project", "Background", "Run the tests");

      expect(fixture.root.sessionRegistry.findSession(created)?.workspacePath).toBe(
        "/other-project",
      );
      expect(fixture.root.projectWorkbenchStore.projectOpenStore.projectPath).toBe("/project");
      expect(fixture.root.appShellStore.selection).toEqual({
        kind: "project-session",
        sessionId: "session-1",
      });
      if (kind === "draft") {
        expect(drafts.records.get(created)).toMatchObject({
          projectPath: "/other-project",
          title: "Background",
          text: "Run the tests",
          status: "saved",
        });
        expect(start).not.toHaveBeenCalled();
      } else {
        expect(start).toHaveBeenCalledWith(
          expect.objectContaining({
            sessionId: created,
            workingDirectory: "/other-project",
            name: "Background",
            text: "Run the tests",
          }),
          expect.objectContaining({ signal: expect.any(AbortSignal) }),
        );
        expect(fixture.root.sessionRegistry.pendingSessions.isTemporary(created)).toBe(false);
      }
    },
  );
});
