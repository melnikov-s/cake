/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TurnId } from "../../../src/contracts/conversations/conversation-data";
import { Chat } from "../../../src/renderer/components/chat";
import { applyConversationUpdate } from "../../../src/renderer/reducers/ConversationReducer";
import { deliveryGate } from "./conversation-delivery-workflow-fixture";
import { renderConversationSession } from "./conversation-session-workflow-fixture";
import { projectRecord } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";

const turnId = TurnId.make("10000000-0000-4000-8000-000000000001");
afterEach(cleanup);

describe.each(["project", "cake-chat", "project-chat"] as const)(
  "%s immediate submission",
  (profile) => {
    it.each(["Enter", "Send"])(
      "projects text and attachments before blocked IPC through %s, then reconciles repeated text exactly once",
      async (action) => {
        const admission = deliveryGate<TurnId>();
        const prompt = vi.fn(() => admission.promise);
        using fixture = renderConversationSession(
          profile,
          { sessionChats: { prompt }, cakeChats: { start: () => admission.promise } },
          [],
          "Preview",
        );
        const input = screen.getByRole<HTMLTextAreaElement>("combobox", {
          name: fixture.inputLabel,
        });
        const transcript = () => within(screen.getByLabelText("Conversation"));
        await fixture.user.click(input);
        await fixture.user.paste("Pasted log\n" + "details\n".repeat(50));
        await fixture.user.type(input, "Same text");
        if (action === "Enter") await fixture.user.keyboard("{Enter}");
        else await fixture.user.click(screen.getByRole("button", { name: "Send" }));
        expect(input.value).toBe("");
        expect(transcript().getAllByText("Same text", { exact: true })).toHaveLength(1);
        expect(transcript().getByText("Pasted text · 52 lines", { exact: true })).toBeDefined();
        const canonical = {
          kind: "text" as const,
          id: "echo-1",
          entryId: "entry-1",
          role: "user" as const,
          text: "Same text",
          status: "complete" as const,
        };
        fixture.publish({ parts: [canonical], streaming: false });
        expect(transcript().getAllByText("Same text", { exact: true })).toHaveLength(1);
        await act(async () => admission.resolve(turnId));
        await fixture.user.type(input, "Same text");
        await fixture.user.click(screen.getByRole("button", { name: "Send" }));
        expect(transcript().getAllByText("Same text", { exact: true })).toHaveLength(2);
        fixture.publish({
          parts: [canonical, { ...canonical, id: "echo-2", entryId: "entry-2" }],
          streaming: false,
        });
        expect(transcript().getAllByText("Same text", { exact: true })).toHaveLength(2);
        expect(transcript().queryByText("You · sending")).toBeNull();
      },
    );
  },
);

it("keeps the first staged submission across activation before transcript hydration", async () => {
  const admission = deliveryGate<TurnId>();
  const start = vi.fn(() => admission.promise);
  using fixture = createRendererStoreFixture({
    projects: [projectRecord({ path: "/project", name: "Project" })],
    client: {
      projectSessions: { start },
      workspaces: { generateSessionTitle: async () => undefined },
    },
  });
  const session = fixture.root.sessionRegistry.pendingSessions.prepareStaged(
    "/project",
    "new-session",
  );
  fixture.root.navigationStore.selectProjectSession(session.sessionId);
  fixture.root.projectWorkbenchStore.showLoadedSession(session.sessionId);
  const composer = session.conversationSessionStore.composerStore;
  const chat = session.conversationSessionStore.chatStore;
  chat.transcriptInteraction.setTranscriptScrollPosition({ kind: "top" });
  const view = render(<Chat store={chat} composerFocusEnabled={false} />);
  try {
    const user = userEvent.setup();
    const input = screen.getByRole<HTMLTextAreaElement>("combobox", { name: "Message" });
    await user.type(input, "First input{Enter}");
    expect(input.value).toBe("");
    expect(screen.getAllByText("First input", { exact: true })).toHaveLength(1);
    expect(composer.deliveryStore.optimisticUserMessages.pending).toHaveLength(1);
    await act(async () => admission.resolve(turnId));
    expect(
      fixture.root.sessionRegistry.findSession(session.sessionId)?.conversationSessionStore
        .composerStore,
    ).toBe(composer);
    expect(screen.getAllByText("First input", { exact: true })).toHaveLength(1);
    act(() =>
      applyConversationUpdate(session.model, {
        _tag: "Snapshot",
        revision: 1,
        snapshot: {
          sessionId: session.sessionId,
          sessionFile: "/project/new.jsonl",
          parts: [
            { id: "first", kind: "text", role: "user", text: "First input", status: "complete" },
          ],
          models: [],
          thinkingLevel: "off",
          availableThinkingLevels: ["off"],
          streaming: false,
          diagnostics: [],
          commands: [],
          compatibility: { resources: [], diagnostics: [] },
          extensionUi: { statuses: [] },
          tree: [],
        },
      }),
    );
    expect(screen.getAllByText("First input", { exact: true })).toHaveLength(1);
    expect(composer.deliveryStore.optimisticUserMessages.pending).toHaveLength(0);
    await user.type(input, "\n");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(start).toHaveBeenCalledOnce();
  } finally {
    view.unmount();
  }
});
