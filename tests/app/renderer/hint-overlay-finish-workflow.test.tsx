/** @vitest-environment jsdom */
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RendererRoot } from "../../../src/renderer/components/renderer-root";
import { formatHotkey } from "../../../src/renderer/lib/hotkeys";
import { applyConversationUpdate } from "../../../src/renderer/reducers/ConversationReducer";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";

function renderHintOverlayFinish() {
  const fixture = createRendererStoreFixture({
    projects: [projectRecord({ path: "/project", name: "Project" })],
    sessions: [
      sessionSummary({
        sessionId: "hint-session",
        projectPath: "/project",
        title: "Hint conversation",
      }),
    ],
  });
  fixture.root.settingsStore.hotkeys.bindings = { "toggle-sidebar": "Mod+Shift+B" };
  const session = fixture.root.sessionRegistry.load("hint-session", "/project");
  applyConversationUpdate(session.model, {
    _tag: "Snapshot",
    revision: 1,
    snapshot: {
      sessionId: session.sessionId,
      sessionFile: "/project/hint-session.jsonl",
      parts: [],
      models: [],
      thinkingLevel: "off",
      availableThinkingLevels: ["off"],
      streaming: false,
      diagnostics: [],
      commands: [],
      compatibility: { resources: [], diagnostics: [] },
      extensionUi: { statuses: [] },
      tree: [],
    },
  });
  fixture.root.navigationStore.showLoadedProjectSession(session.sessionId);
  const view = render(
    <RendererRoot
      rootStore={fixture.root}
      openExternalUrl={(url) => void fixture.root.openExternalUrl(url)}
      openSession={(id, messageId, attachmentId) =>
        void fixture.root.navigationStore.openSessionLink(id, messageId, attachmentId)
      }
    />,
  );
  return {
    user: userEvent.setup(),
    deliverHintCommand() {
      // Same application-command ingress as the desktop keyboard/menu bridge.
      // This proves composition/policy, not native shortcut delivery or geometry.
      act(() => fixture.root.commands.execute("show-ui-hints"));
    },
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(20, 20, 100, 30),
  );
  Object.defineProperty(SVGElement.prototype, "getBBox", {
    configurable: true,
    value: () => ({ x: 0, y: 0, width: 24, height: 24 }),
  });
  vi.stubGlobal("matchMedia", (query: string): MediaQueryList => ({
    media: query,
    matches: query === "(prefers-reduced-motion: reduce)",
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => true,
  }));
});
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(SVGElement.prototype, "getBBox");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("uses a real static hint to toggle the sidebar while reserving its prefix from dynamic session hints", async () => {
  using fixture = renderHintOverlayFinish();
  fixture.deliverHintCommand();
  const sidebarToggle = document.querySelector<HTMLElement>('[data-cake-hint-label="s"]');
  expect(sidebarToggle?.getAttribute("aria-label")).toBe("Toggle sidebar");
  const session = screen.getByRole("button", { name: /^Hint conversation / });
  expect(session.getAttribute("data-cake-hint-label")).toHaveLength(2);
  expect(session.getAttribute("data-cake-hint-label")).not.toMatch(/^s/);
  await fixture.user.keyboard("s");
  expect(document.querySelector('[data-slot="sidebar"]')).toBeNull();
  expect(document.querySelector('[data-slot="ui-hint-overlay"]')).toBeNull();
  expect(sidebarToggle?.hasAttribute("data-cake-hint-target")).toBe(false);
});

it("updates real toolbar tooltip shortcuts when Settings clears and resets the binding, without renaming the control", async () => {
  using fixture = renderHintOverlayFinish();
  const toggle = () => screen.getAllByRole("button", { name: "Toggle sidebar" })[0]!;
  await fixture.user.hover(toggle());
  expect((await screen.findByRole("tooltip")).textContent).toBe(
    `Toggle sidebar (${formatHotkey("Mod+Shift+B")})`,
  );
  expect(toggle().getAttribute("aria-label")).toBe("Toggle sidebar");
  await fixture.user.unhover(toggle());
  const openHotkeys = async () => {
    await fixture.user.click(screen.getAllByRole("button", { name: "Open settings" })[0]!);
    await fixture.user.click(screen.getByRole("button", { name: /^Hotkeys(?: |$)/ }));
    const recorder = screen.getByRole("button", { name: "Toggle sidebar shortcut" });
    const group = recorder.parentElement;
    if (!group) throw new Error("Missing shortcut controls");
    return within(group);
  };
  const cleared = await openHotkeys();
  await fixture.user.click(cleared.getByRole("button", { name: "Clear" }));
  await fixture.user.click(screen.getByRole("button", { name: "Back to chat" }));
  await fixture.user.hover(toggle());
  expect((await screen.findByRole("tooltip")).textContent).toBe("Toggle sidebar");
  await fixture.user.unhover(toggle());
  const reset = await openHotkeys();
  await fixture.user.click(reset.getByRole("button", { name: "Reset" }));
  await fixture.user.click(screen.getByRole("button", { name: "Back to chat" }));
  await fixture.user.hover(toggle());
  expect((await screen.findByRole("tooltip")).textContent).toBe(
    `Toggle sidebar (${formatHotkey("Mod+B")})`,
  );
  expect(toggle().getAttribute("aria-label")).toBe("Toggle sidebar");
});
