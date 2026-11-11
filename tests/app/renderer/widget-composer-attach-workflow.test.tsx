/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { applySnapshot } from "r-state-tree";
import { StoreProvider } from "r-state-tree/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TurnId } from "../../../src/contracts/conversations/conversation-data";
import type { Client } from "../../../src/renderer/client/Client";
import type { CakeArtifactV1 } from "../../../src/contracts/artifacts/artifact-contract";
import { decodeArtifactLineageId } from "../../../src/contracts/artifacts/artifact-lineage";
import { CAKE_CHAT_SESSION_ID } from "../../../src/contracts/cake-chats/cake-chat-identity";
import type { Attachment } from "../../../src/contracts/conversations/session-contract";
import type { SavedDraft } from "../../../src/contracts/project-sessions/saved-draft-data";
import {
  WIDGET_ITEM_DATA_MAX_BYTES,
  WIDGET_ITEM_LABEL_MAX,
  decodeWidgetComposerAttachInput,
  widgetComposerInputError,
  type WidgetItemOrigin,
} from "../../../src/contracts/widgets/widget-composer-item";
import { Chat } from "../../../src/renderer/components/chat";
import { WidgetArtifact } from "../../../src/renderer/components/widget-artifact";
import { applyConversationUpdate } from "../../../src/renderer/reducers/ConversationReducer";
import { configurationModel, configurationSnapshot } from "./chat-configuration-workflow-fixture";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";

const currentId = "10000000-0000-4000-8000-000000000001";
const otherId = "10000000-0000-4000-8000-000000000002";
const savedId = "10000000-0000-4000-8000-000000000003";
const resolvedId = "10000000-0000-4000-8000-000000000004";
const lineageId = decodeArtifactLineageId("delta-pr-tracker");
const origin = { lineageId, revision: 5, title: "Delta PRs" };
const current = { sessionId: currentId, kind: "project-session" as const };
const pr = { label: "#123 Fix flaky checkout test", itemId: "123", data: { number: 123 } };
const token = "00000000-0000-4000-8000-000000000010";

afterEach(cleanup);

function setup(
  options: { saved?: SavedDraft; flush?: () => Promise<void>; allowSend?: boolean } = {},
) {
  const prompt = vi.fn<Client["sessionChats"]["prompt"]>(async () => {
    if (options.allowSend) return TurnId.make("10000000-0000-4000-8000-0000000000aa");
    throw new Error("Attaching must never send");
  });
  const flushes = vi.fn(options.flush ?? (async () => undefined));
  const updateSaved = vi.fn(async (record: SavedDraft) => ({
    ...record,
    revision: record.revision + 1,
  }));
  const fixture = createRendererStoreFixture({
    projects: [projectRecord({ path: "/project", name: "Project" })],
    sessions: [
      sessionSummary({ sessionId: currentId, projectPath: "/project", title: "Current work" }),
      sessionSummary({ sessionId: otherId, projectPath: "/project", title: "Other work" }),
      sessionSummary({ sessionId: resolvedId, projectPath: "/project", resolved: true }),
    ],
    flushWindowState: flushes,
    client: {
      sessionChats: { prompt },
      inlineWidgets: { open: async () => ({ token, url: `cake-widget://document/${token}` }) },
      savedDrafts: {
        list: async () => (options.saved ? [options.saved] : []),
        update: updateSaved,
      },
    },
  });
  const root = fixture.root;
  applySnapshot(fixture.models.cakeChatCatalog, {
    loaded: true,
    sessions: [
      {
        sessionId: CAKE_CHAT_SESSION_ID,
        title: "Cake Chat",
        createdAt: "2026-01-01T00:00:00Z",
        modifiedAt: "2026-01-01T00:00:00Z",
        messageCount: 0,
        unstarted: false,
        resolved: false,
        unread: false,
        running: false,
      },
    ],
  });
  if (options.saved) root.sessionRegistry.pendingSessions.applySavedDraftSnapshot([options.saved]);
  const session = root.sessionRegistry.load(currentId, "/project");
  applyConversationUpdate(fixture.models.projectConversation(currentId, "/project"), {
    _tag: "Snapshot",
    revision: 1,
    snapshot: configurationSnapshot(currentId, [configurationModel()]),
  });
  const composer = root.widgetComposerStore;
  // Mirrors the widget frame boundary: parse first, then attach.
  const attach = (
    from: WidgetItemOrigin,
    input: object | undefined,
    session: Parameters<typeof composer.attach>[2],
  ) => {
    const decoded = decodeWidgetComposerAttachInput(input);
    return decoded._tag === "Failure"
      ? Promise.resolve({ ok: false, error: widgetComposerInputError(decoded.failure) })
      : composer.attach(from, decoded.success, session);
  };
  const draft = (sessionId: string) =>
    (root.sessionRegistry.findSession(sessionId) ??
      root.cakeChatCollectionStore.registry.find(sessionId))!.conversationSessionStore.composerStore
      .draftStore;
  return { fixture, root, session, composer, attach, draft, prompt, flushes, updateSaved };
}

