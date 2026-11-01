import { describe, expect, it } from "vitest";
import { cakeThemeTokens, parseVsCodeTheme } from "../../../src/utils/vscode-theme";
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
      const theme = parse(
        JSON.stringify({
          type,
          colors: {
            "editor.background": background,
            "editor.foreground": foreground,
            "sideBar.background": "#123456",
            "button.background": "#203040",
            "button.foreground": "#ffffff",
            focusBorder: "#aabbcc",
          },
        }),
      );
      expect(cakeThemeTokens(theme)).toMatchObject({
        "--background": background,
        "--foreground": foreground,
        "--sidebar": "#123456",
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

  it("infers light/dark from the editor canvas when type is missing", () => {
    expect(parse('{"colors":{"editor.background":"#fff"}}').type).toBe("light");
    expect(parse('{"colors":{"editor.background":"#111"}}').type).toBe("dark");
  });
});
