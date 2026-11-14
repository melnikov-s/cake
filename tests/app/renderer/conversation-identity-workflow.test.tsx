/** @vitest-environment jsdom */
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { applySnapshot, toSnapshot, type StoreSnapshot } from "r-state-tree";
import { StoreProvider } from "r-state-tree/react";
import { afterEach, expect, it, vi } from "vitest";
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

function renderIdentity(snapshot?: StoreSnapshot) {
  const fixture = createRendererStoreFixture({
    snapshot,
    projects: [projectRecord({ path: "/project", name: "Project" })],
    sessions: [
      sessionSummary({ sessionId: "task", projectPath: "/project", title: "Build identity" }),
    ],
  });
  fixture.root.navigationStore.selectProjectSession("task");
  const view = render(
    <StoreProvider store={fixture.root}>
      <ConversationBreadcrumb sessionId="task" />
      <ConversationIdentityDock sessionId="task">
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
    saved = toSnapshot(f.root);
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

it("tracks the displayed global and project session as the shared focused surface switches", async () => {
  using f = renderAppShellNavigation();
  expect(screen.getByRole("navigation", { name: "Conversation identity" }).textContent).toBe(
    "Cake Chat",
  );
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
  expect(screen.getByRole("navigation", { name: "Conversation identity" }).textContent).toBe(
    "Cake Chat",
  );
});
