/** @vitest-environment jsdom */
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { applySnapshot } from "r-state-tree";
import { expect, it, vi } from "vitest";
import type { UiPart } from "../../../src/contracts/conversations/session-contract";
import type { Client } from "../../../src/renderer/client/Client";
import { RendererRoot } from "../../../src/renderer/components/renderer-root";
import { applyConversationUpdate } from "../../../src/renderer/reducers/ConversationReducer";
import { snapshot } from "../helpers/piRuntimeFixture";
import { projectRecord } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture, unmountOnDispose } from "./renderer-store-fixture";

const sessionId = "project-chat:950768651fd1a98238949f08e0ca061cfa896af7729c1267e685a8dab3305abb";
const reference =
  "cake://session/project-chat%3A950768651fd1a98238949f08e0ca061cfa896af7729c1267e685a8dab3305abb?message=2507";

const answer = (entryId: string, text: string): UiPart => ({
  kind: "text",
  role: "assistant",
  status: "complete",
  id: `entry-${entryId}-text-0`,
  entryId,
  text,
});

it("jumps from Markdown in Project Chat to its exact assistant entry on an earlier page", async () => {
  const original = answer("2507", "Original answer");
  const history = vi
    .fn<Client["sessionChats"]["history"]>()
    .mockResolvedValueOnce({ parts: [answer("2600", "Intervening answer")], cursor: "older-2" })
    .mockResolvedValueOnce({ parts: [original], cursor: "older-3" });
  const inspect = vi.fn<Client["sessionChats"]["inspect"]>();
  const openExternalUrl = vi.fn();
  using fixture = createRendererStoreFixture({
    projects: [projectRecord({ path: "/learn-anything" })],
    client: { sessionChats: { history, inspect } },
  });
  const { root, models } = fixture;
  applySnapshot(models.cakeChatCatalog, {
    loaded: true,
    sessions: [{ sessionId, title: "Learn Anything", projectPath: "/learn-anything" }],
  });
  const chat = root.cakeChatCollectionStore.registry.load(sessionId);
  applyConversationUpdate(chat.model, {
    _tag: "Snapshot",
    revision: 1,
    snapshot: {
      ...snapshot,
      sessionId,
      historyCursor: "older-1",
      parts: [answer("2700", `[Read the original answer](${reference})`)],
    },
  });
  const interaction = chat.conversationSessionStore.chatStore.transcriptInteraction;
  // jsdom doesn't model native bottom alignment or scroll geometry.
  interaction.setTranscriptScrollPosition({ kind: "top" });
  await root.navigationStore.openCakeChat(sessionId);
  const linkError = vi.fn();
  const openSession = vi.fn((id: string, entryId?: string, attachmentId?: string) =>
    root.navigationStore.openSessionLink(id, entryId, attachmentId).catch(linkError),
  );
  using view = unmountOnDispose(
    render(
      <RendererRoot
        rootStore={root}
        openSession={openSession}
        openExternalUrl={openExternalUrl}
        openSubagent={vi.fn()}
      />,
    ),
  );
  const link = await screen.findByRole("link", { name: "Read the original answer" });
  expect(link.getAttribute("href")).toBe(reference);
  expect(history).not.toHaveBeenCalled();
  await userEvent.setup().click(link);
  expect(openSession).toHaveBeenCalledWith(sessionId, "2507");
  await act(async () => await openSession.mock.results[0]?.value);
  expect(linkError).not.toHaveBeenCalled();
  expect(history.mock.calls.map(([request]) => request)).toEqual([
    { sessionId, cursor: "older-1" },
    { sessionId, cursor: "older-2" },
  ]);
  expect(root.appShellStore.activeConversation?.sessionId).toBe(sessionId);
  expect(interaction.messageSelection).toMatchObject({
    messageId: original.id,
    origin: "navigation",
  });
  await waitFor(() =>
    expect(
      document
        .querySelector('[data-slot="transcript-item"][aria-current="true"] [data-part-id]')
        ?.getAttribute("data-part-id"),
    ).toBe(original.id),
  );
  expect(inspect).not.toHaveBeenCalled();
  expect(openExternalUrl).not.toHaveBeenCalled();
});
