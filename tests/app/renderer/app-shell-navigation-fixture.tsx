import { act, render, screen, waitFor, within } from "@testing-library/react";
import { expect } from "vitest";
import { isMacPlatform } from "../../../src/renderer/lib/platform";
import userEvent from "@testing-library/user-event";
import { VirtuosoMockContext } from "react-virtuoso";
import { applySnapshot, type StoreSnapshot } from "r-state-tree";
import { StoreProvider } from "r-state-tree/react";
import { defaultApplicationState } from "../../../src/contracts/application/application-data";
import { CAKE_CHAT_SESSION_ID } from "../../../src/contracts/cake-chats/cake-chat-identity";
import type { ConversationSnapshot } from "../../../src/contracts/conversations/conversation-data";
import { App } from "../../../src/renderer/components/app";
import { applyConversationUpdate } from "../../../src/renderer/reducers/ConversationReducer";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import type { TestClientOverrides } from "./test-client";

function snapshot(sessionId: string): ConversationSnapshot {
  return {
    sessionId,
    sessionFile: `/sessions/${sessionId}.jsonl`,
    parts: [],
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

export function renderAppShellNavigation(
  client: TestClientOverrides = {},
  options: {
    snapshot?: StoreSnapshot;
    resolvedIds?: readonly string[];
    history?: readonly string[];
    unhydratedIds?: readonly string[];
    transcriptViewport?: boolean;
    cakeChatCatalogLoaded?: boolean;
  } = {},
) {
  let sessions = ["alpha", "beta", "gamma"].map((name) =>
    sessionSummary({
      sessionId: name,
      title: `${name} conversation`,
      projectPath: `/${name}`,
      resolved: options.resolvedIds?.includes(name) ?? false,
    }),
  );
  const fixture = createRendererStoreFixture({
    snapshot: options.snapshot,
    projects: sessions.map((session) => projectRecord({ path: session.projectPath })),
    sessions,
    client: {
      ...client,
      projectSessions: { open: async () => undefined, ...client.projectSessions },
      cakeChats: { open: async () => undefined, ...client.cakeChats },
      artifacts: {
        catalog: async (request) => ({
          offset: request.offset ?? 0,
          limit: request.limit ?? 50,
          items: [],
          total: 0,
          hasMore: false,
        }),
        ...client.artifacts,
      },
      workspaces: {
        inspect: async (request) => ({ ...request }),
        registerProject: async () => defaultApplicationState(),
        loadStagedSlashCommands: async () => [],
        ...client.workspaces,
      },
    },
  });
  // Loaded authority snapshots make history navigation independent of hydration timing.
  for (const summary of sessions) {
    fixture.root.sessionRegistry.load(summary.sessionId, summary.workingDirectory);
    if (options.unhydratedIds?.includes(summary.sessionId)) continue;
    applyConversationUpdate(
      fixture.models.projectConversation(summary.sessionId, summary.workingDirectory),
      { _tag: "Snapshot", revision: 1, snapshot: snapshot(summary.sessionId) },
    );
  }
  applySnapshot(fixture.models.cakeChatCatalog, {
    loaded: options.cakeChatCatalogLoaded ?? true,
    sessions: [
      {
        sessionId: CAKE_CHAT_SESSION_ID,
        title: "Cake Chat",
        createdAt: sessions[0]!.createdAt,
        modifiedAt: sessions[0]!.modifiedAt,
        messageCount: 0,
        resolved: false,
        unread: false,
      },
    ],
  });
  fixture.root.cakeChatCollectionStore.registry.load(CAKE_CHAT_SESSION_ID);
  applyConversationUpdate(fixture.models.cakeChatConversation(CAKE_CHAT_SESSION_ID), {
    _tag: "Snapshot",
    revision: 1,
    snapshot: snapshot(CAKE_CHAT_SESSION_ID),
  });
  for (const sessionId of options.history ?? [])
    fixture.root.navigationStore.selectProjectSession(sessionId);
  const current = options.history?.at(-1);
  if (current) {
    fixture.root.projectWorkbenchStore.showLoadedSession(current);
    fixture.root.sessionLayoutStore.ensureSession(current);
  }
  let cakeChatRevision = 1;
  const app = (
    <StoreProvider store={fixture.root}>
      <StoreProvider store={fixture.root.fullscreenSurfaceStore}>
        <App />
      </StoreProvider>
    </StoreProvider>
  );
  const view = render(
    options.transcriptViewport ? (
      <VirtuosoMockContext.Provider value={{ viewportHeight: 900, itemHeight: 160 }}>
        {app}
      </VirtuosoMockContext.Provider>
    ) : (
      app
    ),
  );
  const user = userEvent.setup();
  return {
    root: fixture.root,
    models: fixture.models,
    client: fixture.client,
    user,
    async selectSession(sessionId: string) {
      const summary = sessions.find((session) => session.sessionId === sessionId);
      if (!summary) throw new Error(`Missing session fixture ${sessionId}`);
      await user.click(screen.getByRole("button", { name: "Search sessions" }));
      const dialog = within(screen.getByRole("dialog", { name: "Search sessions" }));
      const resolved = dialog.getByRole("switch", { name: "Include resolved" });
      if (summary.resolved && resolved.getAttribute("aria-checked") !== "true")
        await user.click(resolved);
      await user.type(dialog.getByRole("combobox"), summary.title);
      await user.click(await dialog.findByRole("option", { name: new RegExp(summary.title) }));
      // Warm selection commits on requestAnimationFrame; later actions must not cancel it.
      await waitFor(() =>
        expect(fixture.root.appShellStore.activeConversation?.sessionId).toBe(sessionId),
      );
    },
    async showSessions(resolved = false) {
      const reopen = screen.queryByRole("button", { name: "Open Workspace" });
      if (reopen) await user.click(reopen);
      const workspace = within(screen.getByRole("complementary", { name: "Workspace" }));
      await user.click(workspace.getByRole("button", { name: /^Sessions/ }));
      if (resolved) {
        const toggle = workspace.getByRole("button", { name: "Resolved sessions" });
        if (toggle.getAttribute("aria-expanded") !== "true") await user.click(toggle);
      }
    },
    async pressHistory(direction: "back" | "forward") {
      const modifier = isMacPlatform ? "Meta" : "Alt";
      const key = isMacPlatform
        ? direction === "back"
          ? "BracketLeft"
          : "BracketRight"
        : direction === "back"
          ? "ArrowLeft"
          : "ArrowRight";
      await user.keyboard(`{${modifier}>}[${key}]{/${modifier}}`);
    },
    async publishCakeChatProjection(
      sessionId: string,
      parts: ConversationSnapshot["parts"] = [],
      kind: "Preview" | "Snapshot" = "Preview",
    ) {
      await act(async () =>
        applyConversationUpdate(fixture.models.cakeChatConversation(sessionId), {
          _tag: kind,
          revision: ++cakeChatRevision,
          snapshot: {
            ...snapshot(sessionId),
            sessionFile: `/chats/${sessionId}/coordinator.sqlite`,
            parts,
          },
        }),
      );
    },
    async publishResolved(sessionId: string, resolved = true) {
      sessions = sessions.map((session) =>
        session.sessionId === sessionId ? { ...session, resolved } : session,
      );
      await act(async () =>
        applySnapshot(fixture.models.sessionCatalog, {
          sessions,
          resolvedHasMoreByProject: {},
        }),
      );
    },
    async publishRemoved(sessionId: string) {
      sessions = sessions.filter((session) => session.sessionId !== sessionId);
      await act(async () =>
        applySnapshot(fixture.models.sessionCatalog, {
          sessions,
          resolvedHasMoreByProject: {},
        }),
      );
    },
    async publishHydrated(sessionId: string) {
      await act(async () =>
        applyConversationUpdate(fixture.models.projectConversation(sessionId, `/${sessionId}`), {
          _tag: "Snapshot",
          revision: 1,
          snapshot: snapshot(sessionId),
        }),
      );
    },
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}
