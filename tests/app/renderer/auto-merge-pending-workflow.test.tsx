/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { StrictMode } from "react";
import { StoreProvider } from "r-state-tree/react";
import { afterEach, expect, it, vi } from "vitest";
import { AutoMergeToggle } from "../../../src/renderer/components/auto-merge-toggle";
import { ToastHost } from "../../../src/renderer/components/toast-host";
import { applyWorktreeOperationCatalogUpdate } from "../../../src/renderer/reducers/WorktreeOperationReducer";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import { projectRecord } from "./fixtures/catalog-fixtures";

afterEach(cleanup);

it.each([false, true])(
  "shows immediate pending feedback without changing accepted enabled=%s, across controls and navigation",
  async (enabled) => {
    const save = Promise.withResolvers<void>();
    const setAutoMerge = vi.fn(() => save.promise);
    using fixture = createRendererStoreFixture({
      projects: [projectRecord({ path: "/cake" }), projectRecord({ path: "/other" })],
      client: { managedWorktrees: { setAutoMerge } },
    });
    const publish = (value: boolean) =>
      applyWorktreeOperationCatalogUpdate(fixture.models.worktreeOperations, {
        operations: [],
        autoMergeProjects: [
          { projectPath: "/cake", enabled: value, epoch: "accepted", status: "" },
        ],
      });
    publish(enabled);
    const surface = (path: string) => (
      <StrictMode>
        <StoreProvider store={fixture.root}>
          <section aria-label="Primary">
            <AutoMergeToggle projectPath={path} />
          </section>
          <section aria-label="Secondary">
            <AutoMergeToggle projectPath="/cake" />
          </section>
        </StoreProvider>
      </StrictMode>
    );
    const view = render(surface("/cake"));
    const primary = () =>
      within(screen.getByRole("region", { name: "Primary" })).getByRole("switch");
    const secondary = () =>
      within(screen.getByRole("region", { name: "Secondary" })).getByRole("switch");
    fireEvent.click(primary());
    expect(primary().getAttribute("aria-checked")).toBe(String(enabled));
    expect(primary().getAttribute("aria-busy")).toBe("true");
    expect(primary()).toHaveProperty("disabled", true);
    expect(secondary()).toHaveProperty("disabled", true);
    expect(screen.getAllByRole("status").map((item) => item.textContent)).toEqual([
      enabled ? "Disabling…" : "Enabling…",
      enabled ? "Disabling…" : "Enabling…",
    ]);
    fireEvent.click(primary());
    fireEvent.click(secondary());
    await act(() => fixture.root.autoMergeStore.toggle("/cake"));
    expect(setAutoMerge.mock.calls).toEqual([["/cake", !enabled]]);
    view.rerender(surface("/other"));
    expect(primary()).toHaveProperty("disabled", false);
    expect(secondary()).toHaveProperty("disabled", true);
    view.rerender(surface("/cake"));
    expect(primary()).toHaveProperty("disabled", true);

    // Accepted projection may arrive before the RPC response. Keep submissions blocked
    // until the request settles, but display the backend's state, never a local guess.
    act(() => publish(!enabled));
    expect(primary().getAttribute("aria-checked")).toBe(String(!enabled));
    expect(primary()).toHaveProperty("disabled", true);
    await act(() => fixture.root.autoMergeStore.toggle("/cake"));
    expect(setAutoMerge.mock.calls).toEqual([["/cake", !enabled]]);
    await act(async () => save.resolve());
    expect(primary()).toHaveProperty("disabled", false);
    expect(primary().getAttribute("aria-busy")).toBe("false");
    expect(screen.queryByText(enabled ? "Disabling…" : "Enabling…")).toBeNull();
    view.unmount();
  },
);

it.each([
  { enabled: false, message: "Preference write failed" },
  { enabled: false, message: "Readiness authorization rejected" },
  { enabled: true, message: "Preference write failed" },
])(
  "keeps accepted enabled=$enabled and exposes $message after a slow failure, allowing retry",
  async ({ enabled, message }) => {
    const save = Promise.withResolvers<void>();
    const setAutoMerge = vi.fn(() => save.promise);
    using fixture = createRendererStoreFixture({
      projects: [projectRecord({ path: "/cake" })],
      client: { managedWorktrees: { setAutoMerge } },
    });
    applyWorktreeOperationCatalogUpdate(fixture.models.worktreeOperations, {
      operations: [],
      autoMergeProjects: [{ projectPath: "/cake", enabled, epoch: "accepted", status: "" }],
    });
    const view = render(
      <StoreProvider store={fixture.root}>
        <AutoMergeToggle projectPath="/cake" />
        <ToastHost store={fixture.root.toastStore} />
      </StoreProvider>,
    );
    const toggle = screen.getByRole("switch");
    fireEvent.click(toggle);
    const pendingLabel = enabled ? "Disabling…" : "Enabling…";
    expect(toggle.getAttribute("aria-checked")).toBe(String(enabled));
    expect(screen.getByText(pendingLabel)).toBeTruthy();
    await act(async () => save.reject(new Error(message)));
    expect(toggle.getAttribute("aria-checked")).toBe(String(enabled));
    expect(toggle).toHaveProperty("disabled", false);
    expect(screen.queryByText(pendingLabel)).toBeNull();
    expect(screen.getByText("Could not change auto-merge")).toBeTruthy();
    expect(screen.getByText(message)).toBeTruthy();
    fireEvent.click(toggle);
    await act(async () => {});
    expect(setAutoMerge).toHaveBeenCalledTimes(2);
    view.unmount();
  },
);
