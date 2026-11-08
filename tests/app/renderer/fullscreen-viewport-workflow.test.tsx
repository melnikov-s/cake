/** @vitest-environment jsdom */
import { act, cleanup, render, screen } from "@testing-library/react";
import { StoreProvider } from "r-state-tree/react";
import { afterEach, expect, it } from "vitest";
import { AppShellLayout } from "../../../src/renderer/components/app-shell-layout";
import { FullscreenSurface } from "../../../src/renderer/components/fullscreen-surface";
import { createRendererStoreFixture } from "./renderer-store-fixture";

afterEach(cleanup);

it.each(["workspace", "overlay"])(
  "hosts %s presentations in the shell viewport without moving their content on rail changes",
  (placement) => {
    using fixture = createRendererStoreFixture({
      client: { electron: { setFullscreenSurfaceOpen: async () => undefined } },
    });
    const presentation = (
      <FullscreenSurface title="Layout preview" mode="canvas" onClose={() => undefined}>
        <button>Leftmost artifact control</button>
      </FullscreenSurface>
    );
    const view = render(
      <StoreProvider store={fixture.root}>
        <StoreProvider store={fixture.root.fullscreenSurfaceStore}>
          <AppShellLayout
            overlays={placement === "overlay" ? presentation : null}
            commandPaneWidth={420}
            onCommandPaneWidthChange={() => undefined}
          >
            {placement === "workspace" ? presentation : null}
          </AppShellLayout>
        </StoreProvider>
      </StoreProvider>,
    );
    const viewport = view.container.querySelector<HTMLElement>(
      '[data-slot="fullscreen-viewport"]',
    )!;
    const surface = screen.getByRole("dialog", { name: "Layout preview" });
    const control = screen.getByRole("button", { name: "Leftmost artifact control" });
    expect(surface.parentElement).toBe(viewport);
    expect(surface.classList.contains("absolute")).toBe(true);
    expect(viewport.classList.contains("col-start-2")).toBe(true);
    expect(viewport.classList.contains("col-end-5")).toBe(true);

    act(() => fixture.root.projectRailStore.setOverlayRight(240));
    expect(viewport.style.marginLeft).toContain("240px - var(--project-rail-width)");
    expect(screen.getByRole("button", { name: "Leftmost artifact control" })).toBe(control);

    // Application views have no rail, even before its last measurement clears.
    act(() => fixture.root.appShellStore.showSettings());
    expect(viewport.style.marginLeft).toBe("0px");
    expect(view.container.querySelector('[data-slot="project-rail"]')).toBeNull();
    expect(surface.parentElement).toBe(viewport);
    view.unmount();
  },
);
