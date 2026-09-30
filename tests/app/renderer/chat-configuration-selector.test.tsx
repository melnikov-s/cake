/**
 * @vitest-environment jsdom
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatConfigurationSelector } from "../../../src/renderer/components/chat-configuration-selector";
import { ModelOption } from "../../../src/renderer/models/ModelOption";
import { applyConversationSnapshot } from "../../../src/renderer/reducers/ConversationReducer";
import { configurationFixture } from "./chat-configuration-fixture";

describe("ChatConfigurationSelector with authoritative Conversation catalogs", () => {
  let container: HTMLDivElement;
  let root: Root;
  let fixture: ReturnType<typeof configurationFixture>;

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
    fixture = configurationFixture();
  });

  afterEach(() => {
    act(() => root.unmount());
    fixture.dispose();
    container.remove();
    vi.restoreAllMocks();
  });

  const button = (text: string) =>
    [
      ...(
        document.body.querySelector('[role="dialog"]') ?? document.body
      ).querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent?.includes(text))!;
  const trigger = () =>
    container.querySelector<HTMLButtonElement>('[aria-label="Model configuration"]')!;
  const render = () =>
    act(() => root.render(<ChatConfigurationSelector configuration={fixture.subject} />));

  it("switches closed current-model summaries without materializing or loading any catalog", async () => {
    const materialize = vi.spyOn(ModelOption.prototype, "value", "get");
    render();
    expect(trigger().textContent).toContain("GPT-5");
    expect(trigger().textContent).toContain("Medium");
    await act(async () => {
      fixture.state.session = fixture.second;
    });
    expect(trigger().textContent).toContain("Claude Opus");
    expect(trigger().textContent).toContain("High");
    await act(async () => {
      fixture.state.session = fixture.first;
    });
    expect(trigger().textContent).toContain("GPT-5");
    expect(materialize).not.toHaveBeenCalled();
    expect(fixture.list).not.toHaveBeenCalled();

    act(() => trigger().click());
    expect(materialize).toHaveBeenCalledTimes(2);
    expect(document.body.querySelector('[aria-label="Reasoning effort"]')!.textContent).toContain(
      "Medium",
    );
    act(() => button("Change model").click());
    const dialog = document.body.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("GPT-5");
    expect(dialog.textContent).toContain("Claude Opus");
    expect(dialog.textContent).toContain("Deep review");
    expect(dialog.textContent).not.toContain("Disconnected model");
    expect(materialize).toHaveBeenCalledTimes(2);
  });

  it("shows the active preset, reasoning and Fast mode without catalog reads", () => {
    applyConversationSnapshot(fixture.first, {
      ...fixture.snapshot,
      model: { provider: fixture.preset.provider, id: fixture.preset.modelId, name: "Claude Opus" },
      thinkingLevel: "max",
      availableThinkingLevels: ["low", "high", "xhigh", "max"],
      fastMode: true,
      fastModeAvailable: true,
    });
    const materialize = vi.spyOn(ModelOption.prototype, "value", "get");
    render();
    expect(trigger().textContent).toContain("Deep review");
    expect(trigger().textContent).toContain("Max");
    expect(trigger().textContent).toContain("Fast");
    expect(materialize).not.toHaveBeenCalled();
    act(() => trigger().click());
    act(() => button("Change model").click());
    expect(button("Deep review").getAttribute("aria-current")).toBe("page");
    act(() => button("Deep review").click());
    expect(fixture.setConfiguration).toHaveBeenCalledWith(fixture.preset);
  });

  it("changes reasoning for the current model in two clicks, without refetching", () => {
    render();
    act(() => trigger().click());
    act(() => button("High").click());
    expect(fixture.setThinkingLevel).toHaveBeenCalledWith("high");
    expect(fixture.list).not.toHaveBeenCalled();
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  it("uses chosen model capabilities before applying", () => {
    render();
    act(() => trigger().click());
    act(() => button("Change model").click());
    act(() => button("Claude Opus").click());
    const reasoning = document.body.querySelector('[aria-label="Reasoning level"]')!;
    expect(reasoning.textContent).toContain("Xhigh");
    expect(reasoning.textContent).toContain("Max");
    expect(reasoning.textContent).not.toContain("Medium");
    act(() => {
      button("Xhigh").click();
      document.body.querySelector<HTMLButtonElement>('[role="switch"]')!.click();
    });
    act(() => button("Apply").click());
    expect(fixture.setConfiguration).toHaveBeenCalledWith({
      provider: "anthropic",
      modelId: "claude-opus",
      thinkingLevel: "xhigh",
      fastMode: true,
    });
  });

  it("updates an open list on catalog and authentication changes and defers closed work", async () => {
    render();
    act(() => trigger().click());
    act(() => button("Change model").click());
    await act(async () => {
      fixture.first.modelOptions[2]!.authenticated = true;
    });
    expect(button("Disconnected model")).toBeDefined();
    await act(async () => {
      applyConversationSnapshot(fixture.first, {
        ...fixture.snapshot,
        models: [fixture.snapshot.models[0]!],
      });
    });
    expect(document.body.querySelector('[role="dialog"]')!.textContent).not.toContain(
      "Claude Opus",
    );
    act(() => trigger().click());
    const materialize = vi.spyOn(ModelOption.prototype, "value", "get");
    await act(async () => {
      applyConversationSnapshot(fixture.first, fixture.snapshot);
    });
    expect(materialize).not.toHaveBeenCalled();
    act(() => trigger().click());
    act(() => button("Change model").click());
    expect(button("Claude Opus")).toBeDefined();
    expect(materialize).toHaveBeenCalledTimes(2);
  });

  it("loads a deferred catalog once per genuine opening, not on inner selection clicks", async () => {
    fixture.dispose();
    fixture = configurationFixture(true);
    render();
    expect(fixture.list).not.toHaveBeenCalled();
    await act(async () => trigger().click());
    expect(fixture.list).toHaveBeenCalledOnce();
    act(() => button("Claude Opus").click());
    act(() => button("Xhigh").click());
    act(() => document.body.querySelector<HTMLButtonElement>('[role="switch"]')!.click());
    act(() => button("Apply").click());
    expect(fixture.state.pending).toEqual({
      provider: "anthropic",
      modelId: "claude-opus",
      thinkingLevel: "xhigh",
      fastMode: true,
    });
    expect(fixture.list).toHaveBeenCalledOnce();
    expect(trigger().textContent).toContain("Claude Opus");
    expect(trigger().textContent).toContain("Xhigh");
    expect(trigger().textContent).toContain("Fast");
    expect(fixture.setConfiguration).not.toHaveBeenCalled();
    await act(async () => trigger().click());
    expect(fixture.list).toHaveBeenCalledTimes(2);
    expect(document.body.querySelector('[aria-label="Reasoning effort"]')!.textContent).toContain(
      "Xhigh",
    );
  });
});
