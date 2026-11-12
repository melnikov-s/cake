/**
 * @vitest-environment jsdom
 */
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  builtinSlashCommands,
  type ConversationSnapshot,
} from "../../../src/contracts/conversations/session-contract";
import {
  findFileMention,
  SlashCommandCombobox,
} from "../../../src/renderer/components/slash-command-combobox";

import { serializeModelReference } from "../../../src/contracts/model-presets/model-reference";

type SlashCommand = ConversationSnapshot["commands"][number];

function command(name: string): SlashCommand {
  return {
    name,
    description: `${name} description`,
    source: "extension",
    sourceInfo: { path: "/extension", source: "test", scope: "project", origin: "top-level" },
  };
}

async function waitForFileSuggestions() {
  await act(async () => {
    // Advance the component's file-suggestion debounce, including its Promise completion.
    await vi.advanceTimersByTimeAsync(20);
  });
}

describe("SlashCommandCombobox", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    Object.assign(globalThis, {
      IS_REACT_ACT_ENVIRONMENT: true,
      requestAnimationFrame: (callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      },
      cancelAnimationFrame: vi.fn(),
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it("moves through commands with arrow keys and selects the active command with Enter", () => {
    const onValueChange = vi.fn();
    const onSubmit = vi.fn();
    act(() =>
      root.render(
        <SlashCommandCombobox
          aria-label="Message"
          commands={[command("help"), command("models"), command("settings")]}
          value="/"
          onValueChange={onValueChange}
          onSubmit={onSubmit}
        />,
      ),
    );
    const input = container.querySelector<HTMLTextAreaElement>('[role="combobox"]')!;

    expect(input.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector('[role="option"][aria-selected="true"]')?.textContent).toContain(
      "help",
    );

    act(() =>
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })),
    );
    expect(container.querySelector('[role="option"][aria-selected="true"]')?.textContent).toContain(
      "models",
    );

    act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(onValueChange).toHaveBeenCalledWith("/models");
    expect(onSubmit).toHaveBeenCalledWith("/models");
  });

  it.each([
    ["matches text anywhere in a command name", "/desktop", "skill:desktop-fixture"],
    ["fuzzy matches characters in order", "/tlpr", "toolprune"],
  ])("%s", (_description, value, expectedCommand) => {
    act(() =>
      root.render(
        <SlashCommandCombobox
          aria-label="Message"
          commands={[command("help"), command(expectedCommand), command("settings")]}
          value={value}
          onValueChange={vi.fn()}
          onSubmit={vi.fn()}
        />,
      ),
    );

    expect(container.querySelectorAll('[role="option"]')).toHaveLength(1);
    expect(container.querySelector('[role="option"]')?.textContent).toContain(expectedCommand);
  });

  it("offers tool prune with no-model copy, distinct from compact, and selects the new command", () => {
    const onSubmit = vi.fn();
    act(() =>
      root.render(
        <SlashCommandCombobox
          aria-label="Message"
          commands={builtinSlashCommands}
          value="/toolpr"
          onValueChange={vi.fn()}
          onSubmit={onSubmit}
        />,
      ),
    );
    const options = [...container.querySelectorAll('[role="option"]')];
    expect(options).toHaveLength(1);
    expect(options[0]?.textContent).toContain("toolprune");
    expect(options[0]?.textContent).toContain("no model call");
    expect(container.textContent).not.toMatch(/tool[ -]?compact/i);
    const input = container.querySelector<HTMLTextAreaElement>('[role="combobox"]')!;
    act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(onSubmit).toHaveBeenCalledWith("/toolprune");
  });

  it("ranks stronger command matches ahead of fuzzy matches", () => {
    act(() =>
      root.render(
        <SlashCommandCombobox
          aria-label="Message"
          commands={[command("xmodel"), command("model-switcher"), command("my-old-example-link")]}
          value="/model"
          onValueChange={vi.fn()}
          onSubmit={vi.fn()}
        />,
      ),
    );

    const options = [...container.querySelectorAll('[role="option"]')];
    expect(options.map((option) => option.textContent)).toEqual([
      expect.stringContaining("model-switcher"),
      expect.stringContaining("xmodel"),
      expect.stringContaining("my-old-example-link"),
    ]);
  });

  it("offers commands at the caret while preserving text entered after it", () => {
    function ControlledCombobox() {
      const [value, setValue] = useState("summarize this");
      return (
        <SlashCommandCombobox
          aria-label="Message"
          commands={[command("help"), command("models")]}
          value={value}
          onValueChange={setValue}
          onSubmit={vi.fn()}
        />
      );
    }
    act(() => root.render(<ControlledCombobox />));
    const input = container.querySelector<HTMLTextAreaElement>('[role="combobox"]')!;
    const valueSetter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!;

    act(() => {
      valueSetter.call(input, "/summarize this");
      input.setSelectionRange(1, 1);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(input.getAttribute("aria-expanded")).toBe("true");
    act(() =>
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })),
    );
    expect(input.value).toBe("/help summarize this");
    expect(input.selectionStart).toBe(6);
  });

  it.each(["Tab", "ArrowLeft", "ArrowRight"])("autocompletes with %s without submitting", (key) => {
    const onSubmit = vi.fn();
    function ControlledCombobox() {
      const [value, setValue] = useState("/");
      return (
        <SlashCommandCombobox
          aria-label="Message"
          commands={[command("help"), command("models")]}
          value={value}
          onValueChange={setValue}
          onSubmit={onSubmit}
        />
      );
    }
    act(() => root.render(<ControlledCombobox />));
    const input = container.querySelector<HTMLTextAreaElement>('[role="combobox"]')!;

    act(() =>
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })),
    );
    act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })));
    expect(input.value).toBe("/models ");
    expect(input.getAttribute("aria-expanded")).toBe("false");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "checks prose without autocorrect, excluding slash commands (references=%s)",
    (references) => {
      const renderCombobox = (value: string) => (
        <SlashCommandCombobox
          aria-label="Message"
          commands={[command("help")]}
          value={value}
          onValueChange={vi.fn()}
          onSubmit={vi.fn()}
          onEditReference={references ? vi.fn() : undefined}
        />
      );
      const prefix = references
        ? serializeModelReference({
            provider: "fixture",
            modelId: "model",
            thinkingLevel: "off",
            fastMode: false,
          }) + " "
        : "";
      act(() => root.render(renderCombobox(prefix + "hello")));
      const input = container.querySelector<HTMLElement>('[role="combobox"]')!;

      expect(input.getAttribute("spellcheck")).toBe("true");
      expect(input.getAttribute("autocorrect")).toBe("off");
      act(() => root.render(renderCombobox("  /help argument")));
      expect(input.getAttribute("spellcheck")).toBe("false");
      act(() => root.render(renderCombobox("ordinary prose")));
      expect(input.getAttribute("spellcheck")).toBe("true");
      expect(input.getAttribute("autocorrect")).toBe("off");
    },
  );

  it("submits with Enter when the command menu is closed", () => {
    const onSubmit = vi.fn();
    act(() =>
      root.render(
        <SlashCommandCombobox
          aria-label="Message"
          commands={[command("help")]}
          value="hello"
          onValueChange={vi.fn()}
          onSubmit={onSubmit}
        />,
      ),
    );
    const input = container.querySelector<HTMLTextAreaElement>('[role="combobox"]')!;

    act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(onSubmit).toHaveBeenCalledWith("hello", "composer-enter");
  });

  it("restores focus after an Enter submission finishes", async () => {
    let finishSubmission!: () => void;
    const onSubmit = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishSubmission = resolve;
        }),
    );
    act(() =>
      root.render(
        <SlashCommandCombobox
          aria-label="Message"
          commands={[]}
          value="hello"
          onValueChange={vi.fn()}
          onSubmit={onSubmit}
        />,
      ),
    );
    const input = container.querySelector<HTMLTextAreaElement>('[role="combobox"]')!;
    const elsewhere = document.createElement("button");
    container.appendChild(elsewhere);
    input.focus();

    act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(onSubmit).toHaveBeenCalledWith("hello", "composer-enter");
    elsewhere.focus();

    await act(async () => finishSubmission());

    expect(document.activeElement).toBe(input);
  });

  it("focuses again when the composer workflow requests it", () => {
    act(() =>
      root.render(
        <SlashCommandCombobox
          aria-label="Message"
          commands={[]}
          focusRequestRevision={0}
          value=""
          onValueChange={vi.fn()}
          onSubmit={vi.fn()}
        />,
      ),
    );
    const input = container.querySelector<HTMLTextAreaElement>('[role="combobox"]')!;
    const elsewhere = document.createElement("button");
    container.appendChild(elsewhere);
    elsewhere.focus();

    act(() =>
      root.render(
        <SlashCommandCombobox
          aria-label="Message"
          commands={[]}
          focusRequestRevision={1}
          value=""
          onValueChange={vi.fn()}
          onSubmit={vi.fn()}
        />,
      ),
    );

    expect(document.activeElement).toBe(input);
  });

  it.each(["unchanged", "moved", "removed"] as const)(
    "deferred composer focus respects the newer focus destination (%s)",
    (destination) => {
      const frames: FrameRequestCallback[] = [];
      Object.assign(globalThis, {
        requestAnimationFrame: (callback: FrameRequestCallback) => {
          frames.push(callback);
          return frames.length;
        },
      });
      const renderComposer = (revision: number) =>
        root.render(
          <SlashCommandCombobox
            aria-label="Message"
            commands={[]}
            autoFocus={false}
            focusRequestRevision={revision}
            value=""
            onValueChange={vi.fn()}
            onSubmit={vi.fn()}
          />,
        );
      act(() => renderComposer(0));
      const input = container.querySelector<HTMLTextAreaElement>('[role="combobox"]')!;
      const closingControl = document.createElement("button");
      const navigation = document.createElement("button");
      container.append(closingControl, navigation);
      closingControl.focus();
      act(() => renderComposer(1));
      expect(frames).toHaveLength(1);
      if (destination === "moved") navigation.focus();
      if (destination === "removed") closingControl.remove();
      act(() => frames.shift()!(0));
      expect(document.activeElement).toBe(destination === "moved" ? navigation : input);
    },
  );

  it("does not replay an inactive composer's stale focus request", () => {
    act(() =>
      root.render(
        <SlashCommandCombobox
          aria-label="Message"
          commands={[]}
          focusEnabled={false}
          focusRequestRevision={1}
          value=""
          onValueChange={vi.fn()}
          onSubmit={vi.fn()}
        />,
      ),
    );
    const input = container.querySelector<HTMLTextAreaElement>('[role="combobox"]')!;
    const elsewhere = document.createElement("button");
    container.appendChild(elsewhere);
    elsewhere.focus();

    act(() =>
      root.render(
        <SlashCommandCombobox
          aria-label="Message"
          commands={[]}
          focusEnabled
          focusRequestRevision={1}
          value=""
          onValueChange={vi.fn()}
          onSubmit={vi.fn()}
        />,
      ),
    );

    expect(document.activeElement).toBe(elsewhere);
    expect(document.activeElement).not.toBe(input);
  });

  it("renders Pi CLI built-ins with their argument hints", () => {
    const builtin: SlashCommand = {
      name: "model",
      description: "Select model",
      argumentHint: "<provider/model>",
      source: "builtin",
      sourceInfo: {
        path: "builtin:pi-cli",
        source: "Pi CLI",
        scope: "temporary",
        origin: "top-level",
      },
    };
    act(() =>
      root.render(
        <SlashCommandCombobox
          aria-label="Message"
          commands={[builtin]}
          value="/"
          onValueChange={vi.fn()}
          onSubmit={vi.fn()}
        />,
      ),
    );

    expect(container.querySelector('[role="option"]')?.textContent).toContain(
      "/model <provider/model>",
    );
    expect(container.querySelector('[role="option"]')?.textContent).toContain("Pi CLI");
  });

  it("finds unquoted and quoted file mentions at the caret", () => {
    expect(findFileMention("check @src/app then", 14)).toMatchObject({
      token: "@src/app",
      prefix: "src/app",
    });
    expect(findFileMention('check @"my folder/app', 21)).toMatchObject({
      token: '@"my folder/app',
      prefix: '"my folder/app',
    });
    expect(findFileMention("email@example.com", 17)).toBeUndefined();
  });

  it("shows Pi file suggestions and inserts the active file with Enter", async () => {
    const suggestFiles = vi.fn(async () => [
      { value: "@src/app.ts", label: "app.ts", description: "src/app.ts" },
      { value: "@tests/app.test.ts", label: "app.test.ts", description: "tests/app.test.ts" },
    ]);
    function ControlledCombobox() {
      const [value, setValue] = useState("please read @app");
      return (
        <SlashCommandCombobox
          aria-label="Message"
          commands={[]}
          suggestFiles={suggestFiles}
          value={value}
          onValueChange={setValue}
          onSubmit={vi.fn()}
        />
      );
    }
    act(() => root.render(<ControlledCombobox />));
    await waitForFileSuggestions();
    const input = container.querySelector<HTMLTextAreaElement>('[role="combobox"]')!;

    expect(suggestFiles).toHaveBeenCalledWith("app");
    expect(container.querySelector('[role="listbox"]')?.getAttribute("aria-label")).toBe(
      "Project files",
    );
    expect(container.querySelector('[role="option"][aria-selected="true"]')?.textContent).toContain(
      "src/app.ts",
    );

    act(() =>
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })),
    );
    act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(input.value).toBe("please read @tests/app.test.ts ");
  });

  it("keeps directory completions open and preserves Pi quoting for paths with spaces", async () => {
    const suggestFiles = vi.fn(async (prefix: string) =>
      prefix === "src/"
        ? [{ value: "@src/components/", label: "components/", description: "src/components" }]
        : [{ value: '@"my folder/"', label: "my folder/", description: "my folder" }],
    );
    function ControlledCombobox() {
      const [value, setValue] = useState("open @my");
      return (
        <SlashCommandCombobox
          aria-label="Message"
          commands={[]}
          suggestFiles={suggestFiles}
          value={value}
          onValueChange={setValue}
          onSubmit={vi.fn()}
        />
      );
    }
    act(() => root.render(<ControlledCombobox />));
    await waitForFileSuggestions();
    const input = container.querySelector<HTMLTextAreaElement>('[role="combobox"]')!;

    act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(input.value).toBe('open @"my folder/"');
    expect(input.selectionStart).toBe(input.value.length - 1);
  });

  it("keeps the file menu open while a shorter replacement query is pending", async () => {
    let resolveReplacement!: (
      value: Array<{ value: string; label: string; description: string }>,
    ) => void;
    const suggestFiles = vi.fn((prefix: string) =>
      prefix === "alpha"
        ? Promise.resolve([{ value: "@alpha.ts", label: "alpha.ts", description: "alpha.ts" }])
        : new Promise<Array<{ value: string; label: string; description: string }>>((resolve) => {
            resolveReplacement = resolve;
          }),
    );
    function ControlledCombobox() {
      const [value, setValue] = useState("@alpha");
      return (
        <SlashCommandCombobox
          aria-label="Message"
          commands={[]}
          suggestFiles={suggestFiles}
          value={value}
          onValueChange={setValue}
          onSubmit={vi.fn()}
        />
      );
    }
    act(() => root.render(<ControlledCombobox />));
    await waitForFileSuggestions();
    const input = container.querySelector<HTMLTextAreaElement>('[role="combobox"]')!;
    const valueSetter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!;
    expect(container.querySelector('[role="listbox"]')).not.toBeNull();

    act(() => {
      valueSetter.call(input, "@a");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await waitForFileSuggestions();
    expect(container.querySelector('[role="listbox"]')).not.toBeNull();
    expect(container.querySelector('[role="option"]')?.textContent).toContain("alpha.ts");

    await act(async () => {
      resolveReplacement([{ value: "@app.ts", label: "app.ts", description: "app.ts" }]);
      await Promise.resolve();
    });
    expect(container.querySelector('[role="option"]')?.textContent).toContain("app.ts");
  });

  it("ignores stale file-search responses", async () => {
    let resolveFirst!: (
      value: Array<{ value: string; label: string; description: string }>,
    ) => void;
    let resolveSecond!: (
      value: Array<{ value: string; label: string; description: string }>,
    ) => void;
    const suggestFiles = vi.fn(
      (prefix: string) =>
        new Promise<Array<{ value: string; label: string; description: string }>>((resolve) => {
          if (prefix === "a") resolveFirst = resolve;
          else resolveSecond = resolve;
        }),
    );
    function ControlledCombobox() {
      const [value, setValue] = useState("@a");
      return (
        <SlashCommandCombobox
          aria-label="Message"
          commands={[]}
          suggestFiles={suggestFiles}
          value={value}
          onValueChange={setValue}
          onSubmit={vi.fn()}
        />
      );
    }
    act(() => root.render(<ControlledCombobox />));
    await waitForFileSuggestions();
    const input = container.querySelector<HTMLTextAreaElement>('[role="combobox"]')!;
    const valueSetter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!;
    act(() => {
      valueSetter.call(input, "@b");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await waitForFileSuggestions();

    await act(async () => {
      resolveSecond([{ value: "@beta.ts", label: "beta.ts", description: "beta.ts" }]);
      await Promise.resolve();
    });
    await act(async () => {
      resolveFirst([{ value: "@alpha.ts", label: "alpha.ts", description: "alpha.ts" }]);
      await Promise.resolve();
    });
    expect(container.querySelector('[role="option"]')?.textContent).toContain("beta.ts");
    expect(container.querySelector('[role="option"]')?.textContent).not.toContain("alpha.ts");
  });
});
