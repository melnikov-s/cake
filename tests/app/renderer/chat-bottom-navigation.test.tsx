/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  cakeNativeHotkeyInputEventName,
  defaultHotkeyBinding,
} from "../../../src/renderer/lib/hotkeys";
import { useAppHotkeys } from "../../../src/renderer/hooks/use-app-hotkeys";
import { createRendererStoreFixture } from "./renderer-store-fixture";

afterEach(cleanup);

it("routes a configured bottom action only to the focused chat, leaving text editors and native forwarding alone", () => {
  using fixture = createRendererStoreFixture();
  fixture.root.settingsStore.hotkeys.assign("scroll-to-bottom", "Alt+ArrowDown");
  const first = vi.fn();
  const second = vi.fn();
  const nested = vi.fn();
  const open = () => {};
  function Hotkeys() {
    useAppHotkeys(fixture.root, open);
    return null;
  }
  render(
    <>
      <Hotkeys />
      <textarea aria-label="Outside editor" />
      <div data-slot="chat">
        <div className="workbench-composer">
          <textarea role="combobox" aria-label="First composer" />
        </div>
        <textarea aria-label="Other editor" />
        <button data-chat-scroll-to-bottom onClick={first}>
          First bottom
        </button>
        <div data-slot="chat">
          <button data-chat-scroll-to-bottom onClick={nested}>
            Nested bottom
          </button>
        </div>
      </div>
      <div data-slot="chat">
        <button data-chat-scroll-to-bottom onClick={second}>
          Second bottom
        </button>
      </div>
    </>,
  );
  const press = (target: HTMLElement, extra = {}) =>
    fireEvent.keyDown(target, { key: "ArrowDown", code: "ArrowDown", altKey: true, ...extra });
  const input = screen.getByRole("combobox", { name: "First composer" });
  expect(press(input)).toBe(false);
  expect(first).toHaveBeenCalledTimes(1);
  expect(second).not.toHaveBeenCalled();
  expect(nested).not.toHaveBeenCalled();
  fireEvent.change(input, { target: { value: "Editing text" } });
  expect(press(input)).toBe(true);
  expect(press(screen.getByLabelText("Outside editor"))).toBe(true);
  expect(press(screen.getByLabelText("Other editor"))).toBe(true);
  expect(press(document.body)).toBe(true);
  expect(press(input, { isComposing: true })).toBe(true);
  expect(press(screen.getByRole("button", { name: "Second bottom" }))).toBe(false);
  expect(second).toHaveBeenCalledOnce();
  expect(press(screen.getByRole("button", { name: "Nested bottom" }))).toBe(false);
  expect(nested).toHaveBeenCalledOnce();
  window.dispatchEvent(
    new CustomEvent(cakeNativeHotkeyInputEventName, {
      cancelable: true,
      detail: {
        key: "ArrowDown",
        code: "ArrowDown",
        metaKey: false,
        ctrlKey: false,
        altKey: true,
        shiftKey: false,
        repeat: false,
        isComposing: false,
      },
    }),
  );
  expect(first).toHaveBeenCalledTimes(1);
  expect(second).toHaveBeenCalledOnce();
  expect(nested).toHaveBeenCalledOnce();
});

it("advertises the Mac-only default through the shared registry", () => {
  // jsdom's platform defaults to non-Mac; Electron verifies the native Mac binding and tooltip.
  expect(defaultHotkeyBinding("scroll-to-bottom")).toBe("");
});