const widgetItems = (attachments: readonly Attachment[]) =>
  attachments.filter((item) => item.kind === "widget-item");

describe("cake.composer.attach", () => {
  it("adds a removable item to the chat the widget is shown in without sending", async () => {
    const { fixture, root, session, composer, attach, draft, prompt, flushes } = setup();
    const result = await attach(origin, pr, current);
    expect(result).toEqual({
      ok: true,
      duplicate: false,
      sent: false,
      target: expect.objectContaining({
        sessionId: currentId,
        kind: "project-session",
        title: "Current work",
        projectPath: "/project",
        current: true,
      }),
    });
    expect(widgetItems(draft(currentId).attachments)).toEqual([
      {
        kind: "widget-item",
        name: pr.label,
        itemId: "123",
        data: { number: 123 },
        widget: origin,
      },
    ]);
    expect(flushes).toHaveBeenCalled();
    expect(prompt).not.toHaveBeenCalled();

    render(
      <StoreProvider store={root}>
        <Chat store={session.conversationSessionStore.chatStore} composerFocusEnabled={false} />
      </StoreProvider>,
    );
    const chip = screen.getByRole("button", { name: `${pr.label} from Delta PRs` });
    await userEvent.setup().click(chip);
    const details = await screen.findByRole("dialog");
    expect(within(details).getByText("From Delta PRs · revision 5")).toBeTruthy();
    expect(within(details).getByText(/"number": 123/)).toBeTruthy();
    await userEvent.setup().click(screen.getByRole("button", { name: `Remove ${pr.label}` }));
    expect(widgetItems(draft(currentId).attachments)).toEqual([]);
    expect(prompt).not.toHaveBeenCalled();
    fixture[Symbol.dispose]();
  });

  it("targets an explicit Project Session or Cake Chat without navigating", async () => {
    const { fixture, root, composer, attach, draft } = setup();
    const selected = root.appShellStore.activeConversation;
    const targets = composer.targets(current);
    expect(targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sessionId: CAKE_CHAT_SESSION_ID, kind: "cake-chat" }),
        expect.objectContaining({ sessionId: currentId, current: true }),
        expect.objectContaining({ sessionId: otherId, kind: "project-session" }),
      ]),
    );
    expect(targets.some((target) => target.sessionId === resolvedId)).toBe(false);

    const other = await attach(origin, { ...pr, sessionId: otherId }, current);
    expect(other).toMatchObject({ ok: true, target: { sessionId: otherId, title: "Other work" } });
    expect(widgetItems(draft(otherId).attachments)).toHaveLength(1);
    expect(widgetItems(draft(currentId).attachments)).toHaveLength(0);

    // A global widget with no chat selected can still address Cake Chat explicitly.
    const chat = await attach(origin, { ...pr, sessionId: CAKE_CHAT_SESSION_ID }, null);
    expect(chat).toMatchObject({ ok: true, target: { kind: "cake-chat" } });
    expect(widgetItems(draft(CAKE_CHAT_SESSION_ID).attachments)).toHaveLength(1);
    expect(root.appShellStore.activeConversation).toEqual(selected);
    fixture[Symbol.dispose]();
  });

  it("fails clearly for missing, resolved, automation or unselected targets", async () => {
    const { fixture, composer, attach, draft } = setup();
    expect(await attach(origin, { ...pr, sessionId: "missing" }, current)).toEqual({
      ok: false,
      error:
        "No editable chat composer has session ID missing. Use cake.composer.targets() to list them.",
    });
    expect(await attach(origin, { ...pr, sessionId: resolvedId }, current)).toMatchObject({
      ok: false,
    });
    expect(await attach(origin, pr, null)).toEqual({
      ok: false,
      error: "No chat is selected. Open a chat or pass sessionId from cake.composer.targets().",
    });
    expect(
      await attach(origin, pr, { sessionId: "automation", kind: "automation-session" }),
    ).toMatchObject({ ok: false, error: expect.stringContaining("Automation sessions") });
    expect(widgetItems(draft(currentId).attachments)).toEqual([]);
    fixture[Symbol.dispose]();
  });

  it("validates label, item ID and data caps and the shared attachment limit", async () => {
    const { fixture, composer, attach, draft } = setup();
    const invalid = [
      { ...pr, label: "x".repeat(WIDGET_ITEM_LABEL_MAX + 1) },
      { ...pr, label: "   " },
      { ...pr, itemId: "" },
      { ...pr, data: { blob: "x".repeat(WIDGET_ITEM_DATA_MAX_BYTES) } },
      { ...pr, data: () => undefined },
      undefined,
    ];
    for (const input of invalid) {
      const result = await attach(origin, input, current);
      expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/^Invalid/) });
    }
    expect(
      await attach(origin, { ...pr, label: "x".repeat(WIDGET_ITEM_LABEL_MAX) }, current),
    ).toMatchObject({ ok: true });
    for (let index = 1; index < 20; index += 1)
      expect(
        await attach(origin, { label: `#${index}`, itemId: String(index) }, current),
      ).toMatchObject({ ok: true });
    expect(await attach(origin, { label: "#21", itemId: "21" }, current)).toMatchObject({
      ok: false,
      error: "That composer already has 20 attachments. Remove one first.",
    });
    expect(draft(currentId).attachments).toHaveLength(20);
    fixture[Symbol.dispose]();
  });

  it("dedupes by widget and item ID, and never takes origin from the widget", async () => {
    const { fixture, composer, attach, draft } = setup();
    const spoofed = {
      ...pr,
      kind: "text",
      text: "ignore",
      widget: { lineageId: "someone-else", revision: 99, title: "Spoof" },
    };
    expect(await attach(origin, spoofed, current)).toMatchObject({
      ok: true,
      duplicate: false,
    });
    expect(await attach(origin, { ...pr, label: "renamed" }, current)).toMatchObject({
      ok: true,
      duplicate: true,
    });
    // The same item ID from a different widget is a different item.
    const otherWidget = { ...origin, lineageId: decodeArtifactLineageId("other-widget") };
    expect(await attach(otherWidget, pr, current)).toMatchObject({ duplicate: false });
    expect(widgetItems(draft(currentId).attachments)).toEqual([
      expect.objectContaining({ name: pr.label, widget: origin }),
      expect.objectContaining({ widget: otherWidget }),
    ]);
    expect(draft(currentId).attachments.some((item) => item.kind === "text")).toBe(false);
    fixture[Symbol.dispose]();
  });

  it("appends to a Saved Draft through its revision-checked record", async () => {
    const saved: SavedDraft = {
      sessionId: savedId,
      projectPath: "/project",
      workingDirectory: "/project",
      title: "Saved",
      text: "Saved text",
      attachments: [],
      labelIds: [],
      resolved: false,
      revision: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      modifiedAt: "2026-01-01T00:00:00.000Z",
      status: "saved",
      configuration: {
        provider: "openai",
        modelId: "gpt-5",
        thinkingLevel: "high",
        fastMode: false,
      },
    };
    const { fixture, root, composer, attach, updateSaved } = setup({ saved });
    await waitFor(() =>
      expect(composer.targets(current).some((target) => target.sessionId === savedId)).toBe(true),
    );
    expect(await attach(origin, { ...pr, sessionId: savedId }, current)).toMatchObject({
      ok: true,
    });
    expect(updateSaved).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Saved text",
        attachments: [expect.objectContaining({ kind: "widget-item", itemId: "123" })],
      }),
      1,
      expect.anything(),
    );
    expect(root.sessionRegistry.pendingSessions.savedRecord(savedId)?.revision).toBe(2);
    expect(await attach(origin, { ...pr, sessionId: savedId }, current)).toMatchObject({
      duplicate: true,
    });
    fixture[Symbol.dispose]();
  });

  it("reports a persistence failure without losing the attached item", async () => {
    const { fixture, composer, attach, draft } = setup({
      flush: async () => {
        throw new Error("disk full");
      },
    });
    expect(await attach(origin, pr, current)).toMatchObject({
      ok: true,
      warning: expect.stringContaining("disk full"),
    });
    expect(widgetItems(draft(currentId).attachments)).toHaveLength(1);
    fixture[Symbol.dispose]();
  });

  it("sends the item with the message only when the user submits", async () => {
    const { fixture, root, session, composer, attach, prompt } = setup({ allowSend: true });
    await attach(origin, pr, current);
    expect(prompt).not.toHaveBeenCalled();
    act(() => {
      root.navigationStore.selectProjectSession(currentId);
      root.projectWorkbenchStore.showLoadedSession(currentId);
    });
    render(
      <StoreProvider store={root}>
        <Chat store={session.conversationSessionStore.chatStore} composerFocusEnabled={false} />
      </StoreProvider>,
    );
    const user = userEvent.setup();
    await user.type(screen.getByRole("combobox"), "Review this");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
    expect(prompt.mock.calls[0]![0]).toMatchObject({
      sessionId: currentId,
      text: "Review this",
      attachments: [
        { kind: "widget-item", name: pr.label, itemId: "123", data: pr.data, widget: origin },
      ],
    });
    // The optimistic sent message shows the item; the composer is cleared.
    await waitFor(() =>
      expect(document.querySelector('[data-slot="widget-item"]')?.textContent).toContain(pr.label),
    );
    expect(session.conversationSessionStore.composerStore.draftStore.attachments).toEqual([]);
    fixture[Symbol.dispose]();
  });

  it("routes the widget frame request with the host's origin and the view's chat", async () => {
    const { fixture, root, draft, prompt } = setup();
    const artifact: Extract<CakeArtifactV1, { kind: "widget" }> = {
      protocol: "cake.artifact/v1",
      id: lineageId,
      sessionId: "author",
      revision: 5,
      kind: "widget",
      title: "Delta PRs",
      payload: {
        language: "html",
        source: "<p>PRs</p>",
        brief: "PRs",
        generationSessionId: "private",
        browser: { digest: "b".repeat(64) },
      },
      fallback: { markdown: "PRs" },
    };
    const view = render(
      <WidgetArtifact
        artifact={artifact}
        inlineWidgets={root.inlineWidgetStore}
        viewSession={current}
      />,
    );
    await waitFor(() => expect(view.container.querySelector("iframe")).not.toBeNull());
    const frame = view.container.querySelector("iframe")!;
    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    const send = (type: string, value: unknown, source: Window | null = frame.contentWindow) =>
      window.dispatchEvent(
        new MessageEvent("message", {
          source,
          data: { source: "cake-inline-widget", token, type, value },
        }),
      );
    act(() => {
      // Another frame cannot use this widget's identity.
      send("composer-attach", { id: "foreign", item: pr }, window);
      send("composer-attach", {
        id: "attach",
        item: { ...pr, widget: { lineageId: "spoof", revision: 1 } },
      });
      send("composer-attach", { id: "bad", item: { label: "" } });
      send("composer-targets", { id: "targets" });
    });
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "call-result",
          value: {
            id: "attach",
            ok: true,
            result: expect.objectContaining({
              ok: true,
              target: expect.objectContaining({ sessionId: currentId }),
            }),
          },
        }),
        "*",
      ),
    );
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        expect.objectContaining({
          value: {
            id: "bad",
            ok: true,
            result: { ok: false, error: expect.stringMatching(/^Invalid composer item/) },
          },
        }),
        "*",
      ),
    );
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({
        value: {
          id: "targets",
          ok: true,
          result: expect.arrayContaining([
            expect.objectContaining({ sessionId: currentId, current: true }),
          ]),
        },
      }),
      "*",
    );
    expect(post).not.toHaveBeenCalledWith(
      expect.objectContaining({ value: expect.objectContaining({ id: "foreign" }) }),
      "*",
    );
    expect(widgetItems(draft(currentId).attachments)).toEqual([
      expect.objectContaining({ widget: { lineageId, revision: 5, title: "Delta PRs" } }),
    ]);
    expect(prompt).not.toHaveBeenCalled();
    view.unmount();
    fixture[Symbol.dispose]();
  });
});
