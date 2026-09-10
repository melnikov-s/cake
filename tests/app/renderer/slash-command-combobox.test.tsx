/**
 * @vitest-environment jsdom
 */
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionSnapshot } from "../../../src/ipc/session-contract";
import {
  findFileMention,
  SlashCommandCombobox,
} from "../../../src/renderer/components/slash-command-combobox";

type SlashCommand = SessionSnapshot["commands"][number];

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
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
}

describe("SlashCommandCombobox", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
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
    act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true })));
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

  it("disables spellcheck while entering a slash command", () => {
    const renderCombobox = (value: string) => (
      <SlashCommandCombobox
        aria-label="Message"
        commands={[command("help")]}
        value={value}
        onValueChange={vi.fn()}
        onSubmit={vi.fn()}
      />
    );
    act(() => root.render(renderCombobox("hello")));
    const input = container.querySelector<HTMLTextAreaElement>('[role="combobox"]')!;

    expect(input.getAttribute("spellcheck")).toBe("true");
    act(() => root.render(renderCombobox("  /help argument")));
    expect(input.getAttribute("spellcheck")).toBe("false");
  });

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
    expect(onSubmit).toHaveBeenCalledWith("hello");
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

    act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true })));
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
