import { Option, Schema } from "effect";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { applyEdits, modify, parse as parseJsonc, type ParseError } from "jsonc-parser";
import { editorThemeSettings, type EditorColorTheme } from "../../contracts/themes/color-theme";

/** The sideloaded companion extension's package.json contract. */
export interface CompanionManifest {
  name: string;
  displayName: string;
  description: string;
  version: string;
  publisher: string;
  private: boolean;
  license: string;
  engines: { vscode: string };
  main: string;
  activationEvents: string[];
  contributes: {
    commands: Array<{ command: string; title: string; icon?: string }>;
    menus?: Record<string, Array<{ command: string; when?: string; group?: string }>>;
    themes?: Array<{ label: string; uiTheme: string; path: string }>;
  };
}

export interface CompanionExtensionFiles {
  /** Directory that holds downloads, extracted servers, extensions, and per-workspace state. */
  root: string;
  /** Parsed companion manifest, serialized as the extension's package.json. */
  companionManifest: CompanionManifest;
  /** Bundled companion extension source, written verbatim beside the backend. */
  companionSource: string;
  /** Raw theme files contributed by the companion, written under its extension root. */
  companionThemes: Array<{ path: string; content: string }>;
}

/** Known settings are validated without discarding unrelated user preferences. */
const editorPreferencesSchema = Schema.StructWithRest(
  Schema.Struct({
    "security.workspace.trust.enabled": Schema.optionalKey(Schema.Boolean),
    "workbench.colorTheme": Schema.optionalKey(Schema.String),
    "workbench.startupEditor": Schema.optionalKey(Schema.String),
    "workbench.secondarySideBar.defaultVisibility": Schema.optionalKey(Schema.String),
    "chat.disableAIFeatures": Schema.optionalKey(Schema.Boolean),
    "extensions.ignoreRecommendations": Schema.optionalKey(Schema.Boolean),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);

export async function ensureEditorPreferences(
  userDataDir: string,
  theme: EditorColorTheme = "dark",
) {
  const userDir = join(userDataDir, "User");
  const settingsPath = join(userDir, "settings.json");
  await mkdir(userDir, { recursive: true });
  let raw = "{}";
  try {
    raw = await readFile(settingsPath, "utf8");
  } catch {
    // The per-workspace profile has not been initialized yet.
  }
  const parseErrors: ParseError[] = [];
  const parsed = Schema.decodeUnknownOption(editorPreferencesSchema)(
    parseJsonc(raw, parseErrors, { allowTrailingComma: true }),
  );
  if (parseErrors.length > 0 || Option.isNone(parsed)) {
    // Do not replace malformed user-authored settings.
    return;
  }
  const settings = parsed.value;
  const updates: Array<{ key: string; value: unknown }> = [];
  if (settings["security.workspace.trust.enabled"] !== false) {
    // Opening a Project in Cake is the user's decision to work in it; never ask again.
    updates.push({ key: "security.workspace.trust.enabled", value: false });
  }
  // The embedded editor is a Cake-managed surface: it always follows the app's
  // appearance, so an earlier pick (or a stale value from a previous mode) is
  // replaced with the current preference on every start.
  for (const [key, value] of Object.entries(editorThemeSettings(theme))) {
    if (JSON.stringify(settings[key]) !== JSON.stringify(value)) updates.push({ key, value });
  }
  if (settings["workbench.startupEditor"] === undefined)
    updates.push({ key: "workbench.startupEditor", value: "none" });
  if (settings["workbench.secondarySideBar.defaultVisibility"] !== "hidden")
    updates.push({ key: "workbench.secondarySideBar.defaultVisibility", value: "hidden" });
  if (settings["chat.disableAIFeatures"] !== true)
    updates.push({ key: "chat.disableAIFeatures", value: true });
  if (settings["extensions.ignoreRecommendations"] !== true)
    updates.push({ key: "extensions.ignoreRecommendations", value: true });
  if (updates.length === 0) return;

  let updated = raw;
  for (const update of updates)
    updated = applyEdits(
      updated,
      modify(updated, [update.key], update.value, {
        formattingOptions: { insertSpaces: true, tabSize: 2 },
      }),
    );
  await writeFile(settingsPath, `${updated.trimEnd()}\n`);
}

export async function syncCompanionExtension(options: CompanionExtensionFiles) {
  const extensionsRoot = join(options.root, "extensions");
  const extensionRoot = join(extensionsRoot, "cake-companion");
  await mkdir(extensionRoot, { recursive: true });
  await writeFile(
    join(extensionRoot, "package.json"),
    `${JSON.stringify(options.companionManifest, null, 2)}\n`,
  );
  await writeFile(join(extensionRoot, "extension.js"), options.companionSource);
  for (const theme of options.companionThemes) {
    const relative = theme.path.replace(/^\.?\//, "");
    const target = join(extensionRoot, ...relative.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, theme.content);
  }
  await syncExtensionRegistry(extensionsRoot, options.companionManifest);
  return extensionsRoot;
}

/** Keeps Cake's sideloaded extension canonical without altering user extensions. */
async function syncExtensionRegistry(extensionsRoot: string, companionManifest: CompanionManifest) {
  let registryRaw: string | undefined;
  try {
    registryRaw = await readFile(join(extensionsRoot, "extensions.json"), "utf8");
  } catch {
    // A missing registry is rebuilt by the next extension-host scan.
    return;
  }
  try {
    const registryItemSchema = Schema.StructWithRest(
      Schema.Struct({
        identifier: Schema.StructWithRest(Schema.Struct({ id: Schema.String }), [
          Schema.Record(Schema.String, Schema.Unknown),
        ]),
      }),
      [Schema.Record(Schema.String, Schema.Unknown)],
    );
    const parsed = Schema.decodeUnknownOption(Schema.Array(registryItemSchema))(
      JSON.parse(registryRaw),
    );
    if (Option.isNone(parsed)) return;
    const canonicalCompanion = {
      identifier: { id: "cake.cake-companion" },
      version: companionManifest.version,
      location: { scheme: "file", path: join(extensionsRoot, "cake-companion") },
      relativeLocation: "cake-companion",
    };
    const retained = parsed.value.filter(
      (item) => item.identifier.id.toLowerCase() !== "cake.cake-companion",
    );
    const canonical = [...retained, canonicalCompanion];
    if (JSON.stringify(parsed.value) !== JSON.stringify(canonical))
      await writeFile(join(extensionsRoot, "extensions.json"), `${JSON.stringify(canonical)}\n`);
  } catch {
    // A malformed registry is rebuilt on the next extension-host scan.
  }
}
