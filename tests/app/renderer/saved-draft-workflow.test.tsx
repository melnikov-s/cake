/** @vitest-environment jsdom */
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import { renderTranscriptContent as render } from "./render-transcript-content";
import userEvent from "@testing-library/user-event";
import { applySnapshot } from "r-state-tree";
import { observer } from "r-state-tree/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SavedDraft } from "../../../src/contracts/project-sessions/saved-draft-data";
import { TurnId } from "../../../src/contracts/conversations/conversation-data";
import type { WorktreeRecord } from "../../../src/contracts/worktrees/managed-worktree-data";
import type { Attachment } from "../../../src/contracts/conversations/session-contract";
import type { Client } from "../../../src/renderer/client/Client";
import { Chat } from "../../../src/renderer/components/chat";
import { SidebarProjectGroup } from "../../../src/renderer/components/sidebar-project-group";
import { WorktreePill } from "../../../src/renderer/components/worktree-pill";
import { SavedDraftRecovery } from "../../../src/renderer/components/saved-draft-recovery";
import { fakeSavedDrafts } from "./fakes/saved-drafts";
import { configurationModel } from "./chat-configuration-workflow-fixture";
import {
  fixtureTimestamp,
  projectRecord,
  sessionSummary,
  type SessionSummaryFixture,
} from "./fixtures/catalog-fixtures";
import { applySessionCatalogGroupUpdate } from "../../../src/renderer/reducers/CatalogReducer";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import type { TestClientOverrides } from "./test-client";

