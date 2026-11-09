import { describe, expect, it } from "vitest";
import {
  cakeThemeTokens,
  contrastRatio,
  opaqueColorOver,
  parseVsCodeTheme,
} from "../../../src/utils/vscode-theme";
import { editorThemeSettings } from "../../../src/contracts/themes/color-theme";

const parse = (source: string) =>
  parseVsCodeTheme("theme.json", new Map([["theme.json", source]]), "test");

describe("VS Code color data import", () => {
  it("parses comments, trailing commas, includes and inherited syntax/semantic rules", () => {
    const theme = parseVsCodeTheme(
      "themes/ocean.jsonc",
      new Map([
        [
          "themes/ocean.jsonc",
          `{// comment\n"name":"Ocean", "include":"../base.json", "colors":{"editor.background":"#102030",}, "tokenColors":[{"scope":["keyword","storage"],"settings":{"foreground":"#abcdef"}}]}`,
        ],
        [
          "base.json",
          JSON.stringify({
            type: "dark",
            colors: { "editor.foreground": "#eeeeee", "sideBar.background": "#001122" },
            tokenColors: [{ scope: "string", settings: { foreground: "#00ff00" } }],
            semanticTokenColors: { variable: { foreground: "#abcdef", bold: true } },
          }),
        ],
      ]),
      "ocean",
    );
    expect(theme).toMatchObject({
      id: "ocean",
      name: "Ocean",
      type: "dark",
      colors: { "editor.background": "#102030", "editor.foreground": "#eeeeee" },
      semanticHighlighting: true,
    });
    expect(theme.tokenColors).toHaveLength(2);
    expect(theme.semanticTokenColors.variable).toEqual({ foreground: "#abcdef", bold: true });
  });

  it.each([
    "{",
    "null",
    "[]",
    '{"colors":{"editor.background":"url(bad)"}}',
    '{"tokenColors":"syntax.tmTheme"}',
    '{"main":"extension.js"}',
  ])("rejects invalid/non-color data: %s", (source) => {
    expect(() => parse(source)).toThrow();
  });

  it("reports missing and circular includes without reading outside the selected file set", () => {
    expect(() => parse('{"include":"../outside.json"}')).toThrow(/outside/);
    expect(() => parse('{"include":"base.json"}')).toThrow(/Missing include/);
    expect(() =>
      parseVsCodeTheme(
        "a.json",
        new Map([
          ["a.json", '{"include":"b.json"}'],
          ["b.json", '{"include":"a.json"}'],
        ]),
        "id",
      ),
    ).toThrow(/Circular/);
  });

  it.each(["light", "dark"] as const)(
    "maps %s surfaces and derives readable Cake-only defaults",
    (type) => {
      const background = type === "light" ? "#faf4e8" : "#102030";
      const foreground = type === "light" ? "#302010" : "#e8f0ff";
      const sidebar = type === "light" ? "#123456" : "#304050";
      const theme = parse(
        JSON.stringify({
          type,
          colors: {
            "editor.background": background,
            "editor.foreground": foreground,
            "sideBar.background": sidebar,
            "button.background": "#203040",
            "button.foreground": "#ffffff",
            focusBorder: "#aabbcc",
          },
        }),
      );
      expect(cakeThemeTokens(theme)).toMatchObject({
        "--background": background,
        "--foreground": foreground,
        "--sidebar": sidebar,
        "--primary": "#203040",
        "--primary-foreground": "#ffffff",
        "--ring": "#aabbcc",
        "--card": background,
        "--card-foreground": foreground,
        "--user-message-foreground": foreground,
      });
      expect(cakeThemeTokens(theme)["--user-message"]).toContain(background);
      expect(cakeThemeTokens(theme)["--border"]).toContain(foreground);
      const settings = editorThemeSettings(theme);
      expect(settings["workbench.colorTheme"]).toBe(type === "light" ? "Cake Light" : "Cake Dark");
      expect(settings["workbench.colorCustomizations"]).toEqual(theme.colors);
      expect(editorThemeSettings("light")["editor.tokenColorCustomizations"]).toEqual({});
    },
  );

  it.each(["light", "dark"] as const)(
    "keeps worktree status colors fixed while importing %s git decoration colors",
    (type) => {
      const theme = parse(
        JSON.stringify({
          type,
          colors: {
            "gitDecoration.addedResourceForeground": "#ff0000",
            "gitDecoration.stageModifiedResourceForeground": "#ebcb8b",
          },
        }),
      );
      const tokens = cakeThemeTokens(theme);
      expect(tokens["--worktree-open"]).toBeUndefined();
      expect(tokens["--worktree-merged"]).toBeUndefined();
      expect(tokens["--success"]).toBe("#ff0000");
      expect(editorThemeSettings(theme)["workbench.colorCustomizations"]).toEqual(theme.colors);
    },
  );

  it.each(["light", "dark"] as const)(
    "restores %s sidebar contrast for missing, flat, reversed and translucent surfaces",
    (type) => {
      const background = type === "light" ? "#faf4ed" : "#191724";
      const foreground = type === "light" ? "#575279" : "#e0def4";
      for (const sidebar of [
        undefined,
        background,
        type === "light" ? "#ffffff" : "#101018",
        `${background}80`,
      ]) {
        const theme = parse(
          JSON.stringify({
            type,
            colors: {
              "editor.background": background,
              "editor.foreground": foreground,
              ...(sidebar ? { "sideBar.background": sidebar } : {}),
              "list.hoverBackground": "#907aa920",
              "list.activeSelectionBackground": "#907aa940",
            },
          }),
        );
        const original = structuredClone(theme.colors);
        const tokens = cakeThemeTokens(theme);
        const visible = opaqueColorOver(tokens["--sidebar"]!, background);
        expect(contrastRatio(visible, background)).toBeGreaterThanOrEqual(1.06);
        const brightness = contrastRatio(visible, "#ffffff");
        const canvasBrightness = contrastRatio(background, "#ffffff");
        if (type === "light") expect(brightness).toBeGreaterThan(canvasBrightness);
        else expect(brightness).toBeLessThan(canvasBrightness);
        if (sidebar?.length === 9) expect(tokens["--sidebar"]!.slice(-2)).toBe("80");
        expect(tokens["--background"]).toBe(background);
        expect(tokens["--sidebar-hover"]).toBe("#907aa920");
        expect(tokens["--sidebar-active"]).toBe("#907aa940");
        expect(theme.colors).toEqual(original);
      }
    },
  );

  it("preserves an explicitly transparent sidebar", () => {
    const theme = parse(
      '{"colors":{"editor.background":"#faf4ed","sideBar.background":"#ffffff00"}}',
    );
    expect(cakeThemeTokens(theme)["--sidebar"]).toBe("#ffffff00");
  });

  it("keeps an imported translucent input background for the composer", () => {
    const theme = parse(
      '{"colors":{"editor.background":"#faf4ed","input.background":"#f2e9e180"}}',
    );
    expect(cakeThemeTokens(theme)["--composer"]).toBe("#f2e9e180");
  });

  it("picks an accent that stays visible on the canvas and sidebar", () => {
    const sidebar = { "editor.background": "#faf4ed", "sideBar.background": "#faf4ed" };
    const tokens = (colors: Record<string, string>) =>
      cakeThemeTokens(parse(JSON.stringify({ colors: { ...sidebar, ...colors } })));
    expect(tokens({ focusBorder: "#286983", "button.foreground": "#faf4ed" })).toMatchObject({
      "--accent": "#286983",
      "--accent-foreground": "#faf4ed",
    });
    expect(
      tokens({
        focusBorder: "#6e6a8614",
        "button.background": "#286983",
        "button.foreground": "#faf4ed",
      }),
    ).toMatchObject({ "--accent": "#286983", "--accent-foreground": "#ffffff" });
    expect(tokens({ focusBorder: "#6e6a8614", "textLink.foreground": "#907aa9" })["--accent"]).toBe(
      "#907aa9",
    );
    expect(tokens({ focusBorder: "#f2e9e1", "sideBar.foreground": "#575279" })["--accent"]).toBe(
      "#575279",
    );
  });

  it("infers light/dark from the editor canvas when type is missing", () => {
    expect(parse('{"colors":{"editor.background":"#fff"}}').type).toBe("light");
    expect(parse('{"colors":{"editor.background":"#111"}}').type).toBe("dark");
  });
});
