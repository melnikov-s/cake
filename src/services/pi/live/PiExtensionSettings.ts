import {
  DefaultPackageManager,
  type ResolvedResource,
  type SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { basename, dirname, relative } from "node:path";
import { Schema } from "effect";
import type { PiExtensionSetting, PiExtensionToggle } from "../extension-settings-data";
import { createCakeMcpExtensions } from "../runtime/mcp-integration";

async function discover(agentDirectory: string, manager: SettingsManager) {
  const builtinExtensions = createCakeMcpExtensions({
    runtime: { agentDir: agentDirectory },
  }).flatMap((extension) => (extension.builtin ? [extension.name] : []));
  const packages = new DefaultPackageManager({
    cwd: agentDirectory,
    agentDir: agentDirectory,
    settingsManager: manager,
    builtinExtensions,
  });
  // Settings discovery must neither install missing packages nor execute extension code.
  return (await packages.resolve(async () => "skip")).extensions.filter(
    (resource) => resource.metadata.scope === "user",
  );
}

export async function listPiExtensionSettings(
  agentDirectory: string,
  manager: SettingsManager,
): Promise<PiExtensionSetting[]> {
  return (await discover(agentDirectory, manager)).map((resource) => ({
    id: resource.path,
    name: resource.path.startsWith("builtin:") ? resource.path : basename(resource.path),
    path: resource.path,
    source: resource.metadata.source,
    enabled: resource.enabled,
  }));
}

const togglePattern = (paths: readonly string[], pattern: string, enabled: boolean) => [
  ...paths.filter(
    (entry) =>
      (entry.startsWith("!") || entry.startsWith("+") || entry.startsWith("-")
        ? entry.slice(1)
        : entry) !== pattern,
  ),
  `${enabled ? "+" : "-"}${pattern}`,
];

function applyToggle(
  agentDirectory: string,
  manager: SettingsManager,
  resource: ResolvedResource,
  enabled: boolean,
) {
  const settings = manager.getGlobalSettings();
  if (resource.metadata.origin === "top-level") {
    const pattern =
      resource.metadata.source === "builtin"
        ? resource.path
        : relative(resource.metadata.baseDir ?? agentDirectory, resource.path);
    manager.setExtensionPaths(togglePattern(settings.extensions ?? [], pattern, enabled));
    return;
  }
  const index = (settings.packages ?? []).findIndex(
    (entry) =>
      (Schema.is(Schema.String)(entry) ? entry : entry.source) === resource.metadata.source,
  );
  if (index < 0) throw new Error("That extension's package is no longer configured");
  const packages = [...(settings.packages ?? [])];
  const original = packages[index];
  if (original === undefined) throw new Error("That extension's package is no longer configured");
  const entry = Schema.is(Schema.String)(original) ? { source: original } : original;
  const pattern = relative(resource.metadata.baseDir ?? dirname(resource.path), resource.path);
  packages[index] = {
    ...entry,
    extensions: togglePattern(entry.extensions ?? [], pattern, enabled),
  };
  manager.setPackages(packages);
}

export async function togglePiExtensionSetting(
  agentDirectory: string,
  manager: SettingsManager,
  toggle: PiExtensionToggle,
) {
  const resource = (await discover(agentDirectory, manager)).find(
    (entry) => entry.path === toggle.id,
  );
  if (!resource)
    throw new Error("That extension is no longer discoverable. Refresh the extension list.");
  applyToggle(agentDirectory, manager, resource, toggle.enabled);
}
