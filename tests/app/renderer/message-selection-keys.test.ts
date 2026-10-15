/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import { messageSelectionKeyAction } from "../../../src/renderer/lib/message-selection-keys";

afterEach(() => document.body.replaceChildren());

function pane() {
  document.body.innerHTML = `
    <div data-slot="chat" id="pane">
      <div id="transcript"><p id="prose">Answer</p>
        <div role="radiogroup"><button id="radio">A</button></div>
        <input id="search" />
        <div data-slot="chat" id="nested"><p id="nested-prose">Side</p></div>
      </div>
      <textarea id="composer"></textarea>
    </div>
    <div data-slot="chat" id="other"><p id="other-prose">Other</p></div>`;
  const get = <T extends Element>(id: string) => document.getElementById(id) as unknown as T;
  return { pane: get<HTMLElement>("pane"), composer: get<HTMLTextAreaElement>("composer"), get };
}

function key(target: Element, key: string, modifiers: Partial<KeyboardEvent> = {}) {
  return {
    key,
    target,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    isComposing: false,
    defaultPrevented: false,
    ...modifiers,
  };
}

describe("messageSelectionKeyAction", () => {
  it("maps the keys in transcript content", () => {
    const { pane: root, composer, get } = pane();
    const context = { pane: root, composerInput: composer, hasSelection: false };
    const prose = get("prose");
    expect(messageSelectionKeyAction(key(prose, "ArrowUp"), context)).toBe("select-previous");
    expect(messageSelectionKeyAction(key(prose, "ArrowDown"), context)).toBeUndefined();
    expect(messageSelectionKeyAction(key(prose, "Escape"), context)).toBeUndefined();
    const selected = { ...context, hasSelection: true };
    expect(messageSelectionKeyAction(key(prose, "ArrowDown"), selected)).toBe("select-next");
    expect(messageSelectionKeyAction(key(prose, "Escape"), selected)).toBe("clear");
  });

  it("takes composer arrows only while it is empty, but Escape whenever selected", () => {
    const { pane: root, composer } = pane();
    const context = { pane: root, composerInput: composer, hasSelection: true };
    expect(messageSelectionKeyAction(key(composer, "ArrowUp"), context)).toBe("select-previous");
    composer.value = "draft";
    expect(messageSelectionKeyAction(key(composer, "ArrowUp"), context)).toBeUndefined();
    expect(messageSelectionKeyAction(key(composer, "ArrowDown"), context)).toBeUndefined();
    expect(messageSelectionKeyAction(key(composer, "Escape"), context)).toBe("clear");
  });

  it("leaves keys to other fields, arrow widgets, nested chats, and other panes", () => {
    const { pane: root, composer, get } = pane();
    const context = { pane: root, composerInput: composer, hasSelection: true };
    for (const id of ["search", "radio", "nested-prose", "other-prose"])
      expect(messageSelectionKeyAction(key(get(id), "ArrowUp"), context)).toBeUndefined();
  });

  it("never takes modified, composing, or already handled keys", () => {
    const { pane: root, composer, get } = pane();
    const context = { pane: root, composerInput: composer, hasSelection: true };
    const prose = get("prose");
    for (const modifiers of [
      { altKey: true },
      { ctrlKey: true },
      { metaKey: true },
      { shiftKey: true },
      { isComposing: true },
      { defaultPrevented: true },
    ])
      expect(messageSelectionKeyAction(key(prose, "ArrowUp", modifiers), context)).toBeUndefined();
  });
});
