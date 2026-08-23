/**
 * @vitest-environment jsdom
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelOption } from "../../../src/ipc/session-contract";
import { ChatConfigurationSelector } from "../../../src/renderer/components/chat-configuration-selector";
import type { ChatConfigurationStore } from "../../../src/renderer/stores/ChatConfigurationStore";

function model(
  provider: string,
  providerName: string,
  id: string,
  name: string,
  availableThinkingLevels: ModelOption["availableThinkingLevels"],
  fastMode = false,
): ModelOption {
  return {
    provider,
    providerName,
    id,
    name,
    reasoning: availableThinkingLevels.some((level) => level !== "off"),
    availableThinkingLevels,
    fastMode,
    input: ["text"],
    authenticated: true,
    authTypes: [],
  };
}

describe("ChatConfigurationSelector", () => {
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

  function configuration() {
    const current = model("openai", "OpenAI", "gpt-5", "GPT-5", ["off", "medium", "high"], false);
    const next = model(
      "anthropic",
      "Anthropic",
      "claude-opus",
      "Claude Opus",
      ["low", "high", "xhigh", "max"],
      true,
    );
    return {
      session: {
        model: { provider: current.provider, id: current.id, name: current.name },
        thinkingLevel: "medium",
        availableThinkingLevels: current.availableThinkingLevels,
        fastModeAvailable: false,
        streaming: false,
      },
      activeOperations: [],
      activePreset: undefined,
      presets: [],
      fastMode: false,
      connectedModelsByProvider: [
        { id: "openai", name: "OpenAI", models: [current] },
        { id: "anthropic", name: "Anthropic", models: [next] },
      ],
      selectThinkingLevel: vi.fn(async () => undefined),
      selectFastMode: vi.fn(async () => undefined),
      selectConfiguration: vi.fn(async () => undefined),
      selectPreset: vi.fn(async () => undefined),
      openPresetSettings: vi.fn(),
    } as unknown as ChatConfigurationStore;
  }

  it("changes reasoning for the current model in two clicks", () => {
    const store = configuration();
    act(() => root.render(<ChatConfigurationSelector configuration={store} />));

    act(() =>
      container.querySelector<HTMLButtonElement>('[aria-label="Model configuration"]')!.click(),
    );
    const high = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "High",
    )!;
    act(() => high.click());

    expect(store.selectThinkingLevel).toHaveBeenCalledWith("high");
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  it("uses the chosen model's reasoning and Fast mode capabilities before applying", () => {
    const store = configuration();
    act(() => root.render(<ChatConfigurationSelector configuration={store} />));

    act(() =>
      container.querySelector<HTMLButtonElement>('[aria-label="Model configuration"]')!.click(),
    );
    act(() => {
      const changeModel = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent?.includes("Change model"),
      )!;
      changeModel.click();
    });
    act(() => {
      const claude = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent?.includes("Claude Opus"),
      )!;
      claude.click();
    });

    const reasoning = document.body.querySelector('[aria-label="Reasoning level"]')!;
    expect(reasoning.textContent).toContain("Xhigh");
    expect(reasoning.textContent).toContain("Max");
    expect(reasoning.textContent).not.toContain("Medium");

    act(() => {
      const xhigh = [...reasoning.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent === "Xhigh",
      )!;
      xhigh.click();
      document.body.querySelector<HTMLButtonElement>('[role="switch"]')!.click();
    });
    act(() => {
      const apply = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent === "Apply",
      )!;
      apply.click();
    });

    expect(store.selectConfiguration).toHaveBeenCalledWith({
      provider: "anthropic",
      modelId: "claude-opus",
      thinkingLevel: "xhigh",
      fastMode: true,
    });
  });
});
