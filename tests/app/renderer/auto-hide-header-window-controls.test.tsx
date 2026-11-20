/** @vitest-environment jsdom */
import { act, cleanup, render } from "@testing-library/react";
import { StoreProvider } from "r-state-tree/react";
import { afterEach, expect, it, vi } from "vitest";
import { AppShellLayout } from "../../../src/renderer/components/app-shell-layout";
import { createRendererStoreFixture } from "./renderer-store-fixture";

vi.mock("../../../src/renderer/lib/platform", () => ({ isMacPlatform: true }));
afterEach(cleanup);

// An auto-hidden rail leaves nothing under the macOS traffic lights, so every mode's header
// must reserve the native window-control width itself (like VS Code's native titlebar does).
it.each([undefined, "browser", "vscode"] as const)(
  "reserves the native window controls in %s mode once the rail auto-hides",
  (workspaceMode) => {
    using fixture = createRendererStoreFixture();
    const view = render(
      <StoreProvider store={fixture.root}>
        <AppShellLayout
          overlays={null}
          workspaceMode={workspaceMode}
          commandPaneWidth={420}
          onCommandPaneWidthChange={() => undefined}
        >
          {null}
        </AppShellLayout>
      </StoreProvider>,
    );
    const shell = view.container.querySelector("main")!;
    const reservesControls = () =>
      shell.classList.contains("[--window-controls-width:100px]");
    expect(reservesControls()).toBe(workspaceMode === "vscode");
    act(() => {
      fixture.root.settingsStore.appearance.leftToolbar.preferences = {
        autoHide: true,
        layout: "full",
      };
    });
    expect(shell.classList.contains("[--project-rail-width:0px]")).toBe(true);
    expect(reservesControls()).toBe(true);
    view.unmount();
  },
);
