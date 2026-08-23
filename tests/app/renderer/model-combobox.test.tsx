/**
 * @vitest-environment jsdom
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelOption } from "../../../src/ipc/session-contract";
import { ModelCombobox, type ModelGroup } from "../../../src/renderer/components/model-combobox";

function model(provider: string, providerName: string, id: string, name: string): ModelOption {
  return {
    provider,
    providerName,
    id,
    name,
    authenticated: true,
    authTypes: [],
    input: ["text"],
    reasoning: true,
    availableThinkingLevels: ["off", "low", "medium", "high"],
  };
}

function disconnectedModel(
  provider: string,
  providerName: string,
  id: string,
  name: string,
): ModelOption {
  return {
    ...model(provider, providerName, id, name),
    authenticated: false,
    authTypes: ["api_key"],
  };
}

const groups: ModelGroup[] = [
  { id: "openai", name: "OpenAI", models: [model("openai", "OpenAI", "gpt-5.5", "GPT-5.5")] },
  {
    id: "anthropic",
    name: "Anthropic",
    models: [model("anthropic", "Anthropic", "claude-sonnet-4", "Claude Sonnet 4")],
  },
];

describe("ModelCombobox", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.assign(globalThis, {
      IS_REACT_ACT_ENVIRONMENT: true,
      requestAnimationFrame: (callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      },
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("searches across providers and selects the filtered model with Enter", () => {
    const onSelect = vi.fn();
    act(() =>
      root.render(
        <ModelCombobox
          ariaLabel="Model"
          groups={groups}
          value="openai/gpt-5.5"
          onSelect={onSelect}
        />,
      ),
    );
    const input = container.querySelector<HTMLInputElement>('[role="combobox"]')!;

    expect(input.value).toBe("GPT-5.5");
    act(() => input.click());
    expect(input.getAttribute("aria-expanded")).toBe("true");
    expect(input.placeholder).toBe("Search models…");

    act(() => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setValue.call(input, "anthropic");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(container.querySelector('[role="listbox"]')?.textContent).toContain("Claude Sonnet 4");
    expect(container.querySelector('[role="listbox"]')?.textContent).not.toContain("GPT-5.5");
    act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));

    expect(onSelect).toHaveBeenCalledWith("anthropic/claude-sonnet-4");
    expect(input.getAttribute("aria-expanded")).toBe("false");
  });

  it("never renders models from disconnected providers", () => {
    const mixedGroups: ModelGroup[] = [
      ...groups,
      {
        id: "nvidia",
        name: "NVIDIA",
        models: [
          disconnectedModel(
            "nvidia",
            "NVIDIA",
            "meta/llama-3.3-70b-instruct",
            "Llama 3.3 70b Instruct",
          ),
          disconnectedModel(
            "nvidia",
            "NVIDIA",
            "mistralai/mistral-medium-3.5-128b",
            "Mistral Medium 3.5",
          ),
        ],
      },
    ];
    act(() =>
      root.render(
        <ModelCombobox
          ariaLabel="Model"
          groups={mixedGroups}
          value="openai/gpt-5.5"
          onSelect={vi.fn()}
        />,
      ),
    );
    const input = container.querySelector<HTMLInputElement>('[role="combobox"]')!;

    act(() => input.click());

    const options = container.querySelector('[role="listbox"]')?.textContent ?? "";
    expect(options).toContain("GPT-5.5");
    expect(options).not.toContain("NVIDIA");
    expect(options).not.toContain("Llama");
    expect(options).not.toContain("Mistral");
    expect(options).not.toContain("Sign in");
  });
});
