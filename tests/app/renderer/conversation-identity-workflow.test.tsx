/** @vitest-environment jsdom */
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { applySnapshot, toSnapshot, type StoreSnapshot } from "r-state-tree";
import { StoreProvider } from "r-state-tree/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  CAKE_CHAT_SESSION_ID,
  isCakeChatSessionId,
} from "../../../src/contracts/cake-chats/cake-chat-identity";
import { ConversationBreadcrumb } from "../../../src/renderer/components/conversation-breadcrumb";
import { ConversationIdentityDock } from "../../../src/renderer/components/conversation-identity-dock";
import { SettingsAppearanceSection } from "../../../src/renderer/components/settings-appearance-section";
import { searchSettings } from "../../../src/renderer/lib/settings-search";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import { renderAppShellNavigation } from "./app-shell-navigation-fixture";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderIdentity(snapshot?: StoreSnapshot, sessionId = "task", staged = false) {
  const fixture = createRendererStoreFixture({
    snapshot,
    projects: [projectRecord({ path: "/project", name: "Project" })],
    sessions: staged
      ? []
      : [sessionSummary({ sessionId: "task", projectPath: "/project", title: "Build identity" })],
  });
  if (staged) fixture.root.sessionRegistry.pendingSessions.prepareStaged("/project", sessionId);
  if (isCakeChatSessionId(sessionId)) fixture.root.navigationStore.selectCakeChat(sessionId);
  else fixture.root.navigationStore.selectProjectSession(sessionId);
  const view = render(
    <StoreProvider store={fixture.root}>
      <ConversationBreadcrumb sessionId={sessionId} />
      <ConversationIdentityDock sessionId={sessionId}>
        <div data-testid="conversation">Transcript and composer</div>
      </ConversationIdentityDock>
      <SettingsAppearanceSection appearance={fixture.root.settingsStore.appearance} />
    </StoreProvider>,
  );
  return {
    ...fixture,
    user: userEvent.setup(),
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}

it("keeps staged ownership and reactive manual names without listing an unsent session", async () => {
  using f = renderIdentity(undefined, "unsent", true);
  const pending = f.root.sessionRegistry.pendingSessions;
  const header = screen.getByRole("navigation", { name: "Conversation breadcrumb" });
  const dock = screen.getByRole("navigation", { name: "Conversation identity" });
  const assertIdentity = (title: string) => {
    for (const surface of [header, dock]) {
      expect(surface.textContent).toBe(`Project›${title}`);
      expect(within(surface).queryByRole("button", { name: "Cake Chat" })).toBeNull();
      expect(
        within(surface).getByRole("button", { name: title }).getAttribute("aria-current"),
      ).toBe("page");
    }
    expect(f.root.conversationNavigatorStore.lineageFor("unsent").at(-1)?.title).toBe(title);
  };
  assertIdentity("New chat");
  act(() => pending.conversation("unsent")!.setName("Manually named"));
  assertIdentity("Manually named");
  expect(pending.summaries).toEqual([]);
  expect(f.root.sessionCatalogStore.find("unsent")).toBeUndefined();
  expect(f.root.conversationNavigatorStore.tree("/project").byKey.has("session:unsent")).toBe(
    false,
  );

  // Both rejected starts and canceled preparation return through this same boundary.
  act(() => pending.projectSubmission("unsent", "First prompt"));
  assertIdentity("Manually named");
  act(() => pending.cancelSubmission("unsent"));
  assertIdentity("Manually named");
  expect(pending.summaries).toEqual([]);
  expect(f.root.sessionCatalogStore.find("unsent")).toBeUndefined();
  const openProjectChat = vi
    .spyOn(f.root.navigationStore, "openProjectChat")
    .mockResolvedValue(true);
  await f.user.click(within(header).getByRole("button", { name: "Project" }));
  expect(openProjectChat).toHaveBeenCalledWith("/project");
});

it("keeps generated first-send identity through cancellation, acceptance and durable catalog replacement", () => {
  using f = renderIdentity(undefined, "unsent", true);
  const pending = f.root.sessionRegistry.pendingSessions;
  const header = screen.getByRole("navigation", { name: "Conversation breadcrumb" });
  const dock = screen.getByRole("navigation", { name: "Conversation identity" });
  const assertTitle = (title: string) => {
    expect(header.textContent).toBe(`Project›${title}`);
    expect(dock.textContent).toBe(`Project›${title}`);
  };
  act(() => pending.projectSubmission("unsent", "First prompt"));
  assertTitle("First prompt");
  act(() => pending.conversation("unsent")!.setFallbackTitle("Generated title"));
  assertTitle("Generated title");
  act(() => pending.cancelSubmission("unsent"));
  assertTitle("Generated title");
  act(() => {
    pending.projectSubmission("unsent", "Retry prompt");
    pending.conversation("unsent")!.setFallbackTitle("Generated retry");
    pending.materialize("unsent", "/project");
  });
  assertTitle("Generated retry");
  act(() =>
    applySnapshot(f.models.sessionCatalog, {
      sessions: [
        sessionSummary({ sessionId: "unsent", projectPath: "/project", title: "Pi title" }),
      ],
      resolvedHasMoreByProject: {},
    }),
  );
  assertTitle("Pi title");
});

it("maps a staged managed checkout to its owning project before any session catalog entry", () => {
  using f = renderIdentity(undefined, "unsent", true);
  act(() => {
    f.root.sessionCatalogStore.notePendingManagedWorktree({
      projectPath: "/project",
      worktreePath: "/worktrees/checkout",
      branch: "agent/checkout",
      baseBranch: "main",
      state: "active",
      createdAt: "2026-01-01T00:00:00Z",
    });
    f.root.sessionRegistry.pendingSessions.relocate("unsent", "/worktrees/checkout");
  });
  for (const label of ["Conversation breadcrumb", "Conversation identity"]) {
    const nav = screen.getByRole("navigation", { name: label });
    expect(nav.textContent).toBe("Project›New chat");
    expect(within(nav).getByRole("button", { name: "Project" }).getAttribute("title")).toBe(
      "/project",
    );
  }
  expect(f.root.sessionCatalogStore.find("unsent")).toBeUndefined();
});

it("preserves the registry-only fork preview's owner and title without cataloging it", () => {
  using f = createRendererStoreFixture({
    projects: [projectRecord({ path: "/project", name: "Project" })],
  });
  f.root.sessionRegistry.pendingSessions.prepareStaged("/project", "source");
  const preview = f.root.sessionRegistry.prepareForkPreview("source", "entry", "Original");
  f.root.navigationStore.selectProjectSession(preview.sessionId);
  render(
    <StoreProvider store={f.root}>
      <ConversationBreadcrumb sessionId={preview.sessionId} />
      <ConversationIdentityDock sessionId={preview.sessionId}>
        <div>Fork preview</div>
      </ConversationIdentityDock>
    </StoreProvider>,
  );
  for (const label of ["Conversation breadcrumb", "Conversation identity"])
    expect(screen.getByRole("navigation", { name: label }).textContent).toBe(
      "Project›Fork of Original",
    );
  expect(f.root.sessionCatalogStore.find(preview.sessionId)).toBeUndefined();
  expect(f.root.sessionRegistry.pendingSessions.isStaged(preview.sessionId)).toBe(false);
});

it("defaults on, follows live title metadata, and preserves the existing header and navigation", async () => {
  using f = renderIdentity();
  const header = screen.getByRole("navigation", { name: "Conversation breadcrumb" });
  const identity = screen.getByRole("navigation", { name: "Conversation identity" });
  expect(identity.textContent).toContain("Project");
  expect(
    within(identity).getByRole("button", { name: "Build identity" }).getAttribute("aria-current"),
  ).toBe("page");
  act(() =>
    applySnapshot(f.models.sessionCatalog, {
      sessions: [
        sessionSummary({ sessionId: "task", projectPath: "/project", title: "Renamed identity" }),
      ],
      resolvedHasMoreByProject: {},
    }),
  );
  expect(identity.textContent).toContain("Renamed identity");
  expect(header.textContent).toContain("Renamed identity");
  for (const nav of [header, identity])
    expect(nav.querySelector('[data-purpose="user"]')).not.toBeNull();
  act(() => {
    f.models.sessionCatalog.find("task")!.purpose = "delegated";
  });
  for (const nav of [header, identity]) {
    expect(nav.querySelector('[data-purpose="delegated"]')).not.toBeNull();
    expect(nav.querySelector('[data-purpose="user"]')).toBeNull();
    expect(within(nav).getByRole("button", { name: "Renamed identity" })).toBeDefined();
  }
  const openProjectChat = vi
    .spyOn(f.root.navigationStore, "openProjectChat")
    .mockResolvedValue(true);
  await f.user.click(within(identity).getByRole("button", { name: "Project" }));
  expect(openProjectChat).toHaveBeenCalledWith("/project");
});

it("hides without a reserved layout row, persists off, and restores immediately from the Appearance toggle", async () => {
  let saved: StoreSnapshot;
  {
    using f = renderIdentity();
    const toggle = screen.getByRole("switch", { name: "Conversation identity tab" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(
      screen.getByTestId("conversation").closest('[data-slot="conversation-identity-layout"]'),
    ).not.toBeNull();
    await f.user.click(toggle);
    expect(screen.queryByRole("navigation", { name: "Conversation identity" })).toBeNull();
    expect(
      screen.getByTestId("conversation").closest('[data-slot="conversation-identity-layout"]'),
    ).toBeNull();
    expect(screen.getByRole("navigation", { name: "Conversation breadcrumb" })).toBeDefined();
    saved = toSnapshot(f.root) ?? {};
  }
  using restored = renderIdentity(saved);
  const toggle = screen.getByRole("switch", { name: "Conversation identity tab" });
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  expect(screen.queryByRole("navigation", { name: "Conversation identity" })).toBeNull();
  await restored.user.click(toggle);
  expect(screen.getByRole("navigation", { name: "Conversation identity" })).toBeDefined();
  expect(searchSettings("breadcrumb")).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        page: "appearance",
        items: expect.arrayContaining([
          expect.objectContaining({ targetId: "setting-conversation-identity" }),
        ]),
      }),
    ]),
  );
});

