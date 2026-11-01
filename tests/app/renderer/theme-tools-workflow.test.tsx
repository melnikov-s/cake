/** @vitest-environment jsdom */
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Schema } from "effect";
import { toSnapshot, type StoreSnapshot } from "r-state-tree";
import { observer } from "r-state-tree/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  jsonObjectSchema,
  type JsonObject,
} from "../../../src/contracts/serialization/json-contract";
import { cakeChatControlTools } from "../../../src/contracts/application/window-control-definitions";
import { themeOperationDefinitions as definitions } from "../../../src/contracts/themes/theme-operations";
import { editorThemeSettings } from "../../../src/contracts/themes/color-theme";
import { createGlobalControlOperations } from "../../../src/domain/application/cake-global-control-operations";
import { createCakeThemeOperations } from "../../../src/domain/application/cake-theme-operations";
import { SettingsAppearanceSection } from "../../../src/renderer/components/settings-appearance-section";
import { useAppDocument } from "../../../src/renderer/hooks/use-app-document";
import { currentEditorTheme } from "../../../src/renderer/lib/resolved-color-theme";
import type { RootStore } from "../../../src/renderer/stores/RootStore";
import { CakeOperationRegistry } from "../../../src/services/pi/runtime/cake-operation-registry";
import { createRendererStoreFixture } from "./renderer-store-fixture";

const DocumentTheme = observer(function DocumentTheme({ root }: { root: RootStore }) {
  useAppDocument(root);
  return <SettingsAppearanceSection appearance={root.settingsStore.appearance} />;
});
const palette = {
  name: " Halloween ",
  theme: {
    type: "dark",
    colors: {
      "editor.background": "#191322",
      "editor.foreground": "#f4e6d5",
      "button.background": "#ed8a27",
    },
    tokenColors: [{ scope: "keyword", settings: { foreground: "#ffaa33" } }],
    semanticTokenColors: { variable: { foreground: "#bbaaee", italic: true } },
  },
};

function fixture(
  options: { snapshot?: StoreSnapshot; global?: boolean; flush?: () => Promise<void> } = {},
) {
  let saved: StoreSnapshot | undefined;
  const rootFixture = createRendererStoreFixture({
    snapshot: options.snapshot,
    flushWindowState: async () => {
      await options.flush?.();
      // Model the real window snapshot storage boundary, including a JSON round trip.
      saved = JSON.parse(JSON.stringify(toSnapshot(rootFixture.root)));
    },
  });
  const { root } = rootFixture;
  const view = render(<DocumentTheme root={root} />);
  const invoke = (command: string, input: JsonObject) =>
    root.applicationControlStore.invoke(
      { name: command, arguments: input },
      { kind: "cake-chat", sessionId: "permanent-chat", title: "Permanent chat" },
    );
  const operations = options.global
    ? createGlobalControlOperations(
        {
          tools: cakeChatControlTools(),
          invoke: (invocation) =>
            invoke(
              invocation.name,
              Schema.decodeUnknownSync(jsonObjectSchema)(invocation.arguments),
            ),
        },
        () => ({ provider: "test", modelId: "test", thinkingLevel: "off", fastMode: false }),
      )
    : createCakeThemeOperations(invoke);
  const registry = new CakeOperationRegistry(operations);
  const call = async (command: string, input: JsonObject = {}) => {
    let result: unknown;
    await act(async () => {
      result = Schema.decodeUnknownSync(Schema.Struct({ result: Schema.Unknown }))(
        (
          await registry.invoke(
            { command, input },
            { signal: new AbortController().signal, toolCallId: "theme-test", runtime: {} },
          )
        ).structuredContent,
      ).result;
    });
    return result;
  };
  return {
    root,
    registry,
    call,
    saved: () => saved,
    list: async () =>
      Schema.decodeUnknownSync(definitions["themes.list"].output)(await call("themes.list")),
    add: async (input: JsonObject = palette) =>
      Schema.decodeUnknownSync(definitions["themes.add"].output)(await call("themes.add", input)),
    read: async (choice: string) =>
      Schema.decodeUnknownSync(definitions["themes.read"].output)(
        await call("themes.read", { choice }),
      ),
    apply: async (choice: string, application: "now" | "when-active") =>
      Schema.decodeUnknownSync(definitions["themes.apply"].output)(
        await call("themes.apply", { choice, application }),
      ),
    async appearance(theme: "light" | "dark" | "system") {
      await act(async () => {
        await root.applicationControlStore.invoke({
          name: "settings.window.update",
          arguments: { section: "appearance", changes: { theme } },
        });
      });
    },
    [Symbol.dispose]() {
      view.unmount();
      rootFixture[Symbol.dispose]();
    },
  };
}
afterEach(cleanup);

