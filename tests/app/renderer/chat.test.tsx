/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createStore, mount } from "r-state-tree";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/ai-elements/conversation", async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    "@/components/ai-elements/conversation",
  );
  const ReactModule = await import("react");
  return {
    ...actual,
    VirtualizedConversation: ReactModule.forwardRef(function TestVirtualizedConversation(
      {
        data,
        itemContent,
      }: {
        data: Array<{ id: string }>;
        itemContent(index: number, item: { id: string }): React.ReactNode;
      },
      ref,
    ) {
      ReactModule.useImperativeHandle(ref, () => ({ scrollToIndex: vi.fn() }));
      return (
        <div className="transcript">
          {data.map((item, index) => (
            <React.Fragment key={item.id}>{itemContent(index, item)}</React.Fragment>
          ))}
        </div>
      );
    }),
  };
});

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
    const abort = vi.fn(async () => undefined);
    const configuration = {
      session: {
        model: { provider: "openai", id: "gpt" },
        thinkingLevel: "medium",
        availableThinkingLevels: ["off", "medium"],
      },
      connectedModelsByProvider: [
        {
          id: "openai",
          name: "OpenAI",
          models: [{ provider: "openai", id: "gpt", name: "GPT", authenticated: true }],
        },
      ],
      selectModel: vi.fn(),
      selectThinkingLevel: vi.fn(),
    } as unknown as ChatConfigurationStore;
    store = mount(
      createStore(ChatStore, {
        id: () => "shared-chat",
        parts: () => [
          {
            id: "question",
            kind: "text",
            role: "user",
            text: "Can you check this?",
            status: "complete",
            deliveryState: "queued",
          },
        ],
        streaming: () => true,
        submitting: () => false,
        configuration: () => configuration,
        commands: () => [],
        placeholder: () => "Ask a follow-up…",
        inputLabel: () => "Reply to chat",
        canSubmit: (draft) => Boolean(draft.trim()),
        submit,
        abort,
      }),
    );

    act(() => root.render(<Chat store={store!} />));

    expect(container.textContent).toContain("Can you check this?");
    expect(container.textContent).toContain("You · pending");
    expect(container.querySelector(".user-message-pending")).not.toBeNull();
    expect(container.querySelector('[aria-label="Churning in progress"]')).not.toBeNull();
    expect(container.querySelector<HTMLInputElement>('[aria-label="Model"]')?.value).toBe("GPT");
    expect(container.textContent).toContain("Medium reasoning");

    // While streaming, the send icon becomes a stop icon and submits are hidden.
    expect(container.querySelector<HTMLButtonElement>('[aria-label="Send"]')).toBeNull();
    const stop = container.querySelector<HTMLButtonElement>('[aria-label="Stop"]')!;
    await act(async () => stop.click());
    expect(abort).toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it("shows the submit icon instead of stop while streaming when the composer has content", async () => {
    const submit = vi.fn(async () => true);
    const abort = vi.fn(async () => undefined);
    store = mount(
      createStore(ChatStore, {
        id: () => "queue-while-streaming-chat",
        parts: () => [],
        streaming: () => true,
        submitting: () => false,
        configuration: () => undefined,
        commands: () => [],
        placeholder: () => "Ask a follow-up…",
        inputLabel: () => "Reply to chat",
        canSubmit: (draft) => Boolean(draft.trim()),
        submit,
        abort,
      }),
    );

    act(() => root.render(<Chat store={store!} />));

    // An empty composer keeps the stop button while streaming.
    expect(container.querySelector<HTMLButtonElement>('[aria-label="Send"]')).toBeNull();
    expect(container.querySelector<HTMLButtonElement>('[aria-label="Stop"]')).not.toBeNull();

    act(() => store!.setDraft("One more thing"));

    // Typing a queued message swaps stop back to submit.
    expect(container.querySelector<HTMLButtonElement>('[aria-label="Stop"]')).toBeNull();
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Send"]')!.click(),
    );
    expect(submit).toHaveBeenCalledWith("One more thing");
    expect(abort).not.toHaveBeenCalled();
  });

  it("submits the draft from the send icon when idle", async () => {
    const submit = vi.fn(async () => true);
    store = mount(
      createStore(ChatStore, {
        id: () => "idle-chat",
        parts: () => [],
        streaming: () => false,
        submitting: () => false,
        configuration: () => undefined,
        commands: () => [],
        placeholder: () => "Message Cake",
        inputLabel: () => "Message",
        canSubmit: (draft) => Boolean(draft.trim()),
        submit,
      }),
    );

    act(() => root.render(<Chat store={store!} />));

    const input = container.querySelector<HTMLTextAreaElement>('[aria-label="Message"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
        input,
        "Please continue",
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Send"]')!.click(),
    );

    expect(submit).toHaveBeenCalledWith("Please continue");
    expect(store.draft).toBe("");
  });

  it("attaches clipboard images pasted into the composer", async () => {
    const addPastedImages = vi.fn(async () => undefined);
    store = mount(
      createStore(ChatStore, {
        id: () => "image-paste-chat",
        parts: () => [],
        streaming: () => false,
        submitting: () => false,
        configuration: () => undefined,
        commands: () => [],
        placeholder: () => "Message Cake",
        inputLabel: () => "Message",
        canSubmit: () => false,
        submit: async () => false,
        addPastedImages,
      }),
    );

    act(() => root.render(<Chat store={store!} />));

    const image = new File(["image bytes"], "clipboard.png", { type: "image/png" });
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", {
      value: { files: [], items: [{ type: "image/png", getAsFile: () => image }] },
    });

    await act(async () => {
      container.querySelector<HTMLTextAreaElement>('[aria-label="Message"]')!.dispatchEvent(paste);
    });

    expect(paste.defaultPrevented).toBe(true);
    expect(addPastedImages).toHaveBeenCalledWith([image]);
  });
});