it.each([
  ["Project Chat", `project-chat:${"a".repeat(64)}`],
  ["global Cake Chat", CAKE_CHAT_SESSION_ID],
])("omits the badge and layout row in %s with the setting on", (_kind, sessionId) => {
  using f = renderIdentity(undefined, sessionId);
  expect(f.root.appShellStore.activeConversation).toEqual({ kind: "cake-chat", sessionId });
  expect(f.root.settingsStore.appearance.conversationIdentityEnabled).toBe(true);
  expect(screen.queryByRole("navigation", { name: "Conversation identity" })).toBeNull();
  expect(document.querySelector('[data-slot="conversation-identity-layout"]')).toBeNull();
  expect(screen.getByRole("navigation", { name: "Conversation breadcrumb" })).toBeDefined();
  expect(screen.getByTestId("conversation")).toBeDefined();
});

it("only shows the displayed Project Session as the shared focused surface switches", async () => {
  using f = renderAppShellNavigation();
  expect(screen.queryByRole("navigation", { name: "Conversation identity" })).toBeNull();
  expect(document.querySelector('[data-slot="conversation-identity-layout"]')).toBeNull();
  await f.selectSession("alpha");
  expect(screen.getByRole("navigation", { name: "Conversation identity" }).textContent).toContain(
    "alpha conversation",
  );
  await f.selectSession("beta");
  expect(screen.getByRole("navigation", { name: "Conversation identity" }).textContent).toContain(
    "beta conversation",
  );
  expect(
    screen.getByRole("navigation", { name: "Conversation identity" }).textContent,
  ).not.toContain("alpha conversation");
  await f.user.click(screen.getByRole("button", { name: "Open Cake Chat" }));
  expect(screen.queryByRole("navigation", { name: "Conversation identity" })).toBeNull();
  expect(document.querySelector('[data-slot="conversation-identity-layout"]')).toBeNull();
});
