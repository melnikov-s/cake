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