const projectPath = "/project";
const sessionId = "10000000-0000-4000-8000-000000000001";
const labelId = "10000000-0000-4000-8000-000000000002";
const attachment = {
  kind: "text",
  name: "Pasted text · 51 lines",
  text: "plan details\n".repeat(50),
} satisfies Attachment;
function savedDraft(overrides: Partial<SavedDraft> = {}): SavedDraft {
  return {
    sessionId,
    projectPath,
    workingDirectory: projectPath,
    title: "Planned work",
    text: "Implement the plan",
    attachments: [],
    labelIds: [],
    resolved: false,
    createdAt: fixtureTimestamp,
    modifiedAt: fixtureTimestamp,
    revision: 1,
    status: "saved",
    ...overrides,
  };
}
function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Value>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}
async function renderDrafts(
  drafts = fakeSavedDrafts(),
  client: TestClientOverrides = {},
  initialSessions: SessionSummaryFixture[] = [],
) {
  const fixture = createRendererStoreFixture({
    projects: [
      projectRecord({
        path: projectPath,
        name: "Project",
        workflow: {
          labels: [{ id: labelId, name: "Feature", color: "blue" }],
          assignments: [],
          sessionDetails: [],
        },
      }),
    ],
    sessions: initialSessions,
    client: {
      ...client,
      savedDrafts: { ...drafts.client, ...client.savedDrafts },
      workspaces: {
        loadStagedSlashCommands: async () => [],
        generateSessionTitle: async () => undefined,
        ...client.workspaces,
      },
      managedWorktrees: { landing: async () => ({}), ...client.managedWorktrees },
    },
  });
  await fixture.root.sessionRegistry.pendingSessions.refreshSavedDrafts();
  if (!drafts.records.has(sessionId))
    fixture.root.sessionRegistry.pendingSessions.prepareStaged(projectPath, sessionId);
  fixture.root.sessionLayoutStore.ensureSession(sessionId);
  fixture.root.navigationStore.selectProjectSession(sessionId);
  fixture.root.projectWorkbenchStore.showLoadedSession(sessionId);
  const { root } = fixture;
  root.sessionRegistry
    .findSession(sessionId)!
    .conversationSessionStore.chatStore.transcriptInteraction.setTranscriptScrollPosition({
      kind: "top",
    });
  const Surface = observer(function Surface() {
    const session = root.sessionRegistry.findSession(sessionId);
    if (!session) throw new Error("Missing draft session");
    const conversation = session.conversationSessionStore;
    const chat = conversation.chatStore;
    const error = root.projectWorkbenchStore.contextError(sessionId);
    const composerError = conversation.composerStore.error;
    const temporary = root.sessionRegistry.pendingSessions.isTemporary(sessionId);
    return (
      <>
        <aside>
          {[false, true].map((resolved) => (
            <SidebarProjectGroup
              cakeChat={root.cakeChatCollectionStore}
              onOpenCakeChat={(sessionId) => void root.navigationStore.openCakeChat(sessionId)}
              key={String(resolved)}
              store={root.sidebarStore}
              sessionList={root.sidebarStore.sessionListStore}
              sessionMetadata={root.sessionMetadataStore}
              projects={root.projectCatalogStore}
              chat={root.projectWorkbenchStore}
              shell={root.appShellStore}
              appearance={root.settingsStore.appearance}
              path={projectPath}
              resolved={resolved}
              flattenSessions
              onCreateSession={(path) => void root.navigationStore.createSession(path)}
              onOpenSession={(id) => void root.navigationStore.openSession(id)}
              onRemoveProject={(path, deleteSessions) =>
                root.projectRemovalStore.remove(path, deleteSessions)
              }
              onOpenSettings={(path) => root.projectSettingsStore.open(path)}
            />
          ))}
        </aside>
        <Chat
          store={chat}
          compact
          embedded
          composerFocusEnabled={false}
          error={error ?? (composerError ? { message: composerError } : undefined)}
          composerHeader={
            <>
              {root.sessionRegistry.pendingSessions.savedRecord(sessionId)?.status ===
                "activating" && (
                <SavedDraftRecovery
                  disabled={false}
                  recover={() =>
                    void root.sessionRegistry.pendingSessions.recoverUncertain(sessionId)
                  }
                />
              )}
              <WorktreePill
                creation={root.projectSessionCreationStore.worktrees}
                actions={session.worktreeStore}
                sessionId={sessionId}
                projectPath={projectPath}
                record={root.sessionCatalogStore.managedWorktree(session.workspacePath)}
                configurationMode={
                  chat.isDraftSession
                    ? chat.editingMessage
                      ? "edit-draft"
                      : "activate-draft"
                    : temporary
                      ? "new-session"
                      : undefined
                }
                onConfigured={() => conversation.composerStore.draftStore.requestFocus()}
              />
            </>
          }
        />
      </>
    );
  });
  const view = render(<Surface />);
  return {
    user: userEvent.setup(),
    async refreshDrafts() {
      await act(async () => fixture.root.sessionRegistry.pendingSessions.refreshSavedDrafts());
    },
    async publishDrafts(records: SavedDraft[]) {
      await act(async () =>
        fixture.root.sessionRegistry.pendingSessions.applySavedDraftSnapshot(records),
      );
    },
    publishTitle(title: string) {
      // This is the live-title authority delivery used by the renderer Model observer.
      act(() => {
        applySessionCatalogGroupUpdate(
          fixture.models.sessionCatalog,
          { projectPath, resolved: false },
          { _tag: "Event", revision: 1, event: { _tag: "TitleChanged", sessionId, title } },
        );
        fixture.root.sessionRegistry.pendingSessions.applyLiveTitle(sessionId, title);
      });
    },
    publishCatalog(title: string, modifiedAt = fixtureTimestamp) {
      act(() =>
        applySessionCatalogGroupUpdate(
          fixture.models.sessionCatalog,
          { projectPath, resolved: false },
          {
            _tag: "Snapshot",
            revision: 1,
            sessions: [
              ...initialSessions,
              sessionSummary({ sessionId, projectPath, title, messageCount: 1, modifiedAt }),
            ],
          },
        ),
      );
    },
    async publishWorktree(record: WorktreeRecord) {
      await act(async () => applySnapshot(fixture.models.worktrees, { worktrees: [record] }));
    },
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}
function sidebar() {
  return within(screen.getByRole("complementary"));
}
function input() {
  return screen.getByRole("combobox", { name: "Message" });
}
beforeEach(() => vi.stubGlobal("PointerEvent", MouseEvent));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Saved Draft workflows", () => {
  it("persists a saved model change through refresh and activation without changing other saved facts", async () => {
    const drafts = fakeSavedDrafts();
    const original = savedDraft({ attachments: [attachment], labelIds: [labelId] });
    drafts.records.set(sessionId, original);
    const update = vi.fn(drafts.client.update);
    const activate = vi.fn(drafts.client.activate);
    const configuration = {
      provider: "openai",
      modelId: "gpt-5",
      thinkingLevel: "high",
      fastMode: false,
    } as const;
    using fixture = await renderDrafts(drafts, {
      savedDrafts: { update, activate },
      models: { list: async () => [configurationModel()] },
    });
    const picker = () => screen.getByRole("button", { name: "Model configuration" });
    await fixture.user.click(picker());
    await fixture.user.click(await screen.findByRole("button", { name: "GPT-5 gpt-5" }));
    await fixture.user.click(screen.getByRole("button", { name: "High" }));
    await fixture.user.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(update).toHaveBeenCalledOnce());
    expect(drafts.records.get(sessionId)).toEqual({ ...original, configuration, revision: 2 });
    await fixture.refreshDrafts();
    expect(picker().textContent).toContain("GPT-5");
    expect(picker().textContent).toContain("High");
    expect(sidebar().getByText(original.title)).toBeDefined();
    expect(screen.getByText(original.text)).toBeDefined();
    expect(screen.getByText(attachment.name, { exact: false })).toBeDefined();
    expect(sidebar().getByRole("img", { name: "Labels: Feature" })).toBeDefined();
    await fixture.user.click(screen.getByRole("button", { name: "Activate draft" }));
    await waitFor(() => expect(activate).toHaveBeenCalledOnce());
    expect(activate).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId, expectedRevision: 2 }),
      expect.anything(),
    );
    expect(drafts.records.get(sessionId)).toMatchObject({
      configuration,
      title: original.title,
      text: original.text,
      attachments: [attachment],
      labelIds: original.labelIds,
      status: "activated",
    });
  });

  it("reports a rejected saved model change, refreshes authority, and allows retry", async () => {
    const drafts = fakeSavedDrafts();
    drafts.records.set(sessionId, savedDraft());
    const update = vi
      .fn(drafts.client.update)
      .mockRejectedValueOnce(new Error("Model save failed"));
    using fixture = await renderDrafts(drafts, {
      savedDrafts: { update },
      models: { list: async () => [configurationModel()] },
    });
    const choose = async () => {
      await fixture.user.click(screen.getByRole("button", { name: "Model configuration" }));
      await fixture.user.click(await screen.findByRole("button", { name: "GPT-5 gpt-5" }));
      await fixture.user.click(screen.getByRole("button", { name: "Apply" }));
    };
    await choose();
    await screen.findByText("Model save failed");
    expect(drafts.records.get(sessionId)?.configuration).toBeUndefined();
    await choose();
    await waitFor(() =>
      expect(drafts.records.get(sessionId)?.configuration?.modelId).toBe("gpt-5"),
    );
    await fixture.refreshDrafts();
    expect(screen.queryByText("Model save failed")).toBeNull();
  });

  it("persists an automatic draft title and restores it in a fresh window", async () => {
    const drafts = fakeSavedDrafts();
    const generated = deferred<string>();
    const generate = vi.fn<Client["workspaces"]["generateSessionTitle"]>(() => generated.promise);
    const update = vi.fn(drafts.client.update);
    {
      using fixture = await renderDrafts(drafts, {
        savedDrafts: { update },
        workspaces: { generateSessionTitle: generate },
      });
      await fixture.user.click(screen.getByRole("button", { name: "Draft" }));
      await fixture.user.type(input(), "Investigate draft naming");
      await fixture.user.click(screen.getByRole("button", { name: "Create draft" }));
      await screen.findByRole("button", { name: "Activate draft" });
      await waitFor(() => expect(generate).toHaveBeenCalledOnce());
      await act(async () => generated.resolve("Fix draft titles"));
      expect(await sidebar().findByText("Fix draft titles")).toBeDefined();
      expect(drafts.records.get(sessionId)).toMatchObject({
        title: "Fix draft titles",
        revision: 2,
      });
      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId, title: "Fix draft titles" }),
        1,
        expect.anything(),
      );
    }
    using restored = await renderDrafts(drafts);
    expect(sidebar().getByText("Fix draft titles")).toBeDefined();
    await restored.user.click(screen.getByRole("button", { name: "Activate draft" }));
    await waitFor(() =>
      expect(drafts.records.get(sessionId)).toMatchObject({
        title: "Fix draft titles",
        status: "activated",
      }),
    );
  });

  it("preserves a name explicitly entered before saving a draft", async () => {
    const drafts = fakeSavedDrafts();
    const generate = vi.fn<Client["workspaces"]["generateSessionTitle"]>(
      async () => "Unwanted title",
    );
    using fixture = await renderDrafts(drafts, {
      workspaces: { generateSessionTitle: generate },
    });
    await fixture.user.type(input(), "/name My explicit name{Enter}");
    await waitFor(() => expect(input()).toHaveProperty("value", ""));
    await fixture.user.click(screen.getByRole("button", { name: "Draft" }));
    await fixture.user.type(input(), "Investigate draft naming");
    await fixture.user.click(screen.getByRole("button", { name: "Create draft" }));
    await screen.findByRole("button", { name: "Activate draft" });
    expect(sidebar().getByText("My explicit name")).toBeDefined();
    expect(drafts.records.get(sessionId)).toMatchObject({ title: "My explicit name", revision: 1 });
    expect(generate).not.toHaveBeenCalled();
  });

  it.each(["manual rename", "remote rename", "prompt edit", "activation"])(
    "discards an automatic draft title after %s",
    async (change) => {
      const drafts = fakeSavedDrafts();
      const generated = deferred<string>();
      const generate = vi.fn<Client["workspaces"]["generateSessionTitle"]>(() => generated.promise);
      using fixture = await renderDrafts(drafts, {
        workspaces: { generateSessionTitle: generate },
        electron: { showSessionContextMenu: async () => ({ action: "rename" }) },
      });
      await fixture.user.click(screen.getByRole("button", { name: "Draft" }));
      await fixture.user.type(input(), "Investigate draft naming");
      await fixture.user.click(screen.getByRole("button", { name: "Create draft" }));
      await screen.findByRole("button", { name: "Activate draft" });
      await waitFor(() => expect(generate).toHaveBeenCalledOnce());
      if (change === "manual rename") {
        await fixture.user.pointer({
          target: sidebar().getByText("New chat"),
          keys: "[MouseRight]",
        });
        const name = await screen.findByRole("textbox", { name: "Session name" });
        await fixture.user.clear(name);
        await fixture.user.type(name, "My explicit name{Enter}");
        await sidebar().findByText("My explicit name");
      } else if (change === "remote rename") {
        // The authority changed before its pushed snapshot reached this window.
        const current = drafts.records.get(sessionId)!;
        drafts.records.set(sessionId, {
          ...current,
          title: "Named in another window",
          revision: 2,
        });
      } else if (change === "prompt edit") {
        await fixture.user.click(screen.getByRole("button", { name: "Edit latest prompt" }));
        await fixture.user.clear(input());
        await fixture.user.type(input(), "A different task");
        await fixture.user.click(screen.getByRole("button", { name: "Save draft" }));
        await screen.findByText("A different task");
      } else {
        await fixture.user.click(screen.getByRole("button", { name: "Activate draft" }));
        await waitFor(() => expect(drafts.records.get(sessionId)?.status).toBe("activated"));
      }
      const record = drafts.records.get(sessionId);
      await act(async () => generated.resolve("Unwanted title"));
      expect(drafts.records.get(sessionId)).toEqual(record);
      expect(sidebar().queryByText("Unwanted title")).toBeNull();
      if (change === "remote rename")
        expect(await sidebar().findByText("Named in another window")).toBeDefined();
    },
  );

  it("keeps a draft saved when automatic naming fails", async () => {
    const drafts = fakeSavedDrafts();
    const generated = deferred<string>();
    using fixture = await renderDrafts(drafts, {
      workspaces: { generateSessionTitle: () => generated.promise },
    });
    await fixture.user.click(screen.getByRole("button", { name: "Draft" }));
    await fixture.user.type(input(), "Investigate draft naming");
    await fixture.user.click(screen.getByRole("button", { name: "Create draft" }));
    await screen.findByRole("button", { name: "Activate draft" });
    await act(async () => generated.reject(new Error("Naming failed")));
    expect(drafts.records.get(sessionId)).toMatchObject({ status: "saved", revision: 1 });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps one selected sidebar identity through activation and catalog takeover in a full session list", async () => {
    const drafts = fakeSavedDrafts();
    const title = "Duplicate title";
    drafts.records.set(sessionId, savedDraft({ title }));
    const otherId = "10000000-0000-4000-8000-000000000003";
    drafts.records.set(otherId, savedDraft({ sessionId: otherId, title }));
    const start = vi.fn<Client["projectSessions"]["start"]>();
    const activate = vi.fn(drafts.client.activate);
    using fixture = await renderDrafts(
      drafts,
      { savedDrafts: { activate }, projectSessions: { start } },
      Array.from({ length: 10 }, (_, index) =>
        sessionSummary({
          sessionId: `recent-${index}`,
          projectPath,
          title: `Recent Pi session ${index}`,
          // Real lightweight Pi entries need not have inspected messages.
          messageCount: 0,
          modifiedAt: "2026-02-01T00:00:00.000Z",
        }),
      ),
    );
    const rows = () => sidebar().getAllByRole("button", { name: /^Duplicate title / });
    const rowIds = () =>
      rows().map((row) => row.closest("[data-session-id]")?.getAttribute("data-session-id"));
    expect(rowIds().sort()).toEqual([sessionId, otherId]);
    const held = drafts.holdActivation();
    await fixture.user.click(screen.getByRole("button", { name: "Activate draft" }));
    const claimed = await held.claimed;
    await fixture.publishDrafts([claimed, drafts.records.get(otherId)!]);
    expect(rowIds().sort()).toEqual([sessionId, otherId]);
    expect(screen.getByText(/This saved Draft may already have started/)).toBeDefined();

    // The first Pi message is newer than the existing sessions. Its catalog can
    // arrive before activation returns, replacing the draft without duplication
    // or losing its visible selected row when it joins the normal recency lane.
    fixture.publishCatalog(title, "2026-02-02T00:00:00.000Z");
    expect(rowIds().sort()).toEqual([sessionId, otherId]);
    await act(async () => held.release());
    await waitFor(() => expect(input()).toBeDefined());
    expect(rowIds().sort()).toEqual([sessionId, otherId]);
    const selected = rows().find(
      (row) => row.closest("[data-session-id]")?.getAttribute("data-session-id") === sessionId,
    );
    expect(selected?.textContent).not.toContain("Draft");
    expect(activate).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ sessionId, expectedRevision: 1 }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(start).not.toHaveBeenCalled();
  });

  it("saves an attachment-only draft, restores it in a fresh window, and activates the same identity", async () => {
    const drafts = fakeSavedDrafts();
    const create = vi.fn(drafts.client.create);
    const activate = vi.fn(drafts.client.activate);
    const start = vi.fn<Client["projectSessions"]["start"]>();
    {
      using fixture = await renderDrafts(drafts, {
        savedDrafts: { create, activate },
        projectSessions: { start },
      });
      await fixture.user.click(screen.getByRole("button", { name: "Draft" }));
      await fixture.user.click(input());
      await fixture.user.paste(attachment.text);
      expect(await screen.findByRole("button", { name: /^Pasted text/ })).toBeDefined();
      await fixture.user.click(screen.getByRole("button", { name: "Create draft" }));
      await screen.findByRole("button", { name: "Activate draft" });
      expect(sidebar().getByText("Draft", { exact: true })).toBeDefined();
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId, text: "", attachments: [attachment] }),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(start).not.toHaveBeenCalled();
    }
    using restored = await renderDrafts(drafts, { savedDrafts: { activate } });
    expect(await screen.findByText(attachment.name, { exact: false })).toBeDefined();
    expect(screen.queryByRole("combobox", { name: "Message" })).toBeNull();
    await restored.user.click(screen.getByRole("button", { name: "Activate draft" }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Activate draft" })).toBeNull(),
    );
    expect(activate).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId, expectedRevision: 1 }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(drafts.records.get(sessionId)).toMatchObject({
      status: "activated",
      attachments: [attachment],
    });
    expect(input()).toBeDefined();
  });

  it("edits a saved prompt as Markdown source, renders it, and activates the saved revision without losing source", async () => {
    const drafts = fakeSavedDrafts();
    drafts.records.set(sessionId, savedDraft());
    const update = vi.fn(drafts.client.update);
    const activate = vi.fn(drafts.client.activate);
    using fixture = await renderDrafts(drafts, { savedDrafts: { update, activate } });
    expect(await screen.findByText("Implement the plan")).toBeDefined();
    await fixture.user.click(screen.getByRole("button", { name: "Edit latest prompt" }));
    expect(input()).toHaveProperty("value", "Implement the plan");
    await fixture.user.clear(input());
    await fixture.user.type(input(), "# Revised implementation plan");
    await fixture.user.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(update).toHaveBeenCalledOnce());
    await screen.findByRole("heading", { name: "Revised implementation plan" });
    expect(update).toHaveBeenLastCalledWith(
      expect.objectContaining({ sessionId, text: "# Revised implementation plan" }),
      1,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(drafts.records.get(sessionId)).toMatchObject({
      text: "# Revised implementation plan",
      revision: 2,
    });
    await fixture.user.click(screen.getByRole("button", { name: "Activate draft" }));
    await waitFor(() =>
      expect(activate).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId, expectedRevision: 2 }),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );
    expect(drafts.records.get(sessionId)).toMatchObject({
      text: "# Revised implementation plan",
      status: "activated",
    });
    expect(input()).toBeDefined();
  });

  it("refreshes a conflicting saved-draft rename, then renames and resolves using current revisions", async () => {
    const drafts = fakeSavedDrafts();
    drafts.records.set(sessionId, savedDraft());
    const update = vi.fn(drafts.client.update);
    const menu = vi.fn<Client["electron"]["showSessionContextMenu"]>(async () => ({
      action: "rename",
    }));
    using fixture = await renderDrafts(drafts, {
      savedDrafts: { update },
      electron: { showSessionContextMenu: menu },
    });
    // Another window commits revision 2 before this window's command reaches the authority.
    drafts.records.set(sessionId, savedDraft({ title: "Changed remotely", revision: 2 }));
    await fixture.user.pointer({
      target: sidebar().getByText("Planned work"),
      keys: "[MouseRight]",
    });
    const name = await screen.findByRole("textbox", { name: "Session name" });
    await fixture.user.clear(name);
    await fixture.user.type(name, "Local name{Enter}");
    await sidebar().findByText("Changed remotely");
    await screen.findByText("Saved Draft revision conflict (update)");
    expect(drafts.records.get(sessionId)?.title).toBe("Changed remotely");
    await fixture.user.pointer({
      target: sidebar().getByText("Changed remotely"),
      keys: "[MouseRight]",
    });
    const retry = await screen.findByRole("textbox", { name: "Session name" });
    await fixture.user.clear(retry);
    await fixture.user.type(retry, "Final name{Enter}");
    await sidebar().findByText("Final name");
    expect(update).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: "Final name" }),
      2,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    await fixture.user.click(sidebar().getByRole("button", { name: "Resolve Final name" }));
    await sidebar().findByRole("button", { name: "Restore Final name" });
    expect(drafts.records.get(sessionId)).toMatchObject({
      title: "Final name",
      resolved: true,
      revision: 4,
    });
    expect(update).toHaveBeenLastCalledWith(
      expect.objectContaining({ resolved: true }),
      3,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("projects canonical saved title, prompt, attachments and labels without reverting to a stale snapshot", async () => {
    const drafts = fakeSavedDrafts();
    drafts.records.set(sessionId, savedDraft());
    using fixture = await renderDrafts(drafts);
    const newer = savedDraft({
      title: "Renamed in another window",
      text: "Updated in another window",
      attachments: [attachment],
      labelIds: [labelId],
      revision: 2,
    });
    drafts.records.set(sessionId, newer);
    await fixture.publishDrafts([newer]);
    expect(screen.getByText(newer.text)).toBeDefined();
    await fixture.publishDrafts([savedDraft()]);
    expect(screen.getByText(newer.text)).toBeDefined();
    expect(sidebar().getByText(newer.title)).toBeDefined();
    expect(sidebar().getByRole("img", { name: "Labels: Feature" })).toBeDefined();
    expect(screen.getByText(attachment.name, { exact: false })).toBeDefined();
  });

  it("adopts another window's activated Working Directory without changing session identity", async () => {
    const drafts = fakeSavedDrafts();
    drafts.records.set(sessionId, savedDraft());
    const activate = vi.fn(drafts.client.activate);
    const menu = vi.fn<Client["electron"]["showSessionContextMenu"]>(async () => undefined);
    using fixture = await renderDrafts(drafts, {
      savedDrafts: { activate },
      electron: { showSessionContextMenu: menu },
    });
    const record: WorktreeRecord = {
      projectPath,
      worktreePath: "/worktrees/shared-task",
      branch: "agent/shared-task",
      baseBranch: "main",
      state: "active",
      createdAt: fixtureTimestamp,
    };
    await fixture.publishWorktree(record);
    const activated = {
      ...savedDraft(),
      status: "activated" as const,
      revision: 4,
      workingDirectory: record.worktreePath,
    };
    drafts.records.set(sessionId, activated);
    await fixture.publishDrafts([activated]);
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Activate draft" })).toBeNull(),
    );
    expect(screen.getAllByText("shared-task").length).toBeGreaterThan(0);
    expect(sidebar().getByText("Planned work")).toBeDefined();
    expect(sidebar().queryByText("Draft", { exact: true })).toBeNull();
    expect(input()).toBeDefined();
    expect(activate).not.toHaveBeenCalled();
    await fixture.user.pointer({
      target: sidebar().getByText("Planned work"),
      keys: "[MouseRight]",
    });
    await waitFor(() =>
      expect(menu).toHaveBeenCalledWith(expect.objectContaining({ sessionId, draft: false })),
    );
  });

  it("requires an explicit recovery decision for an uncertain activation and prevents duplicate activation while claimed", async () => {
    const drafts = fakeSavedDrafts();
    drafts.records.set(sessionId, savedDraft({ status: "activating", revision: 2 }));
    const recoverUncertain = vi.fn(drafts.client.recoverUncertain);
    const activate = vi.fn(drafts.client.activate);
    using fixture = await renderDrafts(drafts, { savedDrafts: { recoverUncertain, activate } });
    expect(screen.getByText(/This saved Draft may already have started/)).toBeDefined();
    expect(activate).not.toHaveBeenCalled();
    await fixture.user.click(
      screen.getByRole("button", { name: "I checked — no turn was accepted" }),
    );
    await screen.findByRole("button", { name: "Activate draft" });
    expect(recoverUncertain).toHaveBeenCalledWith(
      sessionId,
      2,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(screen.queryByText(/This saved Draft may already have started/)).toBeNull();
    const held = drafts.holdActivation();
    await fixture.user.click(screen.getByRole("button", { name: "Activate draft" }));
    const claimed = await held.claimed;
    await fixture.publishDrafts([claimed]);
    expect(screen.queryByRole("button", { name: "Activate draft" })).toBeNull();
    expect(screen.getByText(/This saved Draft may already have started/)).toBeDefined();
    expect(activate).toHaveBeenCalledOnce();
    await act(async () => held.release());
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Activate draft" })).toBeNull(),
    );
    expect(drafts.records.get(sessionId)).toMatchObject({ revision: 5, status: "activated" });
    expect(input()).toBeDefined();
  });

  it.each([false, true])(
    "delivers a title after startup succeeds (catalog registered: %s)",
    async (cataloged) => {
      const generated = deferred<string>();
      const generate = vi.fn<Client["workspaces"]["generateSessionTitle"]>(() => generated.promise);
      const start = vi.fn<Client["projectSessions"]["start"]>(async () =>
        TurnId.make("10000000-0000-4000-8000-000000000002"),
      );
      const rename = vi.fn<Client["projectSessions"]["rename"]>(async ({ name }) => {
        await fixture.publishTitle(name);
      });
      using fixture = await renderDrafts(fakeSavedDrafts(), {
        projectSessions: { start, rename },
        workspaces: { generateSessionTitle: generate },
      });
      await fixture.user.type(input(), "Investigate naming");
      await fixture.user.click(screen.getByRole("button", { name: "Send" }));
      await waitFor(() => expect(start).toHaveBeenCalledOnce());
      expect(start).toHaveBeenCalledWith(
        expect.objectContaining({ automaticTitle: false }),
        expect.anything(),
      );
      if (cataloged) await fixture.publishCatalog("Investigate naming");
      expect(sidebar().getByText("Investigate naming")).toBeDefined();
      await act(async () => generated.resolve("Generated title"));
      expect(await sidebar().findByText("Generated title")).toBeDefined();
      expect(generate).toHaveBeenCalledOnce();
      expect(rename).toHaveBeenCalledWith(
        { sessionId, name: "Generated title", onlyIfUnnamed: true },
        expect.anything(),
      );
    },
  );

  it("starts naming alongside checkout preparation and shows the result before session startup", async () => {
    const checkout = deferred<WorktreeRecord>();
    const generated = deferred<string>();
    const generate = vi.fn<Client["workspaces"]["generateSessionTitle"]>(() => generated.promise);
    const create = vi.fn<Client["managedWorktrees"]["create"]>(() => checkout.promise);
    const start = vi.fn<Client["projectSessions"]["start"]>(async () =>
      TurnId.make("10000000-0000-4000-8000-000000000002"),
    );
    const rename = vi.fn<Client["projectSessions"]["rename"]>(async ({ name }) =>
      fixture.publishTitle(name),
    );
    using fixture = await renderDrafts(fakeSavedDrafts(), {
      projectSessions: { start, rename },
      managedWorktrees: { create },
      workspaces: { generateSessionTitle: generate },
    });
    await fixture.user.click(screen.getByRole("button", { name: "New worktree" }));
    await fixture.user.type(input(), "Investigate naming");
    await fixture.user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(generate).toHaveBeenCalledOnce();
    expect(start).not.toHaveBeenCalled();
    await act(async () => generated.resolve("Generated title"));
    expect(sidebar().getByText("Generated title")).toBeDefined();
    expect(rename).not.toHaveBeenCalled();
    await act(async () =>
      checkout.resolve({
        projectPath,
        worktreePath: "/worktrees/naming",
        branch: "agent/naming",
        baseBranch: "main",
        state: "active",
        createdAt: fixtureTimestamp,
      }),
    );
    await waitFor(() => expect(start).toHaveBeenCalledOnce());
    await waitFor(() => expect(rename).toHaveBeenCalledOnce());
    expect(sidebar().getByText("Generated title")).toBeDefined();
  });

  it.each([false, true])(
    "preserves a manual rename while naming runs (startup accepted: %s)",
    async (accepted) => {
      const pending = deferred<Awaited<ReturnType<Client["projectSessions"]["start"]>>>();
      const generated = deferred<string>();
      let committedName: string | undefined;
      const start = vi.fn<Client["projectSessions"]["start"]>(() => pending.promise);
      const rename = vi.fn<Client["projectSessions"]["rename"]>(async ({ name, onlyIfUnnamed }) => {
        if (onlyIfUnnamed && committedName) return;
        committedName = name;
        await fixture.publishTitle(name);
      });
      using fixture = await renderDrafts(fakeSavedDrafts(), {
        projectSessions: { start, rename },
        workspaces: { generateSessionTitle: () => generated.promise },
        electron: { showSessionContextMenu: async () => ({ action: "rename" }) },
      });
      await fixture.user.type(input(), "Investigate naming");
      await fixture.user.click(screen.getByRole("button", { name: "Send" }));
      await waitFor(() => expect(start).toHaveBeenCalledOnce());
      if (accepted)
        await act(async () => pending.resolve(TurnId.make("10000000-0000-4000-8000-000000000002")));
      await fixture.user.pointer({
        target: sidebar().getByText("Investigate naming"),
        keys: "[MouseRight]",
      });
      const name = await screen.findByRole("textbox", { name: "Session name" });
      await fixture.user.clear(name);
      await fixture.user.type(name, "My explicit name{Enter}");
      expect(sidebar().getByText("My explicit name")).toBeDefined();
      await act(async () => generated.resolve("Unwanted title"));
      if (!accepted)
        await act(async () => pending.resolve(TurnId.make("10000000-0000-4000-8000-000000000002")));
      await waitFor(() => expect(committedName).toBe("My explicit name"));
      await waitFor(() =>
        expect(rename).toHaveBeenCalledWith(
          { sessionId, name: "Unwanted title", onlyIfUnnamed: true },
          expect.anything(),
        ),
      );
      expect(sidebar().getByText("My explicit name")).toBeDefined();
    },
  );

  it("starts the conversation even when naming fails", async () => {
    const generated = deferred<string>();
    const start = vi.fn<Client["projectSessions"]["start"]>(async () =>
      TurnId.make("10000000-0000-4000-8000-000000000002"),
    );
    const rename = vi.fn<Client["projectSessions"]["rename"]>();
    using fixture = await renderDrafts(fakeSavedDrafts(), {
      projectSessions: { start, rename },
      workspaces: { generateSessionTitle: () => generated.promise },
    });
    await fixture.user.type(input(), "Investigate naming");
    await fixture.user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(start).toHaveBeenCalledOnce());
    await act(async () => generated.reject(new Error("Naming exhausted its retry")));
    expect(sidebar().getByText("Investigate naming")).toBeDefined();
    expect(rename).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
