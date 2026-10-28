/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { applySnapshot } from "r-state-tree";
import { StoreProvider } from "r-state-tree/react";
import { VirtuosoMockContext } from "react-virtuoso";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CAKE_CHAT_SESSION_ID } from "../../../src/contracts/cake-chats/cake-chat-identity";
import { TurnId } from "../../../src/contracts/conversations/conversation-data";
import type { ConversationSnapshot } from "../../../src/contracts/conversations/conversation-data";
import type { Attachment, UiPart } from "../../../src/contracts/conversations/session-contract";
import type { InternalInput } from "../../../src/contracts/conversations/internal-input";
import { addArtifactPresentationReminder } from "../../../src/contracts/artifacts/artifact-presentation-context";
import { internalInputEntryType } from "../../../src/services/pi/runtime/internal-input-projection";
import { MarkdownLinkProvider } from "../../../src/renderer/components/ai-elements/markdown";
import type { TaskInputReference } from "../../../src/contracts/conversations/task-input";
import type { Client } from "../../../src/renderer/client/Client";
import { CakeChatSurface } from "../../../src/renderer/components/cake-chat-surface";
import { Chat } from "../../../src/renderer/components/chat";
import { applyConversationSnapshot } from "../../../src/renderer/reducers/ConversationReducer";
import {
  imageContent,
  projectSessionEntries,
  promptText,
} from "../../../src/services/pi/runtime/session-projection";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import type { TestClientOverrides } from "./test-client";

afterEach(cleanup);

const pixels = "cGl4ZWxz"; // base64("pixels"), the pasted file's bytes
const imageSrc = `data:image/png;base64,${pixels}`;
const reference: TaskInputReference = {
  kind: "input",
  id: "4a3d9c1e-5b2f-4c8a-9e7d-6f1a2b3c4d5e",
  name: "shot.png",
  mimeType: "image/png",
  byteLength: 6,
};
const assistantPart: UiPart = {
  id: "entry-7-text-0",
  kind: "text",
  role: "assistant",
  entryId: "7",
  text: "Send me the screenshot.",
  status: "complete",
};

/** The real Pi projection of a saved user message, as main publishes it. */
function savedUserMessage(content: string | unknown[], internal?: InternalInput) {
  return projectSessionEntries([
    ...(internal
      ? [
          {
            type: "custom" as const,
            id: "internal-8",
            parentId: "7",
            timestamp: new Date(0).toISOString(),
            customType: internalInputEntryType,
            data: { timestamp: 2, origin: internal },
          },
        ]
      : []),
    {
      type: "message",
      id: "8",
      parentId: "7",
      timestamp: new Date(0).toISOString(),
      message: { role: "user", timestamp: 2, content },
    } as Parameters<typeof projectSessionEntries>[0][number],
  ]);
}

function savedContextualUserMessage(text: string, attachments: Attachment[]) {
  const prepared = addArtifactPresentationReminder(text, null);
  return savedUserMessage(promptText(prepared, attachments), {
    _tag: "UserWithReminders",
    text: prepared,
    userText: text,
    notices: [],
  });
}

