/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StoreProvider } from "r-state-tree/react";
import { createStore, mount, updateStore } from "r-state-tree";
import { DesktopConnectionStore } from "../../../src/renderer/stores/DesktopConnectionStore";
import { createTestClient } from "./test-client";
import { afterEach, expect, it, vi } from "vitest";
import type { DesktopSharingState } from "../../../src/contracts/desktop/desktop-sharing-data";
import type { Client } from "../../../src/renderer/client/Client";
import { AppSurfaceHeader } from "../../../src/renderer/components/app-surface-header";
import { SettingsDesktopSharingSection } from "../../../src/renderer/components/settings-desktop-sharing-section";
import { createRendererStoreFixture } from "./renderer-store-fixture";

afterEach(cleanup);
const preferences = { bind: "127.0.0.2", port: 0, publicOrigin: "https://cake.tailnet.ts.net" };
const state = (status: DesktopSharingState["status"]): DesktopSharingState => ({
  ...preferences,
  preferences,
  status,
  ...(status === "serving" ? { port: 54321, url: "https://cake.tailnet.ts.net/" } : {}),
});
function setup(initial: DesktopSharingState = state("disabled")) {
  const configure = vi.fn<Client["desktopSharing"]["configure"]>(async ({ enabled }) =>
    state(enabled ? "serving" : "disabled"),
  );
  const fixture = createRendererStoreFixture({ client: { desktopSharing: { configure } } });
  const sharing = fixture.root.settingsStore.desktopSharing;
  if (initial) sharing.apply(initial);
  const view = render(
    <StoreProvider store={fixture.root}>
      <AppSurfaceHeader />
      <SettingsDesktopSharingSection sharing={sharing} />
    </StoreProvider>,
  );
  return {
    ...fixture,
    sharing,
    configure,
    user: userEvent.setup(),
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}
const offline = () => screen.getByRole("button", { name: "Browser sharing: Offline — go online" });

it("starts from the topbar with saved preferences, prevents repeated starts and shares Settings state", async () => {
  using f = setup();
  expect(f.configure).not.toHaveBeenCalled();
  await f.user.click(offline());
  expect(screen.getByRole("dialog", { name: "Browser sharing" })).toBeDefined();
  expect(screen.getByText(/Anyone who can connect has full host access/)).toBeDefined();
  expect(screen.getByText(/Funnel is public: require Google sign-in/)).toBeDefined();
  expect(f.configure).not.toHaveBeenCalled();
  let finish!: (state: DesktopSharingState) => void;
  f.configure.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await f.user.click(screen.getByRole("button", { name: "Go online" }));
  const connecting = screen.getByRole("button", { name: "Connecting…" });
  expect(connecting).toHaveProperty("disabled", true);
  expect(screen.getByRole("switch", { name: "Enable browser sharing" })).toHaveProperty(
    "disabled",
    true,
  );
  await f.user.click(connecting);
  expect(f.configure).toHaveBeenCalledTimes(1);
  expect(f.configure).toHaveBeenCalledWith({ enabled: true, ...preferences }, expect.anything());
  await act(async () => {
    finish(state("serving"));
  });
  expect(await screen.findByRole("button", { name: "Browser sharing: Online" })).toBeDefined();
  expect(
    screen.getByRole("switch", { name: "Enable browser sharing" }).getAttribute("aria-checked"),
  ).toBe("true");
  expect(screen.getByText("https://cake.tailnet.ts.net/")).toBeDefined();
  await f.user.click(screen.getByRole("button", { name: "Go offline" }));
  await waitFor(() => expect(offline()).toBeDefined());
  expect(f.configure).toHaveBeenLastCalledWith(
    { enabled: false, ...preferences },
    expect.anything(),
  );
  // Settings still operates on exactly the same workflow and updates the topbar.
  await f.user.click(screen.getByRole("switch", { name: "Enable browser sharing" }));
  expect(await screen.findByRole("button", { name: "Browser sharing: Online" })).toBeDefined();
});

it("shows failures without claiming online, allows retry and reflects authority lifecycle updates", async () => {
  using f = setup();
  f.configure.mockRejectedValueOnce(new Error("Address already in use"));
  await f.user.click(offline());
  await f.user.click(screen.getByRole("button", { name: "Go online" }));
  expect(await screen.findByRole("button", { name: "Browser sharing: Error" })).toBeDefined();
  expect(screen.getAllByText("Address already in use").length).toBeGreaterThan(0);
  await f.user.click(screen.getByRole("button", { name: "Go online" }));
  expect(await screen.findByRole("button", { name: "Browser sharing: Online" })).toBeDefined();
  await act(async () => {
    f.sharing.apply(state("stopping"));
  });
  expect(screen.getByRole("button", { name: "Going offline…" })).toHaveProperty("disabled", true);
  await act(async () => {
    f.sharing.apply(state("disabled"));
  });
  expect(offline()).toBeDefined();
  await act(async () => {
    f.sharing.apply(state("starting"));
  });
  expect(screen.getByRole("button", { name: "Connecting…" })).toHaveProperty("disabled", true);
  await act(async () => {
    f.sharing.apply({ ...state("failed"), error: "Listener failed" });
  });
  expect(screen.getByRole("button", { name: "Browser sharing: Error" })).toBeDefined();
  expect(screen.getAllByText("Listener failed").length).toBeGreaterThan(0);
});

it("does not expose the local sharing listener when connected to a remote backend", () => {
  const client = createTestClient();
  using connection = mount(
    createStore(DesktopConnectionStore, {
      host: { kind: "remote", url: "http://127.0.0.1:4317" },
      client: () => client,
      connect: async () => {},
    }),
  );
  using fixture = createRendererStoreFixture({ desktopConnection: connection });
  const view = render(
    <StoreProvider store={fixture.root}>
      <AppSurfaceHeader />
    </StoreProvider>,
  );
  try {
    expect(screen.queryByRole("button", { name: /^Browser sharing:/ })).toBeNull();
  } finally {
    view.unmount();
  }
});

it("waits for initial sharing state without enabling anything", async () => {
  using f = setup();
  await act(async () => {
    f.sharing.state = undefined;
  });
  await f.user.click(screen.getByRole("button", { name: "Browser sharing: Loading…" }));
  expect(screen.getByRole("button", { name: "Loading…" })).toHaveProperty("disabled", true);
  expect(f.configure).not.toHaveBeenCalled();
  await act(async () => {
    f.sharing.apply(state("disabled"));
  });
  expect(screen.getByRole("button", { name: "Go online" })).toHaveProperty("disabled", false);
});

it("opens the existing network settings only on request and omits local listener controls in browser mode", async () => {
  using f = setup();
  await f.user.click(offline());
  await f.user.click(screen.getByRole("button", { name: "Connection settings" }));
  expect(screen.queryByRole("dialog", { name: "Browser sharing" })).toBeNull();
  expect(screen.getByRole("button", { name: "Back to chat" })).toBeDefined();
  expect(f.root.settingsStore.activePage).toBe("network");
  expect(f.configure).not.toHaveBeenCalled();
  await act(async () => {
    updateStore(f.root, { browserHost: true });
  });
  expect(screen.queryByRole("button", { name: /^Browser sharing:/ })).toBeNull();
});
