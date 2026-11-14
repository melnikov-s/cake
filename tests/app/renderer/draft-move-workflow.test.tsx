/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StoreProvider } from "r-state-tree/react";
import { toSnapshot, type StoreSnapshot } from "r-state-tree";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Attachment } from "../../../src/contracts/conversations/session-contract";
import type { SavedDraft } from "../../../src/contracts/project-sessions/saved-draft-data";
import { Chat } from "../../../src/renderer/components/chat";
import { ToastHost } from "../../../src/renderer/components/toast-host";
import { applyConversationUpdate } from "../../../src/renderer/reducers/ConversationReducer";
import { configurationModel, configurationSnapshot } from "./chat-configuration-workflow-fixture";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import { queuePart, type QueuePart } from "./prompt-queue-workflow-fixture";

const sourceId = "10000000-0000-4000-8000-000000000001";
const destinationId = "10000000-0000-4000-8000-000000000002";
const image: Attachment = {
  kind: "image",
  name: "Screenshot.png",
  mimeType: "image/png",
  data: "cGl4ZWxz",
};
const note: Attachment = {
  kind: "text",
  name: "Screenshot annotations",
  text: "1. Fix this button\n2. Keep the label",
};
const context: Extract<Attachment, { kind: "source" }> = {
  kind: "source",
  name: "Selected code",
  location: { path: "/project/a.ts", range: { start: { line: 1 }, end: { line: 2 } } },
};
const annotation: Attachment = {
  kind: "annotation",
  annotations: [
    {
      id: "20000000-0000-4000-8000-000000000001",
      messageId: "original-message",
      selectedText: "button",
      startOffset: 0,
      endOffset: 6,
      contextBefore: "",
      contextAfter: "",
      comment: "Keep this note",
    },
  ],
};
const savedDraft: SavedDraft = {
  sessionId: destinationId,
  projectPath: "/project",
  workingDirectory: "/project",
  title: "Saved destination",
  text: "Saved text",
  attachments: [note],
  labelIds: [],
  resolved: false,
  revision: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  modifiedAt: "2026-01-01T00:00:00.000Z",
  status: "saved",
  configuration: { provider: "openai", modelId: "gpt-5", thinkingLevel: "high", fastMode: false },
};

