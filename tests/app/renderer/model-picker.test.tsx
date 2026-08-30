/**
 * @vitest-environment jsdom
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelOption } from "../../../src/ipc/session-contract";
import { ModelPicker, type ModelGroup } from "../../../src/renderer/components/model-picker";

function sampleModel(
  provider: string,
  providerName: string,
  id: string,
  name: string,
  availableThinkingLevels: ModelOption["availableThinkingLevels"] = ["off", "low", "high"],
  fastMode = true,
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

describe("ModelPicker", () => {
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

  const models: ModelOption[] = [
    sampleModel("openai", "OpenAI", "gpt-5", "GPT-5", ["off", "medium", "high"], false),
    sampleModel(
      "anthropic",
      "Anthropic",
      "claude-opus",
      "Claude Opus",
      ["low", "high", "max"],
      true,
    ),
  ];

  const groups: ModelGroup[] = [
    { id: "openai", name: "OpenAI", models: [models[0]!] },
    { id: "anthropic", name: "Anthropic", models: [models[1]!] },
  ];

  it("renders the active model summary and opens popover on click", () => {
    const onSelect = vi.fn();
    act(() =>
      root.render(
        <ModelPicker
          groups={groups}
          value={{ provider: "openai", modelId: "gpt-5", thinkingLevel: "medium" }}
          onSelect={onSelect}
        />,
      ),
    );

    const trigger = container.querySelector<HTMLButtonElement>("button")!;
    expect(trigger.textContent).toContain("GPT-5");
    expect(trigger.textContent).toContain("Medium reasoning");

    act(() => trigger.click());
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it("selects model and configures reasoning level", () => {
    const onSelect = vi.fn();
    act(() => root.render(<ModelPicker groups={groups} onSelect={onSelect} />));

    act(() => container.querySelector<HTMLButtonElement>("button")!.click());

    // Click Claude Opus in list
    const claudeBtn = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((btn) =>
      btn.textContent?.includes("Claude Opus"),
    )!;
    act(() => claudeBtn.click());

    // Select Max reasoning
    const maxBtn = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
      (btn) => btn.textContent === "Max",
    )!;
    act(() => maxBtn.click());

    // Click Apply
    const applyBtn = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
      (btn) => btn.textContent === "Apply",
    )!;
    act(() => applyBtn.click());

    expect(onSelect).toHaveBeenCalledWith({
      provider: "anthropic",
      modelId: "claude-opus",
      thinkingLevel: "max",
      fastMode: false,
    });
  });
});
