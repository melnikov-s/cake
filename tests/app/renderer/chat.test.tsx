/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createStore, mount } from "r-state-tree";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Chat } from "../../../src/renderer/components/chat";
import type { ChatConfigurationStore } from "../../../src/renderer/stores/ChatConfigurationStore";
import { ChatStore } from "../../../src/renderer/stores/ChatStore";

describe("Chat", () => {
  let container: HTMLDivElement;
  let root: Root;
  let store: ChatStore | undefined;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    store?.[Symbol.dispose]();
    container.remove();
  });

  it("renders the shared transcript, loading state, configuration, and composer actions", async () => {
    const submit = vi.fn(async () => true);
    const configuration = {
      session: {
        model: { provider: "openai", id: "gpt" },
        thinkingLevel: "medium",
        availableThinkingLevels: ["off", "medium"]
      },
      connectedModelsByProvider: [{ id: "openai", name: "OpenAI", models: [{ provider: "openai", id: "gpt", name: "GPT", authenticated: true }] }],
      selectModel: vi.fn(),
      selectThinkingLevel: vi.fn()
    } as unknown as ChatConfigurationStore;
    store = mount(createStore(ChatStore, {
      id: () => "shared-chat",
      parts: () => [{ id: "question", kind: "text", role: "user", text: "Can you check this?", status: "complete" }],
      streaming: () => true,
      submitting: () => false,
      configuration: () => configuration,
      commands: () => [],
      placeholder: () => "Ask a follow-up…",
      inputLabel: () => "Reply to chat",
      canSubmit: (draft) => Boolean(draft.trim()),
      submit
    }));

    act(() => root.render(<Chat store={store!} />));

    expect(container.textContent).toContain("Can you check this?");
    expect(container.querySelector('[aria-label="Cake is working"]')).not.toBeNull();
    expect(container.querySelector<HTMLInputElement>('[aria-label="Model"]')?.value).toBe("GPT");
    expect(container.querySelector<HTMLSelectElement>('[aria-label="Thinking level"]')?.value).toBe("medium");

    const input = container.querySelector<HTMLTextAreaElement>('[aria-label="Reply to chat"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "Please continue");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => container.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());

    expect(submit).toHaveBeenCalledWith("Please continue", "send");
    expect(store.draft).toBe("");
  });
});
