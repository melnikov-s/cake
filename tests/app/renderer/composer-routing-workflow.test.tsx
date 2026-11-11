/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultProjectWorkflow } from "../../../src/contracts/application/application-data";
import { sessionLink } from "../../../src/contracts/conversations/message-reference";
import { Chat } from "../../../src/renderer/components/chat";
import { applyConversationUpdate } from "../../../src/renderer/reducers/ConversationReducer";
import { ScreenCaptureAttachmentStore } from "../../../src/renderer/stores/ScreenCaptureAttachmentStore";
import { SessionMetadataStore } from "../../../src/renderer/stores/SessionMetadataStore";
import { configurationSnapshot } from "./chat-configuration-workflow-fixture";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// Real catalog/metadata/routing Stores, not a constant routing fake: prop reconciliation
// must not hide the cost by moving equivalent catalog scans elsewhere in the input path.
function renderCatalogComposer() {
  const projects = Array.from({ length: 4 }, (_, project) => {
    const path = `/project-${project}`;
    return projectRecord({
      path,
      workflow: {
        ...defaultProjectWorkflow(),
        labels: [
          { id: "review", name: "Review", color: "blue" },
          { id: "ready", name: "Ready", color: "green" },
        ],
        assignments: Array.from({ length: 25 }, (_, session) => ({
          sessionId: `${path.slice(1)}-${session}`,
          labelIds: ["review"],
        })),
      },
    });
  });
  const sessions = projects.flatMap((project) =>
    Array.from({ length: 25 }, (_, session) =>
      sessionSummary({
        sessionId: `${project.path.slice(1)}-${session}`,
        projectPath: project.path,
      }),
    ),
  );
  const fixture = createRendererStoreFixture({
    projects,
    sessions,
    client: { electron: { showComposerContextMenu: async () => "insert-session" } },
  });
  const session = fixture.root.sessionRegistry.load(sessions[0]!.sessionId, projects[0]!.path);
  fixture.root.navigationStore.selectProjectSession(session.sessionId);
  fixture.root.projectWorkbenchStore.showLoadedSession(session.sessionId);
  applyConversationUpdate(session.model, {
    _tag: "Snapshot",
    revision: 1,
    snapshot: configurationSnapshot(session.sessionId, []),
  });
  const chat = session.conversationSessionStore.chatStore;
  const view = render(<Chat store={chat} embedded composerFocusEnabled={false} />);
  return {
    ...fixture,
    chat,
    user: userEvent.setup(),
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}

describe("composer routing catalog isolation", () => {
  it("does zero destination or label derivations for repeated typing, including after using either picker", async () => {
    const destinations = vi.spyOn(ScreenCaptureAttachmentStore.prototype, "destinations", "get");
    const labels = vi.spyOn(SessionMetadataStore.prototype, "sessionLabels");
    const labelIds = vi.spyOn(SessionMetadataStore.prototype, "sessionLabelIds");
    const projectLabels = vi.spyOn(SessionMetadataStore.prototype, "projectLabels");
    using fixture = renderCatalogComposer();
    const input = screen.getByRole<HTMLTextAreaElement>("combobox");
    // Materialize both children, as context-menu capability checks do. Subsequent
    // @child reads reconcile props even when the descriptor itself is cached.
    const picker = fixture.chat.sessionReferencePicker!;
    const movePicker = fixture.chat.draftMovePicker!;
    expect(picker.routing.projects.flatMap((project) => project.sessions)).toHaveLength(100);
    expect(labels.mock.calls.length).toBeGreaterThanOrEqual(100);
    const clearCounts = () => {
      destinations.mockClear();
      labels.mockClear();
      labelIds.mockClear();
      projectLabels.mockClear();
    };
    const expectNoCatalogWork = () => {
      expect(destinations).not.toHaveBeenCalled();
      expect(labels).not.toHaveBeenCalled();
      expect(labelIds).not.toHaveBeenCalled();
      expect(projectLabels).not.toHaveBeenCalled();
    };
    clearCounts();
    await fixture.user.type(input, "Ordinary draft typing");
    expect(input.value).toBe("Ordinary draft typing");
    expect(fixture.chat.draft).toBe(input.value);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Send" }).disabled).toBe(false);
    expectNoCatalogWork();

    fireEvent.contextMenu(input);
    await screen.findByRole("dialog", { name: "Session reference" });
    await fixture.user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // Exercise the move picker's real filtered routing too, without moving the draft.
    expect(
      movePicker.routing.projects[0]!.sessions.some((item) => item.sessionId === fixture.chat.id),
    ).toBe(false);
    clearCounts();
    await fixture.user.type(input, " after closing");
    expectNoCatalogWork();
    expect(fixture.chat.sessionReferencePicker).toBe(picker);
    expect(fixture.chat.draftMovePicker).toBe(movePicker);
    expectNoCatalogWork();
  });

  it("keeps open routing rows, label assignments and closed-picker reference names live", async () => {
    using fixture = renderCatalogComposer();
    const input = screen.getByRole("combobox");
    fireEvent.contextMenu(input);
    const picker = await screen.findByRole("dialog", { name: "Session reference" });
    const targetId = "project-1-0";
    const target = fixture.models.sessionCatalog.find(targetId)!;
    const project = fixture.models.projects.find("/project-1")!;
    await fixture.user.click(within(picker).getByRole("button", { name: "Expand project-1" }));
    const row = () => picker.querySelector<HTMLElement>(`[data-session-id="${targetId}"]`)!;
    expect(within(row()).getByLabelText("Labels: Review")).toBeTruthy();
    act(() => {
      target.title = "Renamed destination";
      project.name = "Renamed project";
      project.workflow = {
        ...project.workflow,
        labels: project.workflow.labels.map((label) =>
          label.id === "ready" ? { ...label, name: "Ready now" } : label,
        ),
        assignments: project.workflow.assignments.map((assignment) =>
          assignment.sessionId === targetId ? { ...assignment, labelIds: ["ready"] } : assignment,
        ),
      };
    });
    await waitFor(() => {
      expect(within(row()).getByText("Renamed destination")).toBeTruthy();
      expect(within(row()).getByLabelText("Labels: Ready now")).toBeTruthy();
      expect(within(picker).getByRole("region", { name: "Renamed project" })).toBeTruthy();
    });
    const removed = fixture.models.sessionCatalog.find("project-1-1")!;
    act(() => {
      removed.resolved = true;
    });
    await waitFor(() => expect(picker.querySelector('[data-session-id="project-1-1"]')).toBeNull());
    act(() => {
      removed.resolved = false;
    });
    await waitFor(() =>
      expect(picker.querySelector('[data-session-id="project-1-1"]')).toBeTruthy(),
    );
    await fixture.user.click(within(row()).getByRole("button"));
    expect(fixture.chat.draft).toBe(`[Session](${sessionLink(targetId)}) `);
    expect(
      screen.getByRole("button", { name: "Edit session reference: Renamed destination" }),
    ).toBeTruthy();
    act(() => {
      target.title = "Live reference name";
    });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Edit session reference: Live reference name" }),
      ).toBeTruthy(),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
