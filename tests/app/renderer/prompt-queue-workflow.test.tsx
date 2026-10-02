/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { observer } from "r-state-tree/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TurnId,
  type ConversationSnapshot,
} from "../../../src/domain/conversations/conversation-data";
import type { Client } from "../../../src/renderer/client/Client";
import { Chat } from "../../../src/renderer/components/chat";
import { applyConversationUpdate } from "../../../src/renderer/reducers/ConversationReducer";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import type { TestClientOverrides } from "./test-client";

const sessionId = "session-one";
function snapshot(remoteState?: "steering" | "queued"): ConversationSnapshot {
  return {
    sessionId,
    sessionFile: "/project/session-one.jsonl",
    parts: [
      { id: "assistant-1", kind: "text", role: "assistant", text: "Working", status: "streaming" },
      ...(remoteState
        ? [
            {
              id: "remote-1",
              kind: "text" as const,
              role: "user" as const,
              text: "Remote follow-up",
              status: "complete" as const,
              deliveryState: remoteState,
            },
          ]
        : []),
    ],
    models: [],
    thinkingLevel: "off",
    availableThinkingLevels: ["off"],
    streaming: true,
    diagnostics: [],
    commands: [],
    compatibility: { resources: [], diagnostics: [] },
    extensionUi: { statuses: [] },
    tree: [],
  };
}

function renderQueue(client: TestClientOverrides = {}, remoteState?: "steering" | "queued") {
  const fixture = createRendererStoreFixture({
    client,
    projects: [projectRecord({ path: "/project", name: "Project" })],
    sessions: [sessionSummary({ sessionId, projectPath: "/project" })],
  });
  const session = fixture.root.sessionRegistry.load(sessionId, "/project");
  fixture.root.appShellStore.selectProjectSession(sessionId);
  fixture.root.projectWorkbenchStore.showLoadedSession(sessionId);
  const model = fixture.models.projectConversation(sessionId, "/project");
  let revision = 1;
  applyConversationUpdate(model, { _tag: "Snapshot", revision, snapshot: snapshot(remoteState) });
  const Surface = observer(function Surface() {
    const composer = session.conversationSessionStore.composerStore;
    return (
      <Chat
        store={session.conversationSessionStore.chatStore}
        embedded
        composerFocusEnabled={false}
        error={composer.error ? { message: composer.error } : undefined}
      />
    );
  });
  const view = render(<Surface />);
  return {
    user: userEvent.setup(),
    async streaming(streaming: boolean) {
      await act(async () =>
        applyConversationUpdate(model, {
          _tag: "Event",
          revision: ++revision,
          event: { _tag: "StreamingChanged", sessionId, streaming },
        }),
      );
    },
    async remoteQueued() {
      await act(async () =>
        applyConversationUpdate(model, {
          _tag: "Snapshot",
          revision: ++revision,
          snapshot: snapshot("queued"),
        }),
      );
    },
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}

async function enqueue(user: ReturnType<typeof userEvent.setup>, text: string) {
  await user.type(screen.getByRole("combobox"), text);
  await user.click(screen.getByRole("button", { name: "Send" }));
}
function queuedTexts() {
  return within(screen.getByRole("list", { name: "Queued prompts" }))
    .getAllByRole("listitem")
    .map((item) => within(item).getByRole("button", { name: /^View queued message:/ }).textContent);
}
afterEach(cleanup);

describe("Prompt queue workflow", () => {
  it("queues follow-ups while running, restores one for editing, and removes the other", async () => {
    const prompt = vi.fn<Client["sessionChats"]["prompt"]>(async () =>
      TurnId.make("10000000-0000-4000-8000-000000000001"),
    );
    using fixture = renderQueue({ sessionChats: { prompt } });
    await enqueue(fixture.user, "First");
    await enqueue(fixture.user, "Second");
    expect(queuedTexts()).toEqual(["First", "Second"]);
    expect(prompt).not.toHaveBeenCalled();
    await fixture.user.click(screen.getByRole("button", { name: "Edit queued prompt: Second" }));
    expect(screen.getByRole<HTMLTextAreaElement>("combobox").value).toBe("Second");
    expect(queuedTexts()).toEqual(["First"]);
    await fixture.user.click(screen.getByRole("button", { name: "Remove queued prompt: First" }));
    expect(screen.queryByRole("list", { name: "Queued prompts" })).toBeNull();
    await fixture.user.type(screen.getByRole("combobox"), " revised");
    await fixture.user.click(screen.getByRole("button", { name: "Send" }));
    expect(queuedTexts()).toEqual(["Second revised"]);
    expect(prompt).not.toHaveBeenCalled();
  });

  it("returns remote steering to the follow-up queue through the remote cancellation boundary", async () => {
    const cancelSteering = vi.fn<Client["sessionChats"]["cancelSteering"]>(async () => ({
      steering: ["Remote follow-up"],
      followUp: [],
    }));
    const clearQueue = vi.fn<Client["sessionChats"]["clearQueue"]>(async () => ({
      steering: [],
      followUp: [],
    }));
    using fixture = renderQueue({ sessionChats: { cancelSteering, clearQueue } }, "steering");
    await fixture.user.click(
      screen.getByRole("button", { name: "Cancel steering: Remote follow-up" }),
    );
    expect(cancelSteering).toHaveBeenCalledWith(
      { sessionId },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(clearQueue).not.toHaveBeenCalled();
    await fixture.remoteQueued();
    expect(queuedTexts()).toEqual(["Remote follow-up"]);
    expect(
      screen.getByRole("button", { name: "Send now as steering: Remote follow-up" }),
    ).toBeDefined();
    expect(screen.queryByRole("button", { name: "Cancel steering: Remote follow-up" })).toBeNull();
  });

  it("restores a failed head and drains one prompt per settled response in original order", async () => {
    const prompt = vi
      .fn<Client["sessionChats"]["prompt"]>()
      .mockRejectedValueOnce(new Error("Delivery failed"))
      .mockResolvedValue(TurnId.make("10000000-0000-4000-8000-000000000001"));
    using fixture = renderQueue({ sessionChats: { prompt } });
    await enqueue(fixture.user, "First");
    await enqueue(fixture.user, "Second");
    await fixture.streaming(false);
    expect(await screen.findByText("Delivery failed")).toBeDefined();
    expect(queuedTexts()).toEqual(["First", "Second"]);
    expect(prompt).toHaveBeenCalledTimes(1);
    await fixture.streaming(true);
    await fixture.streaming(false);
    await waitFor(() => expect(prompt).toHaveBeenCalledTimes(2));
    expect(queuedTexts()).toEqual(["Second"]);
    await fixture.streaming(true);
    await fixture.streaming(false);
    await waitFor(() => expect(prompt).toHaveBeenCalledTimes(3));
    expect(prompt.mock.calls.map(([input]) => input.text)).toEqual(["First", "First", "Second"]);
    expect(screen.queryByRole("list", { name: "Queued prompts" })).toBeNull();
    expect(screen.queryByText("Delivery failed")).toBeNull();
  });
});
