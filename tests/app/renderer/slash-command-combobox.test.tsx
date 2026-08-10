/**
 * @vitest-environment jsdom
 */
import { act, useState } from "react";
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
    const onSubmit = vi.fn();
    act(() => root.render(<SlashCommandCombobox aria-label="Message" commands={[command("help"), command("models"), command("settings")]} value="/" onValueChange={onValueChange} onSubmit={onSubmit} />));
    const input = container.querySelector<HTMLTextAreaElement>('[role="combobox"]')!;

    expect(input.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector('[role="option"][aria-selected="true"]')?.textContent).toContain("help");

    act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    expect(container.querySelector('[role="option"][aria-selected="true"]')?.textContent).toContain("models");

    act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(onValueChange).toHaveBeenCalledWith("/models");
    expect(onSubmit).toHaveBeenCalledWith("/models");
  });

  it.each(["Tab", "ArrowLeft", "ArrowRight"])("autocompletes with %s without submitting", (key) => {
    const onSubmit = vi.fn();
    function ControlledCombobox() {
      const [value, setValue] = useState("/");
      return <SlashCommandCombobox aria-label="Message" commands={[command("help"), command("models")]} value={value} onValueChange={setValue} onSubmit={onSubmit} />;
    }
    act(() => root.render(<ControlledCombobox />));
    const input = container.querySelector<HTMLTextAreaElement>('[role="combobox"]')!;

    act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })));
    expect(input.value).toBe("/models ");
    expect(input.getAttribute("aria-expanded")).toBe("false");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("submits with Enter when the command menu is closed", () => {
    const onSubmit = vi.fn();
    act(() => root.render(<SlashCommandCombobox aria-label="Message" commands={[command("help")]} value="hello" onValueChange={vi.fn()} onSubmit={onSubmit} />));
    const input = container.querySelector<HTMLTextAreaElement>('[role="combobox"]')!;

    act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it("renders Pi CLI built-ins with their argument hints", () => {
    const builtin: SlashCommand = { name: "model", description: "Select model", argumentHint: "<provider/model>", source: "builtin", sourceInfo: { path: "builtin:pi-cli", source: "Pi CLI", scope: "temporary", origin: "top-level" } };
    act(() => root.render(<SlashCommandCombobox aria-label="Message" commands={[builtin]} value="/" onValueChange={vi.fn()} onSubmit={vi.fn()} />));

    expect(container.querySelector('[role="option"]')?.textContent).toContain("/model <provider/model>");
    expect(container.querySelector('[role="option"]')?.textContent).toContain("Pi CLI");
  });
});