function conversationSnapshot(sessionId: string, parts: UiPart[]): ConversationSnapshot {
  return {
    sessionId,
    sessionFile: "/chat.sqlite",
    parts,
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
}

function mountCakeChat(sessionId: string, client: TestClientOverrides, parts = [assistantPart]) {
  const fixture = createRendererStoreFixture({
    client: { artifacts: { effective: async () => [] }, ...client },
  });
  applySnapshot(fixture.models.cakeChatCatalog, {
    loaded: true,
    sessions: [
      {
        sessionId,
        title: "Chat",
        ...(sessionId === CAKE_CHAT_SESSION_ID ? {} : { projectPath: "/project" }),
      },
    ],
  });
  const chat = fixture.root.cakeChatCollectionStore.registry.load(sessionId);
  act(() => {
    fixture.root.cakeChatCollectionStore.pendingSessions.markMaterialized(sessionId);
    fixture.root.cakeChatCollectionStore.sessionLayoutStore.showSession(sessionId);
    fixture.root.navigationStore.selectCakeChat(sessionId);
    applyConversationSnapshot(chat.model, conversationSnapshot(sessionId, parts));
    chat.conversationSessionStore.chatStore.transcriptInteraction.setTranscriptScrollPosition({
      kind: "top",
    });
  });
  const openSession = vi.fn();
  const view = render(
    <MarkdownLinkProvider actions={{ openSession, openExternalUrl: vi.fn() }}>
      <StoreProvider store={fixture.root}>
        <VirtuosoMockContext.Provider value={{ viewportHeight: 1200, itemHeight: 100 }}>
          <CakeChatSurface />
        </VirtuosoMockContext.Provider>
      </StoreProvider>
    </MarkdownLinkProvider>,
  );
  return {
    view,
    session: chat.conversationSessionStore,
    openSession,
    publish: (next: UiPart[]) =>
      applyConversationSnapshot(chat.model, conversationSnapshot(sessionId, next)),
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}

function mountProjectSession(client: TestClientOverrides) {
  const sessionId = "project-session";
  const fixture = createRendererStoreFixture({
    projects: [projectRecord({ path: "/project", name: "Project" })],
    sessions: [sessionSummary({ sessionId, projectPath: "/project" })],
    client,
  });
  const session = fixture.root.sessionRegistry.load(sessionId, "/project");
  act(() => {
    applyConversationSnapshot(session.model, conversationSnapshot(sessionId, [assistantPart]));
    fixture.root.navigationStore.selectProjectSession(sessionId);
    fixture.root.projectWorkbenchStore.showLoadedSession(sessionId);
    session.conversationSessionStore.chatStore.transcriptInteraction.setTranscriptScrollPosition({
      kind: "top",
    });
  });
  const view = render(
    <VirtuosoMockContext.Provider value={{ viewportHeight: 1200, itemHeight: 100 }}>
      <Chat
        store={session.conversationSessionStore.chatStore}
        transcriptBehavior={{ messageReferenceSessionId: sessionId }}
        embedded
        composerFocusEnabled={false}
      />
    </VirtuosoMockContext.Provider>,
  );
  return {
    view,
    publish: (next: UiPart[]) =>
      applyConversationSnapshot(session.model, conversationSnapshot(sessionId, next)),
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}

async function sendScreenshot(container: HTMLElement, text: string) {
  const user = userEvent.setup();
  const input = screen.getByRole("combobox");
  fireEvent.paste(input, {
    clipboardData: {
      getData: () => "",
      files: [new File(["pixels"], "shot.png", { type: "image/png" })],
    },
  });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "View shot.png enlarged" })).toBeDefined(),
  );
  if (text) await user.type(input, text);
  await user.click(screen.getByRole("button", { name: "Send" }));
  // While the send is pending, the transcript shows the pasted pixels.
  const pending = await waitFor(() => {
    const image = container.querySelector<HTMLImageElement>(
      '[data-part-id^="optimistic-user-"] img[alt="shot.png"]',
    );
    expect(image).not.toBeNull();
    return image!;
  });
  expect(pending.getAttribute("src")).toBe(imageSrc);
}

const transcriptImages = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLImageElement>("[data-part-id] figure img")].map((image) =>
    image.getAttribute("src"),
  );

