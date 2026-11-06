import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseJsonc } from "jsonc-parser";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureEditorPreferences,
  syncCompanionExtension,
  type CompanionManifest,
} from "../../../../src/services/vscode/vscode-profile";

const companionManifest: CompanionManifest = {
  name: "cake-companion",
  displayName: "Cake Companion",
  description: "Test companion",
  version: "0.0.0",
  publisher: "cake",
  private: true,
  license: "UNLICENSED",
  engines: { vscode: "*" },
  main: "./extension.js",
  activationEvents: [],
  contributes: { commands: [] },
};

describe("VS Code profile provisioning", () => {
  let root: string | undefined;
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("applies Cake's theme on every start while preserving other user settings", async () => {
    root = await mkdtemp(join(tmpdir(), "cake-vscode-runtime-"));
    const settingsPath = join(root, "profile", "User", "settings.json");

    await ensureEditorPreferences(join(root, "profile"));
    expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual({
      "workbench.colorCustomizations": {},
      "editor.tokenColorCustomizations": {},
      "editor.semanticTokenColorCustomizations": {},
      "security.workspace.trust.enabled": false,
      "workbench.colorTheme": "Cake Dark",
      "workbench.startupEditor": "none",
      "workbench.secondarySideBar.defaultVisibility": "hidden",
      "chat.disableAIFeatures": true,
      "extensions.ignoreRecommendations": true,
    });

    await writeFile(
      settingsPath,
      `{
  // Keep this comment; Cake still canonicalizes the keys around it.
  "security.workspace.trust.enabled": true,
  "workbench.colorTheme": "Solarized Light",
  "workbench.secondarySideBar.defaultVisibility": "visible",
  "chat.disableAIFeatures": false,
  "github.copilot.enable": { "*": true },
  "extensions.autoUpdate": true,
}
`,
    );
    await ensureEditorPreferences(join(root, "profile"));
    const updatedRaw = await readFile(settingsPath, "utf8");
    expect(updatedRaw).toContain("Keep this comment; Cake still canonicalizes the keys around it.");
    expect(parseJsonc(updatedRaw)).toEqual({
      "workbench.colorCustomizations": {},
      "editor.tokenColorCustomizations": {},
      "editor.semanticTokenColorCustomizations": {},
      "security.workspace.trust.enabled": false,
      "workbench.colorTheme": "Cake Dark",
      "workbench.startupEditor": "none",
      "workbench.secondarySideBar.defaultVisibility": "hidden",
      "chat.disableAIFeatures": true,
      "github.copilot.enable": { "*": true },
      "extensions.autoUpdate": true,
      "extensions.ignoreRecommendations": true,
    });

    await ensureEditorPreferences(join(root, "profile-light"), "light");
    expect(
      JSON.parse(await readFile(join(root, "profile-light", "User", "settings.json"), "utf8"))[
        "workbench.colorTheme"
      ],
    ).toBe("Cake Light");
  });

  it("persists imported editor colors and syntax, then clears them on switching back", async () => {
    root = await mkdtemp(join(tmpdir(), "cake-vscode-colors-"));
    const theme = {
      id: "ocean",
      name: "Ocean",
      type: "dark" as const,
      colors: { "editor.background": "#102030" },
      tokenColors: [{ scope: "keyword", settings: { foreground: "#ffaa00" } }],
      semanticTokenColors: { variable: "#abcdef" },
      semanticHighlighting: true,
    };
    await ensureEditorPreferences(join(root, "profile"), theme);
    const path = join(root, "profile", "User", "settings.json");
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      "workbench.colorTheme": "Cake Dark",
      "workbench.colorCustomizations": theme.colors,
      "editor.tokenColorCustomizations": { textMateRules: theme.tokenColors },
      "editor.semanticTokenColorCustomizations": {
        enabled: true,
        rules: theme.semanticTokenColors,
      },
    });
    await ensureEditorPreferences(join(root, "profile"), "light");
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      "workbench.colorTheme": "Cake Light",
      "workbench.colorCustomizations": {},
      "editor.tokenColorCustomizations": {},
      "editor.semanticTokenColorCustomizations": {},
    });
  });

  it("writes the companion's contributed theme files into the extension directory", async () => {
    root = await mkdtemp(join(tmpdir(), "cake-vscode-runtime-"));
    const companionSource = "module.exports = {};\n";
    const files = {
      root,
      companionManifest,
      companionSource,
      companionThemes: [
        { path: "./themes/cake-light-color-theme.json", content: "{}\n" },
        { path: "./themes/cake-dark-color-theme.json", content: "{\n}\n" },
      ],
    };

    const extensionsRoot = await syncCompanionExtension(files);

    await expect(
      readFile(join(extensionsRoot, "cake-companion", "extension.js"), "utf8"),
    ).resolves.toBe("module.exports = {};\n");
    await expect(
      readFile(
        join(extensionsRoot, "cake-companion", "themes", "cake-light-color-theme.json"),
        "utf8",
      ),
    ).resolves.toBe("{}\n");
    await expect(
      readFile(
        join(extensionsRoot, "cake-companion", "themes", "cake-dark-color-theme.json"),
        "utf8",
      ),
    ).resolves.toBe("{\n}\n");
    expect(
      JSON.parse(await readFile(join(extensionsRoot, "cake-companion", "package.json"), "utf8")),
    ).toEqual(companionManifest);
  });

  it("preserves user extensions while canonicalizing the Cake companion registry entry", async () => {
    root = await mkdtemp(join(tmpdir(), "cake-vscode-runtime-"));
    const companionSource = "module.exports = {};\n";
    const extensionsRoot = join(root, "extensions");
    await mkdir(join(extensionsRoot, "github.copilot"), { recursive: true });
    await mkdir(join(extensionsRoot, "esbenp.prettier-vscode"), { recursive: true });
    await mkdir(join(extensionsRoot, "cake-companion"), { recursive: true });
    await writeFile(
      join(extensionsRoot, "extensions.json"),
      JSON.stringify([
        {
          identifier: { id: "GitHub.copilot" },
          version: "1.0.0",
          location: { scheme: "file", path: join(extensionsRoot, "github.copilot") },
          relativeLocation: "github.copilot",
        },
        {
          identifier: { id: "esbenp.prettier-vscode" },
          version: "10.0.0",
          location: { scheme: "file", path: join(extensionsRoot, "esbenp.prettier-vscode") },
          relativeLocation: "esbenp.prettier-vscode",
        },
        {
          identifier: { id: "cake.cake-companion" },
          version: "0.0.0",
          location: { scheme: "file", path: "/stale/cake-companion" },
          relativeLocation: "cake-companion",
        },
      ]),
    );

    await syncCompanionExtension({ root, companionManifest, companionSource, companionThemes: [] });

    await expect(stat(join(extensionsRoot, "github.copilot"))).resolves.toBeDefined();
    await expect(stat(join(extensionsRoot, "esbenp.prettier-vscode"))).resolves.toBeDefined();
    const registry = JSON.parse(await readFile(join(extensionsRoot, "extensions.json"), "utf8"));
    expect(registry.map((entry: { identifier: { id: string } }) => entry.identifier.id)).toEqual([
      "GitHub.copilot",
      "esbenp.prettier-vscode",
      "cake.cake-companion",
    ]);
  });

  it.each(['{"workbench.colorTheme":', '{"workbench.colorTheme":42}'])(
    "preserves malformed user-authored settings: %s",
    async (raw) => {
      root = await mkdtemp(join(tmpdir(), "cake-vscode-profile-"));
      const profile = join(root, "profile");
      await mkdir(join(profile, "User"), { recursive: true });
      const settingsPath = join(profile, "User", "settings.json");
      await writeFile(settingsPath, raw);
      await ensureEditorPreferences(profile);
      expect(await readFile(settingsPath, "utf8")).toBe(raw);
    },
  );
});
