/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import QRCode from "qrcode";
import userEvent from "@testing-library/user-event";
import { renderToStaticMarkup } from "react-dom/server";
import { NetworkIcon } from "../../../src/renderer/components/ui/icons";
import { IconSizeProvider } from "../../../src/renderer/components/ui/icon-size";
import { StoreProvider } from "r-state-tree/react";
import { createStore, mount, updateStore } from "r-state-tree";
import { DesktopConnectionStore } from "../../../src/renderer/stores/DesktopConnectionStore";
import { createTestClient } from "./test-client";
import { afterEach, expect, it, vi } from "vitest";
import type { DesktopSharingState } from "../../../src/contracts/desktop/desktop-sharing-data";
import type { Client } from "../../../src/renderer/client/Client";
import { AppSurfaceHeader } from "../../../src/renderer/components/app-surface-header";
import { ProjectRail } from "../../../src/renderer/components/project-rail";
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
      <ProjectRail />
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

it("starts from the persistent rail with saved preferences, prevents repeated starts and shares Settings state", async () => {
  using f = setup();
  expect(f.configure).not.toHaveBeenCalled();
  // Rail controls render glyphs in the shared 18px navigation role.
  const connectionIcon = renderToStaticMarkup(
    <IconSizeProvider size="navigation">
      <NetworkIcon />
    </IconSizeProvider>,
  );
  expect(offline().querySelector("svg")?.outerHTML).toBe(connectionIcon);
  expect(offline().classList.contains("text-muted-foreground")).toBe(true);
  expect(offline().classList.contains("text-success")).toBe(false);
  await f.user.click(offline());
  expect(screen.getByRole("dialog", { name: "Browser sharing" })).toBeDefined();
  expect(screen.getByText(/Anyone who can connect has full host access/)).toBeDefined();
  expect(screen.getByText(/Funnel is public: require Google sign-in/)).toBeDefined();
  expect(f.configure).not.toHaveBeenCalled();
  expect(screen.getByText("Sharing is off. Go online to show an access QR code.")).toBeDefined();
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
  const online = await screen.findByRole("button", { name: "Browser sharing: Online" });
  expect(online.querySelector("svg")?.outerHTML).toBe(connectionIcon);
  expect(online.classList.contains("text-success")).toBe(true);
  expect(
    screen.getByRole("switch", { name: "Enable browser sharing" }).getAttribute("aria-checked"),
  ).toBe("true");
  expect(screen.getByText("https://cake.tailnet.ts.net/")).toBeDefined();
  await f.user.click(screen.getByRole("button", { name: "Go offline" }));
  await waitFor(() => expect(offline()).toBeDefined());
  expect(offline().querySelector("svg")?.outerHTML).toBe(connectionIcon);
  expect(offline().classList.contains("text-success")).toBe(false);
  expect(f.configure).toHaveBeenLastCalledWith(
    { enabled: false, ...preferences },
    expect.anything(),
  );
  // Settings still operates on exactly the same workflow and updates the rail.
  await f.user.click(screen.getByRole("switch", { name: "Enable browser sharing" }));
  expect(await screen.findByRole("button", { name: "Browser sharing: Online" })).toBeDefined();
});

it.each([false, true])(
  "shows a locally generated URL-only QR in the rail with Google protection=%s",
  async (google) => {
    const serving: DesktopSharingState = {
      ...state("serving"),
      preferences: google
        ? {
            ...preferences,
            google: {
              clientId: "personal.apps.googleusercontent.com",
              allowedEmails: ["me@gmail.com"],
            },
          }
        : preferences,
    };
    using f = setup(serving);
    await f.user.click(screen.getByRole("button", { name: "Browser sharing: Online" }));
    const panel = within(screen.getByRole("dialog", { name: "Browser sharing" }));
    expect(panel.getByText(serving.url!)).toBeDefined();
    const qr = await panel.findByRole("img", {
      name: google ? "Scan to open Cake and sign in with Google" : "Scan to open Cake",
    });
    const svg = await QRCode.toString(serving.url!, {
      type: "svg",
      width: 224,
      margin: 4,
      errorCorrectionLevel: "M",
    });
    expect(qr.getAttribute("src")).toBe(
      `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
    );
    expect(panel.getByText("Configured URL · reachability not verified")).toBeDefined();
    if (google) expect(panel.getByText(/Google sign-in required/)).toBeDefined();
    expect(f.configure).not.toHaveBeenCalled();
    await act(async () => {
      f.sharing.apply(state("stopping"));
    });
    expect(panel.queryByRole("img")).toBeNull();
    await act(async () => {
      f.sharing.apply(state("disabled"));
    });
    expect(panel.getByText("Sharing is off. Go online to show an access QR code.")).toBeDefined();
  },
);

it("shows a LAN access QR without requiring Google or changing settings", async () => {
  const serving: DesktopSharingState = {
    status: "serving",
    bind: "192.168.1.10",
    port: 4317,
    preferences: { bind: "192.168.1.10", port: 4317 },
    url: "http://192.168.1.10:4317/",
  };
  using f = setup(serving);
  await f.user.click(screen.getByRole("button", { name: "Browser sharing: Online" }));
  expect(await screen.findByRole("img", { name: "Scan to open Cake" })).toBeDefined();
  expect(screen.getByText("Devices must be on the same network.")).toBeDefined();
  expect(f.configure).not.toHaveBeenCalled();
  expect(f.sharing.state?.preferences).toEqual(serving.preferences);
});

it.each([
  undefined,
  "http://127.0.0.1:4317/",
  "http://127.0.0.2:4317/",
  "http://localhost:4317/",
  "not a URL",
])("offers existing setup instead of a misleading QR for URL %s", async (url) => {
  using f = setup({ ...state("serving"), url });
  await f.user.click(screen.getByRole("button", { name: "Browser sharing: Online" }));
  const panel = within(screen.getByRole("dialog", { name: "Browser sharing" }));
  expect(panel.queryByRole("img")).toBeNull();
  expect(panel.getByText(url ? /local-only or unusable/ : /No access URL available/)).toBeDefined();
  await f.user.click(panel.getByRole("button", { name: "Connection settings" }));
  expect(f.root.settingsStore.activePage).toBe("network");
  expect(f.configure).not.toHaveBeenCalled();
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
      <ProjectRail />
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
