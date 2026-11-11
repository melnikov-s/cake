/** @vitest-environment jsdom */
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createStore, mount } from "r-state-tree";
import { StoreProvider } from "r-state-tree/react";
import { afterEach, describe, expect, it } from "vitest";
import type {
  CaptureDestination,
  CapturePreferences,
  CaptureSessionOption,
} from "../../../src/contracts/desktop/screen-capture-data";
import { CaptureDestinationPicker } from "../../../src/renderer/components/capture-destination-picker";
import { CaptureDestinationPickerStore } from "../../../src/renderer/stores/CaptureDestinationPickerStore";

const mounted: Disposable[] = [];
afterEach(() => {
  cleanup();
  for (const store of mounted.splice(0)) store[Symbol.dispose]();
});

const session = (sessionId: string): CaptureSessionOption => ({
  sessionId,
  title: `Session ${sessionId}`,
  modifiedAt: "2026-01-01T00:00:00.000Z",
  activityTime: "2026-01-01T00:00:00.000Z",
  labels: [],
});

// Only the fields the picker reads; native capture settings are irrelevant to disclosure.
const routing = {
  projects: [
    { path: "/a", name: "Project A", sessions: [session("a1")], chatSessionId: "chat-a" },
    { path: "/b", name: "Project B", sessions: [session("b1"), session("b2")] },
    { path: "/c", name: "Project C", sessions: [session("c1")] },
  ],
  cakeChats: [session("global"), session("chat-a")],
  appearance: {
    theme: "light",
    projectAvatarsEnabled: false,
    sessionAvatarsEnabled: false,
    sidebarCharactersEnabled: false,
  },
} as unknown as CapturePreferences;

function renderPicker(destination?: CaptureDestination) {
  const store = mount(
    createStore(CaptureDestinationPickerStore, {
      routing: () => (destination ? { ...routing, defaultDestination: destination } : routing),
    }),
  );
  mounted.push(store);
  render(
    <StoreProvider store={store}>
      <CaptureDestinationPicker disabled={false} />
    </StoreProvider>,
  );
  const user = userEvent.setup();
  return {
    store,
    user,
    async open() {
      await user.click(screen.getByRole("button", { name: "Screenshot destination" }));
      return screen.getByRole("dialog", { name: "Screenshot destination" });
    },
  };
}

function expandedProjects(menu: HTMLElement) {
  return within(menu)
    .getAllByRole("region")
    .filter(
      (region) =>
        within(region).getByRole("button", { name: /^(Expand|Collapse) / }).ariaExpanded === "true",
    )
    .map((region) => region.getAttribute("aria-label"));
}

describe("capture destination picker project disclosure", () => {
  it("opens with every project collapsed when nothing is selected", async () => {
    const picker = renderPicker();
    const menu = await picker.open();
    expect(expandedProjects(menu)).toEqual([]);
    expect(menu.querySelector("[data-session-id]")).toBeNull();
  });

  it("expands only the project containing the selected session", async () => {
    const picker = renderPicker({ kind: "project-session", sessionId: "b2" });
    const menu = await picker.open();
    expect(expandedProjects(menu)).toEqual(["Project B"]);
    expect(
      [...menu.querySelectorAll("[data-session-id]")].map((row) =>
        row.getAttribute("data-session-id"),
      ),
    ).toEqual(["b1", "b2"]);
  });

  it("expands only the project whose Project Chat is selected", async () => {
    const menu = await renderPicker({ kind: "cake-chat", sessionId: "chat-a" }).open();
    expect(expandedProjects(menu)).toEqual(["Project A"]);
  });

  it("keeps every project collapsed when a global Cake Chat is selected", async () => {
    const menu = await renderPicker({ kind: "cake-chat", sessionId: "global" }).open();
    expect(expandedProjects(menu)).toEqual([]);
  });

  it("keeps hand toggles, retains them on reopen, and lets untouched projects follow a new selection", async () => {
    const picker = renderPicker({ kind: "project-session", sessionId: "b1" });
    let menu = await picker.open();
    await picker.user.click(within(menu).getByRole("button", { name: "Expand Project C" }));
    await picker.user.click(within(menu).getByRole("button", { name: "Collapse Project B" }));
    expect(expandedProjects(menu)).toEqual(["Project C"]);
    await picker.user.click(screen.getByRole("button", { name: "Screenshot destination" }));
    menu = await picker.open();
    expect(expandedProjects(menu)).toEqual(["Project C"]);
    await picker.user.click(screen.getByRole("button", { name: "Screenshot destination" }));
    act(() => picker.store.select({ kind: "project-session", sessionId: "a1" }));
    menu = await picker.open();
    expect(expandedProjects(menu)).toEqual(["Project A", "Project C"]);
  });
});
