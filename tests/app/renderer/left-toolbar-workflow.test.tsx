/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StoreProvider } from "r-state-tree/react";
import { toSnapshot } from "r-state-tree";
import { defaultApplicationState } from "../../../src/contracts/application/application-data";
import { changeLeftToolbarPreferences } from "../../../src/utils/left-toolbar-preferences";
import { SettingsAppearanceSection } from "../../../src/renderer/components/settings-appearance-section";
import { NavigationRail } from "../../../src/renderer/components/ui/navigation-rail";
import { IconButton } from "../../../src/renderer/components/ui/icon-button";
import {
  Popover,
  PopoverContent,
  PopoverIconTrigger,
} from "../../../src/renderer/components/ui/popover";
import { createRendererStoreFixture } from "./renderer-store-fixture";

beforeEach(() => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(hover: hover)",
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("left toolbar settings", () => {
  it("uses the same transitions in UI and authority, broadcasts live to independent windows, and reloads without transient state", async () => {
    let state = defaultApplicationState();
    using a = createRendererStoreFixture({
      client: {
        workspaces: {
          setLeftToolbarPreferences: async (change) => {
            state = {
              ...state,
              leftToolbar: changeLeftToolbarPreferences(state.leftToolbar, change),
            };
            return state;
          },
        },
      },
    });
    using b = createRendererStoreFixture();
    render(
      <StoreProvider store={a.root}>
        <SettingsAppearanceSection appearance={a.root.settingsStore.appearance} />
      </StoreProvider>,
    );
    const store = a.root.settingsStore.appearance.leftToolbar;
    expect(screen.getByLabelText("Layout")).toHaveProperty("value", "dynamic");
    await act(async () => {
      fireEvent.click(screen.getByRole("switch", { name: "Auto-hide" }));
    });
    expect(store.preferences).toEqual({
      autoHide: true,
      layout: "full",
      previousLayout: "dynamic",
    });
    expect(screen.getByRole("option", { name: "Dynamic" })).toHaveProperty("disabled", true);
    expect(screen.getByLabelText("Layout").getAttribute("aria-describedby")).toBe(
      "left-toolbar-help",
    );
    act(() => b.root.settingsStore.applyApplicationState(2, state));
    expect(b.root.settingsStore.appearance.leftToolbar.preferences).toEqual(store.preferences);
    act(() => b.root.settingsStore.applyApplicationState(1, defaultApplicationState()));
    expect(b.root.settingsStore.appearance.leftToolbar.preferences.autoHide).toBe(true);
    await act(async () => {
      await store.change({ layout: "slim" });
    });
    using reloaded = createRendererStoreFixture();
    reloaded.root.settingsStore.applyApplicationState(3, JSON.parse(JSON.stringify(state)));
    expect(reloaded.root.settingsStore.appearance.leftToolbar.preferences.layout).toBe("slim");
    expect(toSnapshot(a.root.projectRailStore).state).toEqual({});
    expect(toSnapshot(store).state).toEqual({});
    await act(async () => {
      fireEvent.click(screen.getByRole("switch", { name: "Auto-hide" }));
    });
    expect(store.preferences).toEqual({ autoHide: false, layout: "dynamic" });
  });

  it("serializes rapid toggles without persisting hover state", async () => {
    let persisted = defaultApplicationState();
    const calls: Array<() => void> = [];
    using f = createRendererStoreFixture({
      client: {
        workspaces: {
          setLeftToolbarPreferences: (change) =>
            new Promise((resolve) => {
              calls.push(() => {
                persisted = {
                  ...persisted,
                  leftToolbar: changeLeftToolbarPreferences(persisted.leftToolbar, change),
                };
                resolve(persisted);
              });
            }),
        },
      },
    });
    const store = f.root.settingsStore.appearance.leftToolbar;
    const first = store.change({ autoHide: true });
    const second = store.change({ autoHide: false });
    await Promise.resolve();
    expect(calls).toHaveLength(1);
    expect(store.preferences.layout).toBe("dynamic");
    calls[0]!();
    await first;
    await Promise.resolve();
    expect(calls).toHaveLength(2);
    calls[1]!();
    await second;
    expect(store.preferences).toEqual({ autoHide: false, layout: "dynamic" });
    expect(store.saving).toBe(false);
  });

  it("keeps newer live authority over a delayed unversioned save receipt", async () => {
    let finish!: (state: ReturnType<typeof defaultApplicationState>) => void;
    using f = createRendererStoreFixture({
      client: {
        workspaces: {
          setLeftToolbarPreferences: () =>
            new Promise((resolve) => {
              finish = resolve;
            }),
        },
      },
    });
    const store = f.root.settingsStore.appearance.leftToolbar;
    const save = store.change({ layout: "full" });
    await Promise.resolve();
    store.applyApplicationState(4, {
      ...defaultApplicationState(),
      leftToolbar: { autoHide: false, layout: "slim" },
    });
    finish({ ...defaultApplicationState(), leftToolbar: { autoHide: false, layout: "full" } });
    await save;
    expect(store.preferences.layout).toBe("slim");
  });

  it("rolls back a failed save and ignores completion after disposal", async () => {
    let finish!: (value: ReturnType<typeof defaultApplicationState>) => void;
    const save = vi.fn(
      () =>
        new Promise<ReturnType<typeof defaultApplicationState>>((resolve) => {
          finish = resolve;
        }),
    );
    const f = createRendererStoreFixture({
      client: { workspaces: { setLeftToolbarPreferences: save } },
    });
    const store = f.root.settingsStore.appearance.leftToolbar;
    const pending = store.change({ autoHide: true });
    await Promise.resolve();
    expect(store.preferences.layout).toBe("full");
    f[Symbol.dispose]();
    finish(defaultApplicationState());
    await pending;
    expect(store.preferences.autoHide).toBe(true);
    using failed = createRendererStoreFixture({
      client: {
        workspaces: {
          setLeftToolbarPreferences: async () => {
            throw new Error("disk full");
          },
        },
      },
    });
    await failed.root.settingsStore.appearance.leftToolbar.change({ autoHide: true });
    expect(failed.root.settingsStore.appearance.leftToolbar.preferences.autoHide).toBe(false);
    expect(failed.root.settingsStore.appearance.leftToolbar.error).toContain("disk full");
  });
});

describe("rail disclosure", () => {
  it("clears a fast edge pass even when the pointer never entered the revealed rail", () => {
    const reveal = vi.fn();
    const view = render(
      <NavigationRail
        autoHide
        layout="full"
        label="Test rail"
        header={null}
        footer={null}
        children={null}
        onRevealChange={reveal}
        onOverlayRightChange={() => {}}
      />,
    );
    const edge = view.container.querySelector('[data-slot="project-rail-edge"]')!;
    const nav = screen.getByRole("navigation");
    fireEvent.pointerEnter(edge);
    expect(reveal).toHaveBeenLastCalledWith(true);
    fireEvent(edge, new MouseEvent("pointerout", { bubbles: true, relatedTarget: document.body }));
    expect(reveal).toHaveBeenLastCalledWith(false);
    reveal.mockClear();
    fireEvent(edge, new MouseEvent("pointerout", { bubbles: true, relatedTarget: nav }));
    expect(reveal).not.toHaveBeenCalled();
  });
  it.each(["full", "slim", "dynamic"] as const)(
    "renders actual %s labels and holds focus independently of hover",
    (layout) => {
      const f = render(
        <NavigationRail
          layout={layout}
          label="Test rail"
          header={
            <IconButton tooltip="Action" label="Action">
              A
            </IconButton>
          }
          children={null}
          footer={null}
          onOverlayRightChange={() => {}}
        />,
      );
      const nav = screen.getByRole("navigation");
      expect(nav.dataset.expanded).toBe(String(layout === "full"));
      fireEvent.pointerEnter(nav);
      expect(nav.dataset.expanded).toBe(String(layout !== "slim"));
      fireEvent.focus(screen.getByRole("button", { name: "Action" }));
      fireEvent.pointerLeave(nav);
      expect(nav.dataset.expanded).toBe(String(layout !== "slim"));
      f.unmount();
    },
  );

  it("retains a portaled popover on pointer leave and releases it on disposal", () => {
    const right = vi.fn();
    const f = render(
      <NavigationRail
        autoHide
        layout="full"
        label="Test rail"
        header={
          <Popover>
            <PopoverIconTrigger tooltip="Menu" label="Menu">
              M
            </PopoverIconTrigger>
            <PopoverContent>
              <button type="button">Nested action</button>
            </PopoverContent>
          </Popover>
        }
        footer={null}
        children={null}
        onOverlayRightChange={right}
      />,
    );
    const nav = screen.getByRole("navigation");
    fireEvent.click(screen.getByRole("button", { name: "Menu" }));
    fireEvent.pointerLeave(nav);
    expect(nav.dataset.revealed).toBe("true");
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    f.unmount();
    expect(right).toHaveBeenLastCalledWith(0);
  });
});
