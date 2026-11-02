/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTabInputFocus } from "../../../src/renderer/hooks/use-tab-input-focus";

function FocusShortcut() {
  useTabInputFocus();
  return null;
}

function press(target: HTMLElement, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", {
    key: "Tab",
    bubbles: true,
    cancelable: true,
    ...options,
  });
  target.dispatchEvent(event);
  return event;
}

function chat(label: string) {
  const element = document.createElement("section");
  element.dataset.slot = "chat";
  element.dataset.composerFocusEnabled = "true";
  element.innerHTML = `<button>${label}</button><div data-slot="composer-input"><textarea aria-label="${label}"></textarea></div>`;
  document.body.append(element);
  return {
    element,
    input: element.querySelector("textarea")!,
    button: element.querySelector("button")!,
  };
}

function popup(content: string) {
  const element = document.createElement("div");
  element.setAttribute("role", "dialog");
  element.setAttribute("aria-modal", "true");
  element.innerHTML = content;
  document.body.append(element);
  return element;
}

describe("Tab input focus ownership", () => {
  let root: Root;
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(
      function (this: HTMLElement) {
        return (this.hidden ? [] : [{}]) as unknown as DOMRectList;
      },
    );
    const mount = document.createElement("div");
    document.body.append(mount);
    root = createRoot(mount);
    act(() => root.render(<FocusShortcut />));
  });
  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("focuses the composer and retains existing writing focus and selection", () => {
    const main = chat("Main");
    expect(press(document.body).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(main.input);
    main.input.value = "draft";
    main.input.setSelectionRange(1, 3);
    press(main.input);
    expect(document.activeElement).toBe(main.input);
    expect(main.input.value).toBe("draft");
    expect([main.input.selectionStart, main.input.selectionEnd]).toEqual([1, 3]);
  });

  it("remembers the active side chat, then falls back when it closes or its split loses focus", () => {
    const main = chat("Main");
    const side = chat("Side");
    side.button.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    press(document.body);
    expect(document.activeElement).toBe(side.input);
    side.element.remove();
    press(document.body);
    expect(document.activeElement).toBe(main.input);
    const split = chat("Split");
    main.element.dataset.composerFocusEnabled = "false";
    press(main.input);
    expect(document.activeElement).toBe(split.input);
  });

  it("prioritizes the top popup's editable input and restores the prior chat after close", () => {
    chat("Main");
    const side = chat("Side");
    side.button.focus();
    const lower = popup('<input aria-label="Lower" />');
    const upper = popup(
      '<input disabled /><input readonly /><input aria-label="Upper" /><button>Close</button>',
    );
    upper.querySelector("button")!.focus();
    press(upper.querySelector("button")!);
    expect(document.activeElement).toBe(upper.querySelector('[aria-label="Upper"]'));
    upper.remove();
    press(document.body);
    expect(document.activeElement).toBe(lower.querySelector("input"));
    lower.remove();
    press(document.body);
    expect(document.activeElement).toBe(side.input);
  });

  it("remembers a side-chat pointer intent before its split becomes active", () => {
    const oldPane = chat("Old pane");
    const nextMain = chat("Next main");
    const nextSide = chat("Next side");
    nextMain.element.dataset.composerFocusEnabled = "false";
    nextSide.element.dataset.composerFocusEnabled = "false";
    nextSide.button.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    oldPane.element.dataset.composerFocusEnabled = "false";
    nextMain.element.dataset.composerFocusEnabled = "true";
    nextSide.element.dataset.composerFocusEnabled = "true";
    press(document.body);
    expect(document.activeElement).toBe(nextSide.input);
  });

  it("prioritizes the higher overlay band over a later fullscreen reader", () => {
    chat("Main");
    const overlay = popup("<input />");
    overlay.style.zIndex = "50";
    const reader = popup("<button>Exit</button>");
    reader.style.zIndex = "45";
    reader.querySelector("button")!.focus();
    press(document.body);
    expect(document.activeElement).toBe(overlay.querySelector("input"));
  });

  it("ignores hidden/exiting popups and keeps an input-less modal's focus inside", () => {
    const main = chat("Main");
    const modal = popup("<button>Cancel</button><button>Confirm</button>");
    const button = modal.querySelector("button")!;
    button.focus();
    press(button);
    expect(document.activeElement).toBe(button);
    main.button.focus();
    press(main.button);
    expect(document.activeElement).toBe(button);
    modal.setAttribute("inert", "");
    press(document.body);
    expect(document.activeElement).toBe(main.input);
    modal.removeAttribute("inert");
    modal.hidden = true;
    main.input.blur();
    press(document.body);
    expect(document.activeElement).toBe(main.input);
  });

  it.each([
    { ctrlKey: true },
    { metaKey: true },
    { altKey: true },
    { shiftKey: true },
    { isComposing: true },
    { keyCode: 229 },
  ])("does not claim modified Tab or IME: %j", (options) => {
    const main = chat("Main");
    main.button.focus();
    expect(press(main.button, options).defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(main.button);
  });

  it.each(["xterm", "monaco-editor", "cm-editor"])("leaves %s editing in control", (className) => {
    chat("Main");
    const editor = document.createElement("div");
    editor.className = className;
    editor.innerHTML = "<textarea></textarea>";
    document.body.append(editor);
    const input = editor.querySelector("textarea")!;
    input.focus();
    expect(press(input).defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(input);
  });

  it("leaves embedded frame and shortcut-recorder Tab ownership intact", () => {
    chat("Main");
    const frame = document.createElement("iframe");
    document.body.append(frame);
    expect(press(frame).defaultPrevented).toBe(false);
    const recorder = document.createElement("button");
    recorder.dataset.slot = "hotkey-recorder";
    document.body.append(recorder);
    expect(press(recorder).defaultPrevented).toBe(false);
  });
});
