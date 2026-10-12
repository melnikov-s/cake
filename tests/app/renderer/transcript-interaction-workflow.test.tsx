/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationSnapshot } from "../../../src/contracts/conversations/conversation-data";
import type { UiPart } from "../../../src/contracts/conversations/session-contract";
import type { Client } from "../../../src/renderer/client/Client";
import { Chat } from "../../../src/renderer/components/chat";
import { applyConversationUpdate } from "../../../src/renderer/reducers/ConversationReducer";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";

const sessionId = "transcript-interaction";
const userMessage: Extract<UiPart, { kind: "text" }> = {
  id: "saved-user",
  entryId: "user-entry",
  kind: "text",
  role: "user",
  text: "# Saved heading",
  status: "complete",
};

function renderTranscript(
  setUserMessageMarkdown: Client["sessionChats"]["setUserMessageMarkdown"],
) {
  const fixture = createRendererStoreFixture({
    client: { sessionChats: { setUserMessageMarkdown } },
    projects: [projectRecord({ path: "/project", name: "Project" })],
    sessions: [
      sessionSummary({ sessionId, projectPath: "/project", workingDirectory: "/project" }),
    ],
  });
  const session = fixture.root.sessionRegistry.load(sessionId, "/project");
  const snapshot: ConversationSnapshot = {
    sessionId,
    sessionFile: "/project/transcript-interaction.jsonl",
    parts: [userMessage],
    models: [],
    thinkingLevel: "off",
    availableThinkingLevels: ["off"],
    streaming: false,
    diagnostics: [],
    commands: [],
    compatibility: { resources: [], diagnostics: [] },
    extensionUi: { statuses: [] },
    tree: [],
  };
  let revision = 1;
  applyConversationUpdate(session.model, { _tag: "Snapshot", revision, snapshot });
  // Compact is a production Chat mode, not a substitute virtualizer. This suite
  // proves formatting/projection behavior only; it makes no native focus,
  // selection, geometry, or scrolling claims.
  const view = render(
    <Chat
      store={session.conversationSessionStore.chatStore}
      compact
      composerFocusEnabled={false}
    />,
  );
  return {
    user: userEvent.setup(),
    publish(renderAs?: "markdown") {
      act(() => {
        applyConversationUpdate(session.model, {
          _tag: "Snapshot",
          revision: ++revision,
          snapshot: { ...snapshot, parts: [{ ...userMessage, renderAs }] },
        });
      });
    },
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const heading = () => screen.queryByRole("heading", { name: "Saved heading" });
const markdownToggle = () => screen.getByRole("button", { name: "Render as Markdown" });
const plainToggle = () => screen.getByRole("button", { name: "Render as plain text" });

afterEach(cleanup);

describe("Transcript formatting workflow", () => {
  it("holds an optimistic edit through stale snapshots, yields to authority, and restores failed formatting for retry", async () => {
    const pendingSave = deferred();
    const failedSave = deferred();
    const save = vi
      .fn<Client["sessionChats"]["setUserMessageMarkdown"]>()
      .mockReturnValueOnce(pendingSave.promise)
      .mockReturnValueOnce(failedSave.promise)
      .mockResolvedValue(undefined);
    using fixture = renderTranscript(save);

    expect(heading()).toBeNull();
    expect(screen.getByText("# Saved heading")).toBeDefined();
    await fixture.user.click(markdownToggle());
    expect(heading()).toBeDefined();
    expect(plainToggle()).toHaveProperty("disabled", true);
    expect(save).toHaveBeenCalledExactlyOnceWith(
      { sessionId, entryId: "user-entry", renderAsMarkdown: true },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    // An unrelated authority snapshot still carries the old presentation.
    fixture.publish();
    expect(heading()).toBeDefined();
    await act(async () => {
      pendingSave.resolve();
      await pendingSave.promise;
    });
    await waitFor(() => expect(plainToggle()).toHaveProperty("disabled", false));
    expect(heading()).toBeDefined();

    fixture.publish("markdown");
    expect(heading()).toBeDefined();
    // Once authority has caught up, a later authority edit must take precedence
    // over the old optimistic preference (for example, from another window).
    fixture.publish();
    expect(heading()).toBeNull();
    expect(screen.getByText("# Saved heading")).toBeDefined();

    await fixture.user.click(markdownToggle());
    expect(heading()).toBeDefined();
    expect(plainToggle()).toHaveProperty("disabled", true);
    await act(async () => {
      failedSave.reject(new Error("Formatting service unavailable"));
      await failedSave.promise.catch(() => undefined);
    });
    expect(await screen.findByText("Formatting service unavailable")).toBeDefined();
    expect(screen.getByText("Could not change message formatting")).toBeDefined();
    expect(heading()).toBeNull();
    expect(markdownToggle()).toHaveProperty("disabled", false);

    await fixture.user.click(markdownToggle());
    await waitFor(() => expect(plainToggle()).toHaveProperty("disabled", false));
    expect(heading()).toBeDefined();
    expect(screen.queryByText("Formatting service unavailable")).toBeNull();
    expect(save).toHaveBeenCalledTimes(3);
    expect(save).toHaveBeenLastCalledWith(
      { sessionId, entryId: "user-entry", renderAsMarkdown: true },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
});
