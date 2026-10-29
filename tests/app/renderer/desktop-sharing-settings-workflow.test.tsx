/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import {
  defaultDesktopSharingPreferences,
  type DesktopSharingPreferences,
  type DesktopSharingState,
} from "../../../src/contracts/desktop/desktop-sharing-data";
import type { Client } from "../../../src/renderer/client/Client";
import { SettingsDesktopSharingSection } from "../../../src/renderer/components/settings-desktop-sharing-section";
import { createRendererStoreFixture } from "./renderer-store-fixture";

afterEach(cleanup);

const disabled = (preferences: DesktopSharingPreferences): DesktopSharingState => ({
  status: "disabled",
  ...preferences,
  preferences,
});
function setup(initial = defaultDesktopSharingPreferences(), saveFailure = false) {
  let persisted = initial;
  const save = vi.fn<Client["desktopSharing"]["updatePreferences"]>(async (preferences) => {
    if (saveFailure) throw new Error("Could not save browser sharing preferences");
    persisted = preferences;
    return disabled(persisted);
  });
  const configure = vi.fn<Client["desktopSharing"]["configure"]>(
    async ({ enabled, ...preferences }) => ({
      ...disabled(preferences),
      status: enabled ? "serving" : "disabled",
      port: enabled && preferences.port === 0 ? 54321 : preferences.port,
    }),
  );
  const fixture = createRendererStoreFixture({
    client: { desktopSharing: { updatePreferences: save, configure } },
  });
  const sharing = fixture.root.settingsStore.desktopSharing;
  sharing.apply(disabled(initial));
  const view = render(<SettingsDesktopSharingSection sharing={sharing} />);
  return {
    ...fixture,
    sharing,
    save,
    configure,
    user: userEvent.setup(),
    persisted: () => persisted,
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}

it("saves HTTPS origin, bind and port while off and hydrates a fresh window without writing defaults", async () => {
  let preferences: DesktopSharingPreferences;
  {
    using f = setup({ bind: "127.0.0.1", port: 4317, publicOrigin: "https://old.example" });
    const origin = screen.getByRole("textbox", { name: "Browser sharing HTTPS origin" });
    expect(origin).toHaveProperty("value", "https://old.example");
    expect(f.save).not.toHaveBeenCalled();
    await f.user.clear(origin);
    await f.user.click(origin);
    await f.user.paste("https://laptop.tailnet.ts.net:8443");
    const port = screen.getByRole("textbox", { name: "Browser sharing port" });
    await f.user.clear(port);
    await f.user.paste("0");
    const bind = screen.getByRole("textbox", { name: "Browser sharing bind address" });
    await f.user.clear(bind);
    await f.user.paste("127.0.0.2");
    await waitFor(() =>
      expect(f.save).toHaveBeenLastCalledWith(
        {
          bind: "127.0.0.2",
          port: 0,
          publicOrigin: "https://laptop.tailnet.ts.net:8443",
        },
        expect.anything(),
      ),
    );
    expect(f.configure).not.toHaveBeenCalled();
    preferences = f.persisted();
  }
  using fresh = setup(preferences);
  expect(screen.getByRole("textbox", { name: "Browser sharing HTTPS origin" })).toHaveProperty(
    "value",
    preferences.publicOrigin,
  );
  expect(screen.getByRole("textbox", { name: "Browser sharing port" })).toHaveProperty(
    "value",
    "0",
  );
  expect(screen.getByRole("textbox", { name: "Browser sharing bind address" })).toHaveProperty(
    "value",
    "127.0.0.2",
  );
  expect(
    screen.getByRole("switch", { name: "Enable browser sharing" }).getAttribute("aria-checked"),
  ).toBe("false");
  expect(fresh.save).not.toHaveBeenCalled();
});

it("does not replace port zero with the assigned listener port on enable/disable", async () => {
  using f = setup({ bind: "127.0.0.1", port: 0 });
  const toggle = screen.getByRole("switch", { name: "Enable browser sharing" });
  await f.user.click(toggle);
  await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
  expect(screen.getByRole("textbox", { name: "Browser sharing port" })).toHaveProperty(
    "value",
    "0",
  );
  await f.user.click(toggle);
  await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
  expect(f.configure).toHaveBeenLastCalledWith(
    { enabled: false, bind: "127.0.0.1", port: 0 },
    expect.anything(),
  );
});

it("configures Google sign-in, saves account removals while serving, and displays the public URL QR code", async () => {
  using f = setup({ bind: "127.0.0.1", port: 4317, publicOrigin: "https://laptop.tailnet.ts.net" });
  await f.user.click(screen.getByRole("switch", { name: "Require Google sign-in" }));
  await f.user.type(
    screen.getByRole("textbox", { name: "Google web client ID" }),
    "personal.apps.googleusercontent.com",
  );
  const accounts = screen.getByRole("textbox", { name: "Allowed Google accounts" });
  await f.user.type(accounts, "owner@gmail.com{enter}guest@gmail.com");
  expect(f.save).not.toHaveBeenCalled();
  await f.user.click(screen.getByRole("button", { name: "Save allowed accounts" }));
  await waitFor(() =>
    expect(f.persisted().google?.allowedEmails).toEqual(["owner@gmail.com", "guest@gmail.com"]),
  );
  await f.user.click(screen.getByRole("button", { name: "Google & Tailscale setup" }));
  expect(screen.getByText("https://laptop.tailnet.ts.net/auth/google/callback")).toBeDefined();
  f.configure.mockImplementation(async ({ enabled, ...preferences }) => ({
    ...disabled(preferences),
    status: enabled ? "serving" : "disabled",
    url: "https://laptop.tailnet.ts.net/",
  }));
  await f.user.click(screen.getByRole("switch", { name: "Enable browser sharing" }));
  const qr = await screen.findByRole("img", { name: "Scan to open Cake and sign in with Google" });
  expect(qr.getAttribute("src")).toMatch(/^data:image\/svg\+xml/);
  expect(screen.getByRole("textbox", { name: "Remote access URL" })).toHaveProperty(
    "value",
    "https://laptop.tailnet.ts.net/",
  );
  f.save.mockImplementation(async (preferences) => ({
    ...disabled(preferences),
    status: "serving",
    url: "https://laptop.tailnet.ts.net/",
  }));
  await f.user.clear(accounts);
  await f.user.type(accounts, "owner@gmail.com");
  await f.user.click(screen.getByRole("button", { name: "Save allowed accounts" }));
  await waitFor(() =>
    expect(f.save).toHaveBeenLastCalledWith(
      expect.objectContaining({
        google: {
          clientId: "personal.apps.googleusercontent.com",
          allowedEmails: ["owner@gmail.com"],
        },
      }),
      expect.anything(),
    ),
  );
  expect(
    screen.getByRole("switch", { name: "Enable browser sharing" }).getAttribute("aria-checked"),
  ).toBe("true");
});

it("can switch off sharing despite an incomplete Google-account draft", async () => {
  using f = setup({
    bind: "127.0.0.1",
    port: 4317,
    publicOrigin: "https://laptop.tailnet.ts.net",
    google: {
      clientId: "personal.apps.googleusercontent.com",
      allowedEmails: ["owner@gmail.com"],
    },
  });
  const toggle = screen.getByRole("switch", { name: "Enable browser sharing" });
  await f.user.click(toggle);
  await f.user.clear(screen.getByRole("textbox", { name: "Allowed Google accounts" }));
  await f.user.type(
    screen.getByRole("textbox", { name: "Allowed Google accounts" }),
    "incomplete@",
  );
  await f.user.click(toggle);
  await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
  expect(f.configure).toHaveBeenLastCalledWith(
    expect.objectContaining({
      enabled: false,
      google: {
        clientId: "personal.apps.googleusercontent.com",
        allowedEmails: ["owner@gmail.com"],
      },
    }),
    expect.anything(),
  );
});

it("keeps newer incomplete drafts through older save replies and reports failed persistence", async () => {
  using f = setup();
  let complete: (state: DesktopSharingState) => void = () => {};
  f.save.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const origin = screen.getByRole("textbox", { name: "Browser sharing HTTPS origin" });
  await f.user.click(origin);
  await f.user.paste("https://first.example");
  await f.user.clear(origin);
  await f.user.paste("https://"); // Not a setting until valid.
  await act(async () => {
    complete(disabled({ bind: "127.0.0.1", port: 4317, publicOrigin: "https://first.example" }));
  });
  expect(origin).toHaveProperty("value", "https://");
  await act(async () => {
    f.sharing.apply(disabled({ bind: "127.0.0.1", port: 4317 }));
  });
  expect(origin).toHaveProperty("value", "https://");
  expect(f.sharing.saving).toBe(false);
  f.save.mockRejectedValueOnce(new Error("Disk unavailable"));
  await f.user.clear(origin);
  expect(await screen.findByText("Disk unavailable")).toBeDefined();
  expect(origin).toHaveProperty("value", "");
});