describe("theme gateway workflows", () => {
  it.each([false, true])(
    "creates, reads, applies and restores through the real window authority (global gateway: %s)",
    async (global) => {
      let saved: StoreSnapshot | undefined;
      let choice: string;
      {
        using h = fixture({ global });
        await h.appearance("light");
        expect(h.registry.help()).toContain("themes —");
        expect(h.registry.operationHelp("themes.add")).toContain("never overwrites");
        expect(h.registry.operationOutputSchema("themes.apply")).toContain("effective");
        const before = await h.list();
        const created = await h.add();
        choice = created.theme.choice;
        expect(choice).toMatch(/^imported:/);
        expect(created.theme.name).toBe("Halloween");
        expect(created.state).toEqual(before.state);
        expect((await h.read(choice)).theme).toEqual(created.theme);
        expect((await h.list()).themes).toContainEqual({ choice, name: "Halloween", type: "dark" });
        const duplicate = await h.add();
        expect(duplicate.theme.choice).not.toBe(choice);
        const applied = await h.apply(choice, "now");
        expect(applied).toMatchObject({
          visible: true,
          previous: { appearance: "light" },
          state: {
            appearance: "dark",
            lightTheme: before.state.lightTheme,
            darkTheme: choice,
            effective: { choice },
          },
        });
        expect(document.documentElement.style.getPropertyValue("--background")).toBe("#191322");
        expect(currentEditorTheme()).toEqual(created.theme.theme);
        expect(editorThemeSettings(currentEditorTheme())).toMatchObject({
          "workbench.colorCustomizations": palette.theme.colors,
          "editor.tokenColorCustomizations": { textMateRules: palette.theme.tokenColors },
        });
        expect(screen.getAllByRole("button", { name: "Halloween theme" })).toHaveLength(2);
        saved = h.saved();
      }
      using restored = fixture({ snapshot: saved, global });
      expect((await restored.read(choice)).theme.name).toBe("Halloween");
      expect((await restored.list()).state).toMatchObject({
        appearance: "dark",
        darkTheme: choice,
        effective: { choice },
      });
      expect(currentEditorTheme()).toMatchObject({
        name: "Halloween",
        colors: palette.theme.colors,
      });
    },
  );

  it("keeps Light/Dark slots independent; System follows the OS, and now switches only when necessary", async () => {
    using h = fixture();
    await h.appearance("system");
    await act(async () => h.root.settingsStore.appearance.setSystemColorScheme("light"));
    const dark = await h.add();
    const light = await h.add({
      name: "Cream",
      theme: { type: "light", colors: { "editor.background": "#fff7ee" } },
    });
    const inactive = await h.apply(dark.theme.choice, "when-active");
    expect(inactive).toMatchObject({
      visible: false,
      state: { appearance: "system", darkTheme: dark.theme.choice, effective: { type: "light" } },
    });
    expect(await h.apply(light.theme.choice, "when-active")).toMatchObject({
      visible: true,
      state: { appearance: "system", lightTheme: light.theme.choice },
    });
    await act(async () => h.root.settingsStore.appearance.setSystemColorScheme("dark"));
    expect((await h.list()).state).toMatchObject({
      appearance: "system",
      effective: { choice: dark.theme.choice },
    });
    expect(currentEditorTheme()).toMatchObject({ name: "Halloween" });
    expect((await h.apply(dark.theme.choice, "now")).state.appearance).toBe("system");
    const immediate = await h.apply(light.theme.choice, "now");
    expect(immediate).toMatchObject({
      visible: true,
      state: {
        appearance: "light",
        darkTheme: dark.theme.choice,
        effective: { choice: light.theme.choice },
      },
    });
    await h.appearance("dark");
    expect(await h.apply(light.theme.choice, "when-active")).toMatchObject({
      visible: false,
      state: { appearance: "dark" },
    });
    await h.appearance("system");
    expect((await h.list()).state.effective.choice).toBe(dark.theme.choice);
  });

  it("imports JSONC/includes as color data and persists the resolved palette and syntax", async () => {
    using h = fixture();
    const added = await h.add({
      name: "Imported",
      entry: "themes/main.jsonc",
      files: {
        "themes/main.jsonc":
          '// comment\n{"include":"../base.json", "colors":{"button.background":"#ff8800"},}',
        "base.json": JSON.stringify(palette.theme),
      },
    });
    expect(added.theme.theme).toMatchObject({
      name: "Imported",
      type: "dark",
      colors: { ...palette.theme.colors, "button.background": "#ff8800" },
      tokenColors: palette.theme.tokenColors,
    });
    expect((await h.read(added.theme.choice)).theme).toEqual(added.theme);
  });

  it.each([
    { name: " ", theme: palette.theme },
    { name: "Bad", theme: { colors: { "editor.background": "url(unsafe)" } } },
    { name: "Bad", theme: { tokenColors: "file.tmTheme" } },
    { name: "Bad", theme: {} },
    { name: "Bad", entry: "a.json", files: { "a.json": "{" } },
    { name: "Bad", entry: "a.json", files: { "a.json": '{"main":"extension.js"}' } },
    { name: "Bad", entry: "a.json", files: { "a.json": '{"include":"missing.json"}' } },
    { name: "Bad", entry: "a.json", files: { "a.json": '{"include":"../outside.json"}' } },
    { name: "Bad", entry: "a.json", files: { "a.json": '{"include":"a.json"}' } },
  ])("rejects invalid input without changing the catalog: %j", async (input) => {
    using h = fixture();
    const before = await h.list();
    await expect(h.add(Schema.decodeUnknownSync(jsonObjectSchema)(input))).rejects.toThrow();
    expect(await h.list()).toEqual(before);
    expect(h.saved()).toBeUndefined();
  });

  it("requires exact saved IDs and explicit application semantics", async () => {
    using h = fixture();
    const before = await h.list();
    await expect(h.call("themes.read", { choice: "Halloween" })).rejects.toThrow();
    await expect(h.call("themes.apply", { choice: "bundled:nord" })).rejects.toThrow();
    await expect(
      h.call("themes.apply", { choice: "bundled:missing", application: "now" }),
    ).rejects.toThrow(/Unknown saved theme/);
    await expect(
      h.call("themes.apply", { choice: "bundled:nord", application: "now", invented: true }),
    ).rejects.toThrow();
    await expect(h.read("imported:missing")).rejects.toThrow(/Unknown saved theme/);
    expect(await h.list()).toEqual(before);
    expect((await h.apply("bundled:nord", "now")).state.effective).toMatchObject({
      choice: "bundled:nord",
    });
  });

  it("reads immediately imported Settings themes through the same catalog without changing inactive appearance", async () => {
    using h = fixture({ global: true });
    await h.appearance("light");
    const before = await h.list();
    const content = JSON.stringify({ ...palette.theme, name: "Settings import" });
    const file = new File([content], "settings-theme.json", { type: "application/json" });
    Object.defineProperty(file, "text", { value: async () => content });
    await userEvent.setup().upload(screen.getByLabelText("Import VS Code theme"), file);
    const imported = (await h.list()).themes.find((theme) => theme.name === "Settings import");
    if (!imported) throw new Error("Settings import was not added to the shared theme catalog");
    const readback = await h.read(imported.choice);
    expect(readback.theme.theme).toMatchObject({
      name: "Settings import",
      colors: palette.theme.colors,
    });
    expect(readback.state).toMatchObject({
      appearance: "light",
      lightTheme: before.state.lightTheme,
      darkTheme: imported.choice,
      effective: before.state.effective,
    });
    expect(screen.getByRole("status").textContent).toContain("when Dark mode is active");
    expect((await h.apply(imported.choice, "now")).state.effective.choice).toBe(imported.choice);
    expect(currentEditorTheme()).toMatchObject({ name: "Settings import" });
  });

  it("does not acknowledge a mutation until persistence completes, and surfaces storage failures", async () => {
    let release = () => {};
    let entered = () => {};
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    using h = fixture({
      flush: async () => {
        entered();
        await held;
      },
    });
    let completed = false;
    const pending = h.add().then((value) => {
      completed = true;
      return value;
    });
    await started;
    expect(completed).toBe(false);
    release();
    await pending;
    expect(h.saved()).toBeDefined();
    using failed = fixture({
      flush: async () => {
        throw new Error("Disk full");
      },
    });
    await expect(failed.add()).rejects.toThrow("Disk full");
    expect(failed.saved()).toBeUndefined();
  });
});
