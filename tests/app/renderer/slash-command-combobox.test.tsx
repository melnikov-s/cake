/**
 * @vitest-environment jsdom
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionSnapshot } from "../../../src/ipc/session-contract";
import { SlashCommandCombobox } from "../../../src/renderer/components/slash-command-combobox";

type SlashCommand = SessionSnapshot["commands"][number];

function command(name: string): SlashCommand {
  return { name, description: `${name} description`, source: "extension", sourceInfo: { path: "/extension", source: "test", scope: "project", origin: "top-level" } };
}

describe("SlashCommandCombobox", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.assign(globalThis, {
      IS_REACT_ACT_ENVIRONMENT: true,
      requestAnimationFrame: (callback: FrameRequestCallback) => { callback(0); return 1; }
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("moves through commands with arrow keys and selects the active command with Enter", () => {
    const onValueChange = vi.fn();
    act(() => root.render(<SlashCommandCombobox aria-label="Message" commands={[command("help"), command("models"), command("settings")]} value="/" onValueChange={onValueChange} onSubmit={vi.fn()} />));
    const input = container.querySelector<HTMLTextAreaElement>('[role="combobox"]')!;

    expect(input.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector('[role="option"][aria-selected="true"]')?.textContent).toContain("help");

    act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    expect(container.querySelector('[role="option"][aria-selected="true"]')?.textContent).toContain("models");

    act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(onValueChange).toHaveBeenCalledWith("/models ");
  });

  it("submits with Enter when the command menu is closed", () => {
    const onSubmit = vi.fn();
    act(() => root.render(<SlashCommandCombobox aria-label="Message" commands={[command("help")]} value="hello" onValueChange={vi.fn()} onSubmit={onSubmit} />));
    const input = container.querySelector<HTMLTextAreaElement>('[role="combobox"]')!;

    act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(onSubmit).toHaveBeenCalledOnce();
  });
});
