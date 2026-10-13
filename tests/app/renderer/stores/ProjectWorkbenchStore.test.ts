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
  fixture.root.appShellStore.selectProjectSession("session-1");
  fixture.root.projectWorkbenchStore.showLoadedSession("session-1");
  return { ...fixture, session };
}

// GUI navigation, staged-composer restoration and resolved-session editing policy
// are covered by project-navigation, root-app, session-identity and workbench workflows.
// The cached-session failure/error journey now lives in workbench-lifecycle-workflow.
// These remaining entries are bootstrap or externally initiated controls, not GUI actions.
describe("Project workbench bootstrap and external-control integration", () => {
  it("re-authorizes the shell's restored selection before accepting its workspace", async () => {
    const inspect = vi.fn<Client["workspaces"]["inspect"]>(async (input) => ({
      ...input,
      trustRequired: true,
    }));
    const open = vi.fn<Client["projectSessions"]["open"]>();
    using fixture = createRendererStoreFixture({
      projects: [projectRecord({ path: "/project" })],
      sessions: [sessionSummary({ sessionId: "session-1", projectPath: "/project" })],
      client: { workspaces: { inspect }, projectSessions: { open } },
    });
    fixture.root.appShellStore.selectProjectSession("session-1");

    // Root.initialize is the renderer bootstrap boundary; there is no user control for it.
    await fixture.root.initialize();

    expect(inspect).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/project" }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(fixture.root.projectWorkbenchStore.projectOpenStore.pendingTrustPath).toBe("/project");
    expect(fixture.root.sessionRegistry.findSession("session-1")?.workspacePath).toBe("/project");
    expect(fixture.root.appShellStore.selection).toEqual({
      kind: "project-session",
      sessionId: "session-1",
    });
    expect(open).not.toHaveBeenCalled();
  });

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

  it("routes native editor selection requests only to their working directory, replacing a code-chat draft with an annotation", () => {
    using fixture = loadedWorkbench();
    const store = fixture.root.projectWorkbenchStore;
    const session = fixture.session;
    const reviews = fixture.root.reviewsStore;
    const draft = session.conversationSessionStore.composerStore.draftStore;
    // Native editor emits these transport events; jsdom cannot honestly initiate that selection.
    session.showPresentation("vscode");
    session.workspaceChatSidebarVisible = false;
    store.presentationStore.embeddedEditorStore.visible = true;
    const selection = {
      path: "src/main.ts",
      startLine: 4,
      startColumn: 2,
      endLine: 5,
      endColumn: 8,
      selectedText: "const answer =\n  calculate();",
      contextBefore: "function run() {",
      contextAfter: "}",
    };

    store.receive({
      type: "embedded-editor-side-chat-requested",
      workspacePath: "/elsewhere",
      ...selection,
    });
    expect(reviews.draftAnchor).toBeUndefined();
    expect(session.workspaceChatSidebarVisible).toBe(false);

    store.receive({
      type: "embedded-editor-side-chat-requested",
      workspacePath: "/project",
      ...selection,
    });
    expect(reviews.draftAnchor).toEqual({
      path: "src/main.ts",
      view: "file",
      start: { diffLine: 4, oldLine: 5, newLine: 5, column: 2 },
      end: { diffLine: 5, oldLine: 6, newLine: 6, column: 8 },
      selectedText: "const answer =\n  calculate();",
      contextBefore: "function run() {",
      contextAfter: "}",
      diff: "",
    });
    expect(session.workspaceChatSidebarVisible).toBe(true);
    expect(draft.attachments).toHaveLength(0);

    store.receive({
      type: "embedded-editor-annotation-requested",
      workspacePath: "/elsewhere",
      ...selection,
      comment: "Ignore this other workspace",
    });
    expect(reviews.draftAnchor).toBeDefined();
    expect(draft.attachments).toHaveLength(0);

    store.receive({
      type: "embedded-editor-annotation-requested",
      workspacePath: "/project",
      ...selection,
      comment: "Why is this here?",
    });
    expect(reviews.draftAnchor).toBeUndefined();
    expect(draft.attachments).toEqual([
      {
        kind: "source",
        name: "src/main.ts",
        location: { path: "src/main.ts", range: { start: { line: 4 }, end: { line: 5 } } },
        selectedText: "const answer =\n  calculate();",
        comment: "Why is this here?",
      },
    ]);
    expect(session.workspaceChatSidebarVisible).toBe(true);
  });
});