describe.each([
  ["Cake Chat", CAKE_CHAT_SESSION_ID],
  ["Project Chat", `project-chat:${"a".repeat(64)}`],
])("%s screenshot attachments", (_name, sessionId) => {
  it.each([
    ["image-only", ""],
    ["text and image", "Why does this flicker?"],
  ])(
    "keeps a sent %s screenshot visible when the saved reference replaces it",
    async (_variant, text) => {
      const prompt = vi.fn<Client["sessionChats"]["prompt"]>(async () =>
        TurnId.make("10000000-0000-4000-8000-000000000001"),
      );
      const readAttachment = vi.fn<Client["sessionChats"]["readAttachment"]>(async () => {
        throw new Error("The sent screenshot must not be re-read from the vault");
      });
      using chat = mountCakeChat(sessionId, { sessionChats: { prompt, readAttachment } });
      await sendScreenshot(chat.view.container, text);
      expect(prompt).toHaveBeenCalledWith(
        expect.objectContaining({
          text,
          attachments: [{ kind: "image", name: "shot.png", mimeType: "image/png", data: pixels }],
        }),
        expect.anything(),
      );

      // Cake Chat vaults the image; the saved message names the reference without pixels.
      const saved = savedContextualUserMessage(text, [reference]);
      expect(saved).toContainEqual(
        expect.objectContaining({ kind: "attachment", inputReference: reference }),
      );
      expect(saved.some((part) => part.kind === "attachment" && part.data)).toBe(false);
      chat.publish([assistantPart, ...saved]);
      // The hand-off is synchronous with reconciliation, before React renders the saved part.
      expect(chat.session.composerStore.deliveryStore.attachmentImages.image(reference.id)).toEqual(
        { status: "ready", src: imageSrc },
      );
      await act(async () => {});

      expect(chat.view.container.querySelector('[data-part-id^="optimistic-user-"]')).toBeNull();
      expect(transcriptImages(chat.view.container)).toEqual([imageSrc]);
      const figure = chat.view.container.querySelector<HTMLElement>("[data-part-id] figure")!;
      expect(within(figure).getByRole("link", { name: "shot.png" })).toBeDefined();
      expect(within(figure).queryByRole("status")).toBeNull();
      expect(readAttachment).not.toHaveBeenCalled();
      expect(prompt).toHaveBeenCalledTimes(1);
      await userEvent.setup().click(within(figure).getByRole("link", { name: "shot.png" }));
      expect(chat.openSession).toHaveBeenCalledExactlyOnceWith(sessionId, undefined, reference.id);
    },
  );

  it("loads a saved screenshot after reload inside the same reserved frame", async () => {
    const read =
      Promise.withResolvers<Awaited<ReturnType<Client["sessionChats"]["readAttachment"]>>>();
    const readAttachment = vi.fn<Client["sessionChats"]["readAttachment"]>(() => read.promise);
    using chat = mountCakeChat(sessionId, { sessionChats: { readAttachment } }, [
      assistantPart,
      ...savedContextualUserMessage("", [reference]),
    ]);

    const figure = await waitFor(() => {
      const element = chat.view.container.querySelector<HTMLElement>("[data-part-id] figure");
      expect(element).not.toBeNull();
      return element!;
    });
    const frame = figure.firstElementChild!;
    expect(within(figure).getByRole("status", { name: "Loading shot.png" })).toBeDefined();
    expect(within(figure).getByRole("link", { name: "shot.png" })).toBeDefined();
    expect(readAttachment).toHaveBeenCalledExactlyOnceWith(
      { sessionId, reference: reference.id },
      expect.anything(),
    );

    await act(async () =>
      read.resolve({ kind: "image", reference, mimeType: "image/png", data: pixels }),
    );
    expect(transcriptImages(chat.view.container)).toEqual([imageSrc]);
    expect(figure.isConnected).toBe(true);
    expect(figure.firstElementChild).toBe(frame);
    await userEvent.setup().click(within(figure).getByRole("link", { name: "shot.png" }));
    expect(chat.openSession).toHaveBeenCalledExactlyOnceWith(sessionId, undefined, reference.id);
  });

  it("keeps a generic file link on its contextual user message after send and reload", async () => {
    const fileReference: TaskInputReference = {
      ...reference,
      name: "notes.txt",
      mimeType: "text/plain",
    };
    const text = "Read these notes";
    const saved = savedContextualUserMessage(text, [fileReference]);
    const prompt = vi.fn<Client["sessionChats"]["prompt"]>();
    {
      using chat = mountCakeChat(sessionId, { sessionChats: { prompt } });
      act(() => chat.publish([assistantPart, ...saved]));
      expect(await screen.findByText(text)).toBeDefined();
      const link = screen.getByRole("link", { name: "notes.txt" });
      expect(link.getAttribute("href")).toContain(fileReference.id);
      await userEvent.setup().click(link);
      expect(chat.openSession).toHaveBeenCalledExactlyOnceWith(
        sessionId,
        undefined,
        fileReference.id,
      );
    }
    {
      using reloaded = mountCakeChat(sessionId, { sessionChats: { prompt } }, [
        assistantPart,
        ...saved,
      ]);
      expect(await screen.findByText(text)).toBeDefined();
      await userEvent.setup().click(screen.getByRole("link", { name: "notes.txt" }));
      expect(reloaded.openSession).toHaveBeenCalledExactlyOnceWith(
        sessionId,
        undefined,
        fileReference.id,
      );
    }
    expect(prompt).not.toHaveBeenCalled();
  });
});

it("presents a Project Session screenshot as one image, not a link chip above it", async () => {
  const prompt = vi.fn<Client["sessionChats"]["prompt"]>(async () =>
    TurnId.make("10000000-0000-4000-8000-000000000002"),
  );
  using session = mountProjectSession({ sessionChats: { prompt } });
  const text = "Here is the layout bug";
  await sendScreenshot(session.view.container, text);

  // Project Sessions keep the pixels and add a file tag naming the pinned original.
  const resolved: Attachment = {
    kind: "image",
    name: "shot.png",
    mimeType: "image/png",
    data: pixels,
    originalPath: "/vault/original-image.png",
    inputReference: reference,
  };
  const saved = savedUserMessage([
    { type: "text", text: promptText(text, [resolved]) },
    ...imageContent([resolved]),
  ]);
  act(() => session.publish([assistantPart, ...saved]));

  await waitFor(() =>
    expect(session.view.container.querySelector('[data-part-id^="optimistic-user-"]')).toBeNull(),
  );
  expect(saved.filter((part) => part.kind === "attachment")).toHaveLength(1);
  expect(transcriptImages(session.view.container)).toEqual([imageSrc]);
  expect(screen.getAllByRole("link", { name: "shot.png" })).toHaveLength(1);
  const figure = session.view.container.querySelector<HTMLElement>("[data-part-id] figure")!;
  expect(within(figure).getByRole("link", { name: "shot.png" })).toBeDefined();
});
