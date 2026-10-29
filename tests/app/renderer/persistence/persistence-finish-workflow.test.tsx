/** @vitest-environment jsdom */
import { act, cleanup, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoreSnapshot } from "r-state-tree";
import type { Client } from "../../../../src/renderer/client/Client";
import { browserInitialSnapshot } from "../../../../src/renderer/bootstrap/browser-initial-snapshot";
import { WindowStatePersistence } from "../../../../src/renderer/persistence/WindowStatePersistence";
import { renderAppShellNavigation } from "../app-shell-navigation-fixture";

beforeEach(() => {
  vi.stubGlobal("PointerEvent", MouseEvent);
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
  vi.unstubAllGlobals();
});

const projectComposer = () => screen.getByPlaceholderText("Ask Cake to work in alpha…");
const openAlpha = () => screen.getByRole("button", { name: /^alpha conversation / });

describe("window presentation persistence workflows", () => {
  it.each([false, true])("starts a fresh browser (phone: %s)", async (phone) => {
    using fixture = renderAppShellNavigation(
      {},
      { snapshot: browserInitialSnapshot(undefined, phone) },
    );
    if (phone) {
      expect(await screen.findByRole("combobox", { name: "Message Cake Chat" })).toBeDefined();
      expect(screen.queryByRole("button", { name: /^alpha conversation / })).toBeNull();
      await fixture.user.click(screen.getByRole("button", { name: "Toggle sidebar" }));
    } else {
      expect(screen.getByRole("heading", { name: "What should we build?" })).toBeDefined();
    }
    await fixture.user.click(openAlpha());
    expect(await screen.findByPlaceholderText("Ask Cake to work in alpha…")).toBeDefined();
  });

  it.each([false, true])(
    "restores saved navigation and unsent input without losing the project when a phone starts in Cake Chat (phone: %s)",
    async (phone) => {
      let saved: StoreSnapshot = { state: {}, children: {} };
      const save = vi.fn<Client["windowState"]["save"]>(async (payload) => {
        // Round-trip the actual persistence payload as the external window-state authority does.
        saved = JSON.parse(JSON.stringify(payload));
      });
      const reportError = vi.fn();
      {
        using fixture = renderAppShellNavigation({ windowState: { save } });
        using persistence = new WindowStatePersistence(fixture.client, reportError);
        persistence.observe(fixture.root);
        await fixture.user.click(openAlpha());
        await fixture.user.type(projectComposer(), "Continue this unsent investigation");
        await fixture.user.click(screen.getAllByRole("button", { name: "Toggle sidebar" })[0]!);
        await fixture.user.click(screen.getAllByRole("button", { name: "Open settings" })[0]!);
        expect(await screen.findByText("Model configuration")).toBeDefined();
        // Window-close flushing is a lifecycle boundary, not an invented UI command.
        await act(async () => persistence.flush());
        expect(save).toHaveBeenCalled();
        expect(reportError).not.toHaveBeenCalled();
      }
      const before = structuredClone(saved);
      using restored = renderAppShellNavigation(
        {},
        { snapshot: browserInitialSnapshot(saved, phone) },
      );
      if (phone) {
        expect(await screen.findByRole("combobox", { name: "Message Cake Chat" })).toBeDefined();
        expect(screen.queryByRole("button", { name: /^alpha conversation / })).toBeNull();
        await restored.user.click(screen.getByRole("button", { name: "Toggle sidebar" }));
        await restored.user.click(openAlpha());
      } else {
        expect(await screen.findByText("Model configuration")).toBeDefined();
        await restored.user.click(screen.getByRole("button", { name: "Back to chat" }));
        expect(screen.queryByRole("button", { name: /^alpha conversation / })).toBeNull();
      }
      expect(await screen.findByPlaceholderText("Ask Cake to work in alpha…")).toHaveProperty(
        "value",
        "Continue this unsent investigation",
      );
      expect(saved).toEqual(before);
    },
  );
});
