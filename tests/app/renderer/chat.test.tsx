/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createStore, mount, observable } from "r-state-tree";
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
    document.execCommand = vi.fn(() => false);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    store?.[Symbol.dispose]();
    container.remove();
    vi.useRealTimers();
  });

  it("renders the shared transcript, loading state, configuration, and composer actions", async () => {
    const submit = vi.fn(async () => true);
    const abort = vi.fn(async () => undefined);
    const setUserMessageMarkdown = vi.fn(async () => undefined);
    const configuration = {
      session: {
        model: { provider: "openai", id: "gpt", name: "GPT" },
        thinkingLevel: "medium",
        availableThinkingLevels: ["off", "medium"],
      },
      activeOperations: [],
      activePreset: undefined,
      presets: [],
      fastMode: false,
      connectedModelsByProvider: [
        {
          id: "openai",
          name: "OpenAI",
          models: [{ provider: "openai", id: "gpt", name: "GPT", authenticated: true }],
        },
      ],
      selectThinkingLevel: vi.fn(),
    } as unknown as ChatConfigurationStore;
    store = mount(
      createStore(ChatStore, {
        id: () => "shared-chat",
        parts: () => [
          {
            id: "question",
            entryId: "user-entry",
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
        setUserMessageMarkdown,
        abort,
      }),
    );

    act(() => root.render(<Chat store={store!} />));

    expect(container.textContent).toContain("Can you check this?");
    expect(container.querySelector('[data-slot="message-content"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Churning in progress"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Model configuration"]')?.textContent).toContain(
      "GPT",
    );
    expect(container.textContent).toContain("Medium");
    expect(container.querySelector('[aria-label="Markdown formatting"]')).toBeNull();
    const renderMarkdown = container.querySelector<HTMLButtonElement>(
      '[aria-label="Render as Markdown"]',
    );
    expect(renderMarkdown?.className).toContain("group-hover/msg:opacity-100");
    await act(async () => renderMarkdown?.click());
    expect(setUserMessageMarkdown).toHaveBeenCalledWith("user-entry", true);

    // While streaming, the send icon becomes a stop icon and submits are hidden.
    expect(container.querySelector<HTMLButtonElement>('[aria-label="Send"]')).toBeNull();
    const stop = container.querySelector<HTMLButtonElement>('[aria-label="Stop"]')!;
    expect(stop).not.toBeNull();
    await act(async () => stop.click());
    expect(abort).toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it("shows source references as removable VS Code context", async () => {
    const openSourceLocation = vi.fn();
    const removeAttachment = vi.fn();
    const source = {
      kind: "source" as const,
      name: "src/main.ts",
      location: {
        path: "src/main.ts",
        range: {
          start: { line: 2 },
          end: { line: 3 },
        },
      },
    };
    store = mount(
      createStore(ChatStore, {
        id: () => "source-chat",
        parts: () => [],
        streaming: () => false,
        submitting: () => false,
        configuration: () => undefined,
        commands: () => [],
        placeholder: () => "Message Cake",
        inputLabel: () => "Message",
        canSubmit: () => true,
        submit: async () => true,
        attachments: () => [source],
        removeAttachment,
      }),
    );

    act(() => root.render(<Chat store={store!} transcriptBehavior={{ openSourceLocation }} />));
    expect(container.textContent).toContain("src/main.ts#L3-L4");

    await act(async () => {
      container.querySelector<HTMLButtonElement>("button:not([aria-label])")!.click();
    });
    expect(openSourceLocation).toHaveBeenCalledWith(source.location);
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[aria-label="Remove src/main.ts#L3-L4"]')!
        .click();
    });
    expect(removeAttachment).toHaveBeenCalledWith(0);
  });

  it("shows compact context token usage when the gauge is hovered", () => {
    vi.useFakeTimers();
    store = mount(
      createStore(ChatStore, {
        id: () => "usage-chat",
        parts: () => [],
        streaming: () => false,
        submitting: () => false,
        configuration: () => undefined,
        commands: () => [],
        placeholder: () => "Message Cake",
        inputLabel: () => "Message",
        canSubmit: () => false,
        submit: async () => false,
        usage: () => ({
          tokens: { input: 20_000, output: 0, cacheRead: 0, cacheWrite: 0, total: 20_000 },
          cost: 0,
          context: { tokens: 20_000, contextWindow: 270_000, percent: 7.4 },
        }),
      }),
    );

    vi.useFakeTimers();
    act(() => root.render(<Chat store={store!} />));

    const gauge = container.querySelector<HTMLElement>('[aria-label*="context used"]')!;
    act(() => {
      gauge.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    act(() => {
      vi.runAllTimers();
    });

    expect(document.body.querySelector<HTMLElement>('[role="tooltip"]')?.textContent).toBe(
      "20k / 270k tokens",
    );
  });

  it("keeps stop available while idle foreground work has a running subagent", async () => {
    const abort = vi.fn(async () => undefined);
    store = mount(
      createStore(ChatStore, {
        id: () => "background-work-chat",
        parts: () => [],
        streaming: () => false,
        submitting: () => false,
        stoppable: () => true,
        configuration: () => undefined,
        commands: () => [],
        placeholder: () => "Message Cake",
        inputLabel: () => "Message",
        canSubmit: () => false,
        submit: async () => false,
        abort,
      }),
    );

    act(() => root.render(<Chat store={store!} />));

    const stop = container.querySelector<HTMLButtonElement>('[aria-label="Stop"]')!;
    expect(stop).not.toBeNull();
    await act(async () => stop.click());
    expect(abort).toHaveBeenCalledOnce();
  });

  it("replaces stop with submit while streaming when the composer has content", async () => {
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

    // Typing a queued message replaces Stop with Send so both actions never appear together.
    const send = container.querySelector<HTMLButtonElement>('[aria-label="Send"]')!;
    expect(send).not.toBeNull();
    expect(container.querySelector<HTMLButtonElement>('[aria-label="Stop"]')).toBeNull();

    await act(async () => send.click());
    expect(submit).toHaveBeenCalledWith("One more thing", {
      renderUserMessageAsMarkdown: false,
    });
    expect(abort).not.toHaveBeenCalled();

    // Once the submitted draft clears, Stop is available again for the active turn.
    const stop = container.querySelector<HTMLButtonElement>('[aria-label="Stop"]')!;
    expect(stop).not.toBeNull();
    await act(async () => stop.click());
    expect(abort).toHaveBeenCalledOnce();
  });

  it("does not scroll to the bottom when the composer appears after the user scrolled away", () => {
    const activity = observable({ composerVisible: false });
    store = mount(
      createStore(ChatStore, {
        id: () => "composer-visibility-chat",
        parts: () => [
          {
            id: "assistant-1",
            kind: "text",
            role: "assistant",
            text: "A long answer",
            status: "complete",
          },
        ],
        streaming: () => !activity.composerVisible,
        submitting: () => false,
        configuration: () => undefined,
        commands: () => [],
        placeholder: () => "Message Cake",
        inputLabel: () => "Message",
        canSubmit: () => false,
        submit: async () => false,
        composerVisible: () => activity.composerVisible,
      }),
    );

    act(() => root.render(<Chat store={store!} />));
    const transcript = container.querySelector<HTMLElement>(".transcript")!;
    Object.defineProperties(transcript, {
      scrollHeight: { configurable: true, value: 1_000 },
      clientHeight: { configurable: true, value: 200 },
    });
    transcript.scrollTop = 300;

    act(() => {
      activity.composerVisible = true;
    });

    expect(transcript.scrollTop).toBe(300);
  });

  it("keeps draft typing from rendering the surrounding chat", () => {
    const composerVisible = vi.fn(() => true);
    store = mount(
      createStore(ChatStore, {
        id: () => "isolated-draft-chat",
        parts: () => [],
        streaming: () => false,
        submitting: () => false,
        configuration: () => undefined,
        commands: () => [],
        placeholder: () => "Message Cake",
        inputLabel: () => "Message",
        canSubmit: (draft) => Boolean(draft.trim()),
        submit: async () => true,
        composerVisible,
      }),
    );

    act(() => root.render(<Chat store={store!} />));
    const surroundingRenderReads = composerVisible.mock.calls.length;
    const input = container.querySelector<HTMLTextAreaElement>('[aria-label="Message"]')!;

    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
        input,
        "Only update the draft controls",
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(input.value).toBe("Only update the draft controls");
    expect(store.draft).toBe("Only update the draft controls");
    expect(composerVisible).toHaveBeenCalledTimes(surroundingRenderReads);
    expect(container.querySelector<HTMLButtonElement>('[aria-label="Send"]')?.disabled).toBe(false);
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

    expect(submit).toHaveBeenCalledWith("Please continue", {
      renderUserMessageAsMarkdown: false,
    });
    expect(store.draft).toBe("");
  });

  it("opens the draft action when the send button is held", async () => {
    vi.useFakeTimers();
    const submit = vi.fn(async () => true);
    const createDraft = vi.fn(async () => true);
    store = mount(
      createStore(ChatStore, {
        id: () => "draft-chat",
        parts: () => [],
        streaming: () => false,
        submitting: () => false,
        configuration: () => undefined,
        commands: () => [],
        placeholder: () => "Message Cake",
        inputLabel: () => "Message",
        canSubmit: (draft) => Boolean(draft.trim()),
        submit,
        createDraft,
        canCreateDraft: () => true,
      }),
    );
    store.setDraft("Plan this work");
    act(() => root.render(<Chat store={store!} />));

    const send = container.querySelector<HTMLButtonElement>(
      '[aria-label="Send · hold to save as draft"]',
    )!;
    act(() => {
      send.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
      vi.advanceTimersByTime(600);
    });

    const createDraftAction = document.body.querySelector<HTMLButtonElement>('[role="menuitem"]')!;
    expect(createDraftAction.textContent).toBe("Create draft");
    await act(async () => createDraftAction.click());
    expect(createDraft).toHaveBeenCalledOnce();
    expect(submit).not.toHaveBeenCalled();
  });

  it("stops active work when Escape is pressed in the focused composer", () => {
    const abort = vi.fn(async () => undefined);
    store = mount(
      createStore(ChatStore, {
        id: () => "escape-stop-chat",
        parts: () => [],
        streaming: () => true,
        submitting: () => false,
        configuration: () => undefined,
        commands: () => [],
        placeholder: () => "Message Cake",
        inputLabel: () => "Message",
        canSubmit: () => false,
        submit: async () => false,
        abort,
      }),
    );

    act(() => root.render(<Chat store={store!} />));

    const input = container.querySelector<HTMLTextAreaElement>('[aria-label="Message"]')!;
    input.focus();
    const escape = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    act(() => input.dispatchEvent(escape));

    expect(input).toBe(document.activeElement);
    expect(escape.defaultPrevented).toBe(true);
    expect(abort).toHaveBeenCalledOnce();
  });

  it("uses Escape to dismiss composer menus and image previews without stopping", () => {
    const abort = vi.fn(async () => undefined);
    store = mount(
      createStore(ChatStore, {
        id: () => "escape-dismiss-chat",
        parts: () => [],
        streaming: () => true,
        submitting: () => false,
        configuration: () => undefined,
        commands: () => [
          {
            name: "model",
            description: "Choose a model",
            source: "builtin" as const,
            sourceInfo: {
              path: "builtin:model",
              source: "Pi",
              scope: "temporary" as const,
              origin: "top-level" as const,
            },
          },
        ],
        placeholder: () => "Message Cake",
        inputLabel: () => "Message",
        canSubmit: () => false,
        submit: async () => false,
        abort,
        attachments: () => [
          { kind: "image", name: "preview.png", mimeType: "image/png", data: "aW1hZ2U=" },
        ],
      }),
    );

    act(() => root.render(<Chat store={store!} />));

    const input = container.querySelector<HTMLTextAreaElement>('[aria-label="Message"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
        input,
        "/",
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.querySelector('[role="listbox"]')).not.toBeNull();
    act(() =>
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      ),
    );
    expect(container.querySelector('[role="listbox"]')).toBeNull();
    expect(abort).not.toHaveBeenCalled();

    act(() =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="View preview.png enlarged"]')!
        .click(),
    );
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog).not.toBeNull();
    act(() =>
      dialog.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      ),
    );
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(abort).not.toHaveBeenCalled();
  });

  it("rewords only the selected composer text from its context menu", async () => {
    const showComposerContextMenu = vi.fn(async () => "reword" as const);
    const rewordComposerSelection = vi.fn(async () => "clear request");
    store = mount(
      createStore(ChatStore, {
        id: () => "reword-chat",
        parts: () => [],
        streaming: () => false,
        submitting: () => false,
        configuration: () => undefined,
        commands: () => [],
        placeholder: () => "Message Cake",
        inputLabel: () => "Message",
        canSubmit: () => true,
        submit: async () => true,
        showComposerContextMenu,
        rewordComposerSelection,
      }),
    );
    store.setDraft("Before rough ramble after");
    act(() => root.render(<Chat store={store!} />));

    const input = container.querySelector<HTMLTextAreaElement>('[aria-label="Message"]')!;
    input.setSelectionRange(7, 19);
    await act(async () => {
      input.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 12,
          clientY: 34,
        }),
      );
    });

    expect(showComposerContextMenu).toHaveBeenCalledWith("rough ramble", 12, 34);
    expect(rewordComposerSelection).toHaveBeenCalledWith("rough ramble", undefined);
    expect(store.draft).toBe("Before clear request after");
  });

  it("uses the ordinary editing menu when no composer text is selected", async () => {
    const showComposerContextMenu = vi.fn(async () => "reword" as const);
    store = mount(
      createStore(ChatStore, {
        id: () => "unselected-reword-chat",
        parts: () => [],
        streaming: () => false,
        submitting: () => false,
        configuration: () => undefined,
        commands: () => [],
        placeholder: () => "Message Cake",
        inputLabel: () => "Message",
        canSubmit: () => true,
        submit: async () => true,
        showComposerContextMenu,
        rewordComposerSelection: async (selection) => selection,
      }),
    );
    store.setDraft("Nothing selected");
    act(() => root.render(<Chat store={store!} />));

    const input = container.querySelector<HTMLTextAreaElement>('[aria-label="Message"]')!;
    input.setSelectionRange(7, 7);
    const contextMenu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    act(() => input.dispatchEvent(contextMenu));

    expect(contextMenu.defaultPrevented).toBe(false);
    expect(showComposerContextMenu).not.toHaveBeenCalled();
  });

  it("asks for guidance before rewording with a prompt", async () => {
    const showComposerContextMenu = vi.fn(async () => "reword-with-prompt" as const);
    const rewordComposerSelection = vi.fn(async () => "concise text");
    store = mount(
      createStore(ChatStore, {
        id: () => "prompted-reword-chat",
        parts: () => [],
        streaming: () => false,
        submitting: () => false,
        configuration: () => undefined,
        commands: () => [],
        placeholder: () => "Message Cake",
        inputLabel: () => "Message",
        canSubmit: () => true,
        submit: async () => true,
        showComposerContextMenu,
        rewordComposerSelection,
      }),
    );
    store.setDraft("rambling text");
    act(() => root.render(<Chat store={store!} />));

    const input = container.querySelector<HTMLTextAreaElement>('[aria-label="Message"]')!;
    input.setSelectionRange(0, input.value.length);
    await act(async () => {
      input.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    });
    const prompt = document.body.querySelector<HTMLTextAreaElement>(
      '[aria-label="Reword prompt"]',
    )!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
        prompt,
        "Make concise",
      );
      prompt.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      prompt
        .closest<HTMLElement>('[role="dialog"]')!
        .querySelector<HTMLButtonElement>('button[type="submit"]')!
        .click();
    });

    expect(rewordComposerSelection).toHaveBeenCalledWith("rambling text", "Make concise");
    expect(store.draft).toBe("concise text");
    expect(document.body.querySelector('[aria-label="Reword prompt"]')).toBeNull();
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
