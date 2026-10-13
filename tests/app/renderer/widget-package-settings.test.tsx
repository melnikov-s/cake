/**
 * @vitest-environment jsdom
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsWidgetPackagesSection } from "../../../src/renderer/components/settings-widget-packages-section";
import type { Client } from "../../../src/renderer/client/Client";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import type { TestClientOverrides } from "./test-client";

const empty = { directory: "/backend/widget-packages", packages: [] };
const installed = { ...empty, packages: [{ name: "vis-network", version: "9.1.9" }] };

function renderPackages(client: TestClientOverrides) {
  const fixture = createRendererStoreFixture({ client });
  const view = render(
    <SettingsWidgetPackagesSection settings={fixture.root.settingsStore.widgetPackages} />,
  );
  return {
    user: userEvent.setup(),
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}
afterEach(cleanup);

describe("Widget package Settings", () => {
  it("installs an explicitly requested package and removes it through the shared backend", async () => {
    const install = vi.fn<Client["widgetPackages"]["install"]>(async () => installed);
    const remove = vi.fn<Client["widgetPackages"]["remove"]>(async () => empty);
    using fixture = renderPackages({
      widgetPackages: { list: async () => empty, install, remove },
    });
    expect(await screen.findByText("No widget packages installed.")).toBeDefined();
    expect(screen.getByText(/\/backend\/widget-packages/)).toBeDefined();
    await fixture.user.type(
      screen.getByRole("textbox", { name: "Widget package specifier" }),
      "vis-network@9.1.9",
    );
    await fixture.user.click(screen.getByRole("button", { name: "Install widget package" }));
    expect(await screen.findByText("9.1.9")).toBeDefined();
    expect(install).toHaveBeenCalledWith(
      { specifier: "vis-network@9.1.9", userApproved: true },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(screen.getByRole("textbox", { name: "Widget package specifier" })).toHaveProperty(
      "value",
      "",
    );
    await fixture.user.click(screen.getByRole("button", { name: "Remove vis-network" }));
    expect(await screen.findByText("No widget packages installed.")).toBeDefined();
    expect(remove).toHaveBeenCalledWith(
      { name: "vis-network" },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(screen.getByText(/Package removed. Accepted artifact/)).toBeDefined();
  });

  it("keeps installed packages visible when removal fails and supports refresh", async () => {
    const list = vi.fn<Client["widgetPackages"]["list"]>(async () => installed);
    const remove = vi.fn<Client["widgetPackages"]["remove"]>(async () => {
      throw new Error("npm failed");
    });
    using fixture = renderPackages({ widgetPackages: { list, remove } });
    await fixture.user.click(await screen.findByRole("button", { name: "Remove vis-network" }));
    expect(await screen.findByText("npm failed")).toBeDefined();
    expect(screen.getByText("9.1.9")).toBeDefined();
    await fixture.user.click(screen.getByRole("button", { name: "Refresh packages" }));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText("npm failed")).toBeNull());
  });

  it("disables all mutation controls while an install is pending", async () => {
    let finish!: (value: typeof installed) => void;
    const install = vi.fn<Client["widgetPackages"]["install"]>(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    using fixture = renderPackages({ widgetPackages: { list: async () => installed, install } });
    await screen.findByText("9.1.9");
    await fixture.user.type(
      screen.getByRole("textbox", { name: "Widget package specifier" }),
      "d3",
    );
    await fixture.user.click(screen.getByRole("button", { name: "Install widget package" }));
    expect(screen.getByRole("button", { name: "Remove vis-network" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getByRole("button", { name: "Refresh packages" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getByRole("textbox", { name: "Widget package specifier" })).toHaveProperty(
      "disabled",
      true,
    );
    finish(installed);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Refresh packages" })).toHaveProperty(
        "disabled",
        false,
      ),
    );
    expect(install).toHaveBeenCalledTimes(1);
  });
});