afterEach(cleanup);

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function setup(
  options: {
    embedded?: boolean;
    snapshot?: StoreSnapshot;
    save?: () => Promise<void>;
    saved?: SavedDraft;
    update?: (record: SavedDraft) => Promise<SavedDraft>;
    attachments?: Attachment[];
    queued?: boolean;
    withdraw?: () => Promise<void>;
  } = {},
) {
  const snapshots: StoreSnapshot[] = [];
  const prompt = vi.fn(async () => {
    throw new Error("Moving must never send");
  });
  const showMenu = vi.fn(async () => "move-draft" as const);
  const queued = queuePart(1, "Wrong queue", { attachments: [image, note, annotation, context] });
  let revision = 1;
  const publishQueued = (parts: QueuePart[]) => {
    applyConversationUpdate(fixture.models.projectConversation(sourceId, "/project"), {
      _tag: "Snapshot",
      revision: ++revision,
      snapshot: { ...configurationSnapshot(sourceId, [configurationModel()]), parts },
    });
  };
  const withdraw = vi.fn(async () => {
    await options.withdraw?.();
    publishQueued([]);
    return { steering: [], followUp: [] };
  });
  const updateQueued = vi.fn(async ({ text }: { text: string }) => {
    publishQueued([{ ...queued, text, queuedInput: { ...queued.queuedInput!, text } }]);
    return { steering: [], followUp: [text] };
  });
  const fixture = createRendererStoreFixture({
    snapshot: options.snapshot,
    projects: [projectRecord({ path: "/project", name: "Project" })],
    sessions: [sourceId, ...(options.saved ? [] : [destinationId])].map((sessionId) =>
      sessionSummary({ sessionId, projectPath: "/project" }),
    ),
    flushWindowState: async () => {
      snapshots.push(toSnapshot(fixture.root) ?? {});
      await options.save?.();
    },
    client: {
      electron: { showComposerContextMenu: showMenu },
      sessionChats: { prompt, removeQueuedMessage: withdraw, updateQueuedMessage: updateQueued },
      savedDrafts: {
        list: async () => (options.saved ? [options.saved] : []),
        update: async (record) =>
          options.update ? options.update(record) : { ...record, revision: record.revision + 1 },
      },
    },
  });
  const root = fixture.root;
  if (options.saved) root.sessionRegistry.pendingSessions.applySavedDraftSnapshot([options.saved]);
  const source = root.sessionRegistry.load(sourceId, "/project").conversationSessionStore;
  const destination =
    root.sessionRegistry.findSession(destinationId)?.conversationSessionStore ??
    root.sessionRegistry.load(destinationId, "/project").conversationSessionStore;
  for (const id of [sourceId, ...(options.saved ? [] : [destinationId])])
    applyConversationUpdate(fixture.models.projectConversation(id, "/project"), {
      _tag: "Snapshot",
      revision: 1,
      snapshot: configurationSnapshot(id, [configurationModel()]),
    });
  if (options.queued) publishQueued([queued]);
  root.navigationStore.showLoadedProjectSession(sourceId);
  if (!options.snapshot) {
    source.composerStore.draftStore.restore(
      "Move me\nScreenshot.png\n1. Fix this button",
      options.attachments ?? [image, note, annotation],
    );
    source.composerStore.draftStore.setEditorContextAttachment(context);
    destination.composerStore.draftStore.restore("Existing draft", [
      { kind: "text", name: "Existing context", text: "Keep me" },
    ]);
  }
  const view = render(
    <StoreProvider store={root}>
      <section aria-label="Source">
        <Chat store={source.chatStore} embedded={options.embedded} composerFocusEnabled={false} />
      </section>
      <section aria-label="Destination">
        <Chat store={destination.chatStore} embedded composerFocusEnabled={false} />
      </section>
      <ToastHost store={root.toastStore} />
    </StoreProvider>,
  );
  const user = userEvent.setup();
  const input = (label: string) =>
    within(screen.getByRole("region", { name: label })).getByRole(
      "combobox",
    ) as HTMLTextAreaElement;
  return {
    root,
    source,
    destination,
    snapshots,
    prompt,
    showMenu,
    withdraw,
    updateQueued,
    queued,
    publishQueued,
    user,
    async editQueue() {
      await user.click(screen.getByRole("button", { name: "Edit queued prompt: Wrong queue" }));
      return screen.getByRole("textbox", { name: "Queued message text" }) as HTMLTextAreaElement;
    },
    async forwardQueue() {
      await user.click(screen.getByRole("button", { name: "Forward to another session" }));
      const picker = await screen.findByRole("dialog", { name: "Forward to another session" });
      await expandProjectWithoutSelection(picker);
      expect(picker.querySelector(`[data-session-id="${sourceId}"]`)).toBeNull();
      await user.click(
        within(
          picker.querySelector<HTMLElement>(`[data-session-id="${destinationId}"]`)!,
        ).getByRole("button"),
      );
    },
    input,
    async move() {
      fireEvent.contextMenu(input("Source"));
      const picker = await screen.findByRole("dialog", { name: "Move draft to session" });
      await expandProjectWithoutSelection(picker);
      expect(picker.querySelector(`[data-session-id="${sourceId}"]`)).toBeNull();
      await user.click(
        within(
          picker.querySelector<HTMLElement>(`[data-session-id="${destinationId}"]`)!,
        ).getByRole("button"),
      );
    },
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}

/** Pickers without a highlighted destination open with every project collapsed. */
async function expandProjectWithoutSelection(picker: HTMLElement) {
  expect(picker.querySelector("[data-session-id]")).toBeNull();
  await userEvent.click(within(picker).getByRole("button", { name: "Expand Project" }));
}

// UI-to-real-Store-to-persistence workflow evidence. Native right-click, typing,
// portals and focus are separately exercised by the Electron smoke test.
describe.each([false, true])("move draft (embedded=%s)", (embedded) => {
  it("appends all text, screenshot pixels, annotations and editor context; saves before clearing, preserves settings, and safely undoes", async () => {
    using fixture = setup({ embedded });
    const from = toSnapshot(fixture.source.composerStore.draftStore);
    const before = toSnapshot(fixture.destination.composerStore.draftStore);
    const modelBefore = fixture.destination.model.model?.modelId;
    await fixture.move();
    await screen.findByText("Draft moved");
    expect(fixture.input("Source").value).toBe("");
    expect(fixture.input("Destination").value).toBe(
      "Existing draft\n\nMove me\nScreenshot.png\n1. Fix this button",
    );
    expect(fixture.destination.composerStore.draftStore.submissionAttachments).toEqual([
      { kind: "text", name: "Existing context", text: "Keep me" },
      context,
      image,
      note,
      annotation,
    ]);
    expect(fixture.showMenu).toHaveBeenCalledWith(
      expect.objectContaining({ canMoveDraft: true }),
      expect.any(Object),
    );
    expect(fixture.snapshots).toHaveLength(2);
    expect(JSON.stringify(fixture.snapshots[0])).toContain("Move me");
    expect(fixture.root.appShellStore.activeConversation).toEqual({
      kind: "project-session",
      sessionId: destinationId,
    });
    expect(fixture.destination.model.model?.modelId).toBe(modelBefore);
    expect(fixture.destination.model.thinkingLevel).toBe("high");
    expect(fixture.prompt).not.toHaveBeenCalled();
    await fixture.user.click(screen.getByRole("button", { name: "Undo" }));
    await screen.findByText("Draft restored. Nothing was sent.");
    expect(toSnapshot(fixture.source.composerStore.draftStore)).toEqual(from);
    expect(toSnapshot(fixture.destination.composerStore.draftStore)).toEqual(before);
    expect(fixture.snapshots).toHaveLength(4);
    expect(fixture.prompt).not.toHaveBeenCalled();
  });
});

it("uses a persisted composer snapshot without replacing newer in-memory destination edits", async () => {
  let snapshot: StoreSnapshot;
  {
    using original = setup();
    snapshot = toSnapshot(original.root) ?? {};
  }
  using fixture = setup({ snapshot });
  await fixture.user.type(fixture.input("Destination"), " plus live edits");
  await fixture.move();
  await screen.findByText("Draft moved");
  expect(fixture.input("Destination").value).toBe(
    "Existing draft plus live edits\n\nMove me\nScreenshot.png\n1. Fix this button",
  );
  expect(fixture.destination.composerStore.draftStore.submissionAttachments).toContainEqual(image);
});

it("leaves both original drafts intact when the destination save fails", async () => {
  using fixture = setup({
    save: async () => {
      throw new Error("Disk full");
    },
  });
  const source = toSnapshot(fixture.source.composerStore.draftStore);
  const destination = toSnapshot(fixture.destination.composerStore.draftStore);
  await fixture.move();
  await screen.findByText("Disk full");
  expect(toSnapshot(fixture.source.composerStore.draftStore)).toEqual(source);
  expect(toSnapshot(fixture.destination.composerStore.draftStore)).toEqual(destination);
  expect(fixture.prompt).not.toHaveBeenCalled();
});

it.each(["Source", "Destination"])(
  "retains concurrent %s edits while destination persistence is pending",
  async (label) => {
    const save = deferred();
    using fixture = setup({ save: () => save.promise });
    await fixture.move();
    await waitFor(() => expect(fixture.snapshots).toHaveLength(1));
    expect(fixture.input("Source").value).toContain("Move me");
    fireEvent.change(fixture.input(label), {
      target: { value: `${fixture.input(label).value} NEW EDIT` },
    });
    await act(async () => save.resolve());
    await screen.findByText(/The destination was saved and the source was kept/);
    expect(fixture.input(label).value).toContain("NEW EDIT");
    expect(fixture.input("Source").value).toContain("Move me");
  },
);

it.each(["Source", "Destination"])(
  "refuses Undo rather than overwriting later %s edits",
  async (label) => {
    using fixture = setup();
    await fixture.move();
    await screen.findByText("Draft moved");
    fireEvent.change(fixture.input(label), { target: { value: "Later draft" } });
    const source = toSnapshot(fixture.source.composerStore.draftStore);
    const destination = toSnapshot(fixture.destination.composerStore.draftStore);
    await fixture.user.click(screen.getByRole("button", { name: "Undo" }));
    await screen.findByText(/Cannot undo because a draft changed/);
    expect(toSnapshot(fixture.source.composerStore.draftStore)).toEqual(source);
    expect(toSnapshot(fixture.destination.composerStore.draftStore)).toEqual(destination);
  },
);

it("retains the saved destination if source restoration cannot be persisted during Undo", async () => {
  let saves = 0;
  using fixture = setup({
    save: async () => {
      if (++saves === 3) throw new Error("Undo disk full");
    },
  });
  await fixture.move();
  await screen.findByText("Draft moved");
  await fixture.user.click(screen.getByRole("button", { name: "Undo" }));
  await screen.findByText("Undo disk full");
  expect(fixture.input("Source").value).toContain("Move me");
  expect(fixture.input("Destination").value).toContain("Move me");
  expect(fixture.destination.composerStore.draftStore.submissionAttachments).toContainEqual(image);
});

it("warns about failed source cleanup only after the destination is durably saved", async () => {
  let saves = 0;
  using fixture = setup({
    save: async () => {
      if (++saves === 2) throw new Error("Cleanup disk full");
    },
  });
  await fixture.move();
  await screen.findByText(/Destination saved. Source cleanup could not be saved/);
  expect(fixture.input("Destination").value).toContain("Move me");
  expect(screen.getByRole("button", { name: "Undo" })).toBeDefined();
});

it("appends to an authoritative Saved Draft plus its live composer without changing settings, and restores both on Undo", async () => {
  const update = vi.fn(async (record: SavedDraft) => ({
    ...record,
    revision: record.revision + 1,
  }));
  using fixture = setup({ saved: savedDraft, update });
  await fixture.move();
  await screen.findByText("Draft moved");
  expect(update.mock.calls[0]![0]).toMatchObject({
    text: "Saved text\n\nExisting draft\n\nMove me\nScreenshot.png\n1. Fix this button",
    configuration: savedDraft.configuration,
    attachments: [
      note,
      { kind: "text", name: "Existing context", text: "Keep me" },
      context,
      image,
      note,
      annotation,
    ],
  });
  expect(fixture.destination.composerStore.draftStore.text).toBe("");
  expect(fixture.root.sessionRegistry.pendingSessions.savedRecord(destinationId)?.text).toContain(
    "Saved text\n\nExisting draft",
  );
  await fixture.user.click(screen.getByRole("button", { name: "Undo" }));
  await screen.findByText("Draft restored. Nothing was sent.");
  expect(update.mock.calls[1]![0]).toMatchObject({
    text: "Saved text",
    attachments: [note],
    configuration: savedDraft.configuration,
  });
  expect(fixture.destination.composerStore.draftStore.text).toBe("Existing draft");
});

it("keeps the source if a Saved Draft revision update fails", async () => {
  using fixture = setup({
    saved: savedDraft,
    update: async () => {
      throw new Error("Draft revision conflict");
    },
  });
  await fixture.move();
  await screen.findByText("Draft revision conflict");
  expect(fixture.input("Source").value).toContain("Move me");
  expect(fixture.destination.composerStore.draftStore.text).toBe("Existing draft");
});

it("moves an attachment-only draft without adding a spurious blank line", async () => {
  using fixture = setup();
  fireEvent.change(fixture.input("Source"), { target: { value: "" } });
  await fixture.move();
  await screen.findByText("Draft moved");
  expect(fixture.input("Destination").value).toBe("Existing draft");
  expect(fixture.destination.composerStore.draftStore.submissionAttachments).toContainEqual(image);
  expect(fixture.destination.composerStore.draftStore.submissionAttachments).toContainEqual(
    annotation,
  );
  expect(fixture.source.composerStore.draftStore.submissionAttachments).toEqual([]);
});

it("keeps concurrent destination edits made while Undo is saving the restored source", async () => {
  const restoration = deferred();
  let saves = 0;
  using fixture = setup({
    save: async () => {
      if (++saves === 3) await restoration.promise;
    },
  });
  await fixture.move();
  await screen.findByText("Draft moved");
  await fixture.user.click(screen.getByRole("button", { name: "Undo" }));
  await waitFor(() => expect(saves).toBe(3));
  fireEvent.change(fixture.input("Destination"), { target: { value: "Edited during Undo" } });
  await act(async () => restoration.resolve());
  await screen.findByText(/A draft changed during Undo/);
  expect(fixture.input("Destination").value).toBe("Edited during Undo");
  expect(fixture.destination.composerStore.draftStore.submissionAttachments).toContainEqual(image);
  expect(fixture.input("Source").value).toContain("Move me");
});

it("dismisses the destination picker without moving or saving anything", async () => {
  using fixture = setup();
  fireEvent.contextMenu(fixture.input("Source"));
  await screen.findByRole("dialog", { name: "Move draft to session" });
  await fixture.user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog", { name: "Move draft to session" })).toBeNull();
  expect(fixture.input("Source").value).toContain("Move me");
  expect(fixture.input("Destination").value).toBe("Existing draft");
  expect(fixture.snapshots).toHaveLength(0);
});

describe("forward from the queued-message editor", () => {
  it("reuses the move picker, carries edited text and every attachment, withdraws before moving, and leaves the source composer alone", async () => {
    const gate = deferred();
    using fixture = setup({ queued: true, withdraw: () => gate.promise });
    const source = toSnapshot(fixture.source.composerStore.draftStore);
    const editor = await fixture.editQueue();
    fireEvent.change(editor, { target: { value: "Edited for the destination" } });
    await fixture.forwardQueue();
    expect(fixture.withdraw).toHaveBeenCalledExactlyOnceWith(
      { sessionId: sourceId, partId: "queued-1" },
      expect.any(Object),
    );
    expect(fixture.input("Destination").value).toBe("Existing draft");
    expect(
      await fixture.source.chatStore.forwardQueuedPrompt("queued-1", "Duplicate", {
        kind: "project-session",
        sessionId: destinationId,
      }),
    ).toBe(false);
    expect(screen.getByRole("button", { name: "Saving…" })).toHaveProperty("disabled", true);
    fireEvent.keyDown(editor, { key: "Enter", ctrlKey: true });
    await act(async () => gate.resolve());
    await screen.findByText("Open in the destination for review. Nothing was sent.");
    expect(fixture.source.chatStore.queuedPrompts).toEqual([]);
    expect(fixture.input("Destination").value).toBe("Existing draft\n\nEdited for the destination");
    expect(fixture.destination.composerStore.draftStore.submissionAttachments).toEqual([
      { kind: "text", name: "Existing context", text: "Keep me" },
      image,
      note,
      context,
      annotation,
    ]);
    expect(toSnapshot(fixture.source.composerStore.draftStore)).toEqual(source);
    expect(fixture.withdraw).toHaveBeenCalledOnce();
    expect(fixture.updateQueued).not.toHaveBeenCalled();
    expect(fixture.prompt).not.toHaveBeenCalled();
  });

  it("cancels only the picker, retains edits and attachments, then saves through the unchanged edit path", async () => {
    using fixture = setup({ queued: true });
    const editor = await fixture.editQueue();
    fireEvent.change(editor, { target: { value: "Still here" } });
    await fixture.user.click(screen.getByRole("button", { name: "Forward to another session" }));
    await fixture.user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Forward to another session" })).toBeNull();
    expect(editor.value).toBe("Still here");
    expect(fixture.withdraw).not.toHaveBeenCalled();
    expect(fixture.snapshots).toHaveLength(0);
    await fixture.user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(fixture.updateQueued).toHaveBeenCalledOnce());
    expect(fixture.source.chatStore.queuedPrompts[0]).toMatchObject({
      text: "Still here",
      attachments: [image, note, annotation, context],
    });
    expect(fixture.input("Destination").value).toBe("Existing draft");
  });

  it("keeps the original queue, edited text and both composers on withdrawal failure", async () => {
    using fixture = setup({
      queued: true,
      withdraw: async () => {
        throw new Error("Queue unavailable");
      },
    });
    const source = toSnapshot(fixture.source.composerStore.draftStore);
    const target = toSnapshot(fixture.destination.composerStore.draftStore);
    const editor = await fixture.editQueue();
    fireEvent.change(editor, { target: { value: "Retry these edits" } });
    await fixture.forwardQueue();
    await screen.findByRole("alert");
    expect(editor.value).toBe("Retry these edits");
    expect(fixture.source.chatStore.queuedPrompts[0]).toMatchObject({
      text: "Wrong queue",
      attachments: fixture.queued.queuedInput!.attachments,
    });
    expect(toSnapshot(fixture.source.composerStore.draftStore)).toEqual(source);
    expect(toSnapshot(fixture.destination.composerStore.draftStore)).toEqual(target);
    expect(fixture.snapshots).toHaveLength(0);
  });

  it("retains an editor whose source was consumed while the picker was open, without forwarding it", async () => {
    using fixture = setup({ queued: true });
    const editor = await fixture.editQueue();
    fireEvent.change(editor, { target: { value: "Keep my edits" } });
    await fixture.user.click(screen.getByRole("button", { name: "Forward to another session" }));
    act(() => fixture.publishQueued([]));
    expect(screen.getByText(/no longer queued/)).toBeDefined();
    expect(editor.value).toBe("Keep my edits");
    expect(screen.getByRole("button", { name: "Save" })).toHaveProperty("disabled", true);
    await expect(
      fixture.source.chatStore.forwardQueuedPrompt("queued-1", "Keep my edits", {
        kind: "project-session",
        sessionId: destinationId,
      }),
    ).rejects.toThrow("no longer available");
    expect(fixture.withdraw).not.toHaveBeenCalled();
    expect(fixture.input("Destination").value).toBe("Existing draft");
  });

  it("retains the editor when runtime consumption wins after withdrawal starts", async () => {
    const gate = deferred();
    using fixture = setup({ queued: true, withdraw: () => gate.promise });
    const editor = await fixture.editQueue();
    fireEvent.change(editor, { target: { value: "Race edits" } });
    await fixture.forwardQueue();
    act(() => fixture.publishQueued([]));
    await act(async () => gate.reject(new Error("That message was already consumed")));
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "That message was already consumed",
    );
    expect(editor.value).toBe("Race edits");
    expect(fixture.input("Destination").value).toBe("Existing draft");
    expect(fixture.snapshots).toHaveLength(0);
  });

  it("rejects source/destination restrictions and attachment limits before withdrawal", async () => {
    using fixture = setup({ queued: true });
    const chat = fixture.source.chatStore;
    await expect(
      chat.forwardQueuedPrompt("queued-1", "Edited", {
        kind: "project-session",
        sessionId: sourceId,
      }),
    ).rejects.toThrow("another editable session");
    fixture.destination.composerStore.draftStore.appendAttachments(
      Array.from({ length: 20 }, (_, i) => ({ kind: "text", name: `Extra ${i}`, text: "Keep" })),
    );
    await expect(
      chat.forwardQueuedPrompt("queued-1", "Edited", {
        kind: "project-session",
        sessionId: destinationId,
      }),
    ).rejects.toThrow("combined draft exceeds");
    act(() =>
      fixture.publishQueued([
        { ...fixture.queued, queuedInput: { ...fixture.queued.queuedInput!, command: "help" } },
      ]),
    );
    await expect(
      chat.forwardQueuedPrompt("queued-1", "Edited", {
        kind: "project-session",
        sessionId: destinationId,
      }),
    ).rejects.toThrow("no longer available");
    expect(fixture.withdraw).not.toHaveBeenCalled();
  });

  it("does not lose or requeue a withdrawn message when destination persistence fails", async () => {
    using fixture = setup({
      queued: true,
      save: async () => {
        throw new Error("Disk full");
      },
    });
    await fixture.editQueue();
    await fixture.forwardQueue();
    await screen.findByText(/kept in the destination draft, but could not be saved: Disk full/);
    expect(fixture.source.chatStore.queuedPrompts).toEqual([]);
    expect(fixture.input("Destination").value).toBe("Existing draft\n\nWrong queue");
    expect(fixture.destination.composerStore.draftStore.submissionAttachments).toContainEqual(
      image,
    );
    expect(fixture.withdraw).toHaveBeenCalledOnce();
    expect(fixture.prompt).not.toHaveBeenCalled();
  });

  it("forwards an attachments-only edit without substituting the composer draft", async () => {
    using fixture = setup({ queued: true });
    const editor = await fixture.editQueue();
    fireEvent.change(editor, { target: { value: "" } });
    await fixture.forwardQueue();
    await screen.findByText("Open in the destination for review. Nothing was sent.");
    expect(fixture.input("Destination").value).toBe("Existing draft");
    expect(fixture.destination.composerStore.draftStore.submissionAttachments).toContainEqual(
      image,
    );
    expect(fixture.source.chatStore.queuedPrompts).toEqual([]);
  });

  it("uses revision-checked Saved Draft destination persistence", async () => {
    const update = vi.fn(async (record: SavedDraft) => ({
      ...record,
      revision: record.revision + 1,
    }));
    using fixture = setup({ queued: true, saved: savedDraft, update });
    await fixture.editQueue();
    await fixture.forwardQueue();
    await waitFor(() => expect(update).toHaveBeenCalledOnce());
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Saved text\n\nExisting draft\n\nWrong queue", revision: 1 }),
    );
    expect(fixture.source.chatStore.queuedPrompts).toEqual([]);
    expect(fixture.destination.composerStore.draftStore.text).toBe("");
  });
});

it("rejects over-limit merges without truncating or clearing either draft", async () => {
  using fixture = setup({
    attachments: Array.from({ length: 20 }, (_, i) => ({
      kind: "text",
      name: `File ${i}`,
      text: "Keep",
    })),
  });
  await fixture.move();
  await screen.findByText(/combined draft exceeds/);
  expect(fixture.source.composerStore.draftStore.attachments).toHaveLength(20);
  expect(fixture.input("Source").value).toContain("Move me");
  expect(fixture.input("Destination").value).toBe("Existing draft");
  expect(fixture.snapshots).toHaveLength(0);
});
