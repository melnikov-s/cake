import {
  DefaultPackageManager,
  type DefaultResourceLoader,
  type SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { CompatibilityCatalog, ResourceDiagnostic } from "../../../ipc/session-contract";

/** Temporary legacy projection consumed by CakeRuntime until PiSessions lands in Phase 5B. */
export function compatibilityCatalog(
  resourceLoader: DefaultResourceLoader,
  settingsManager: SettingsManager,
  workingDirectory: string,
  agentDirectory: string,
): CompatibilityCatalog {
  const extensions = resourceLoader.getExtensions();
  const skills = resourceLoader.getSkills();
  const prompts = resourceLoader.getPrompts();
  const packages = new DefaultPackageManager({
    cwd: workingDirectory,
    agentDir: agentDirectory,
    settingsManager,
  }).listConfiguredPackages();
  const resources: CompatibilityCatalog["resources"] = [];

  for (const skill of skills.skills)
    resources.push({
      id: `skill:${skill.filePath}`.slice(0, 8_192),
      kind: "skill",
      name: skill.name,
      description: skill.description,
      path: skill.filePath,
      source: skill.sourceInfo.source,
      scope: skill.sourceInfo.scope,
      origin: skill.sourceInfo.origin,
      commands: [],
      tools: [],
      enabled: true,
    });
  for (const prompt of prompts.prompts)
    resources.push({
      id: `prompt:${prompt.filePath}`.slice(0, 8_192),
      kind: "prompt",
      name: prompt.name,
      description: prompt.description,
      path: prompt.filePath,
      source: prompt.sourceInfo.source,
      scope: prompt.sourceInfo.scope,
      origin: prompt.sourceInfo.origin,
      commands: [],
      tools: [],
      enabled: true,
    });
  for (const extension of extensions.extensions)
    resources.push({
      id: `extension:${extension.resolvedPath}`.slice(0, 8_192),
      kind: "extension",
      name: extension.path.split(/[\\/]/).pop() ?? extension.path,
      path: extension.path,
      source: extension.sourceInfo.source,
      scope: extension.sourceInfo.scope,
      origin: extension.sourceInfo.origin,
      commands: [...extension.commands.keys()].filter((name) => name.length <= 256).sort(),
      tools: [...extension.tools.keys()].filter((name) => name.length <= 256).sort(),
      enabled: !extension.hidden,
    });
  for (const configured of packages)
    resources.push({
      id: `package:${configured.scope}:${configured.source}`.slice(0, 8_192),
      kind: "package",
      name: configured.source,
      path: configured.installedPath,
      source: configured.source,
      scope: configured.scope,
      origin: "package",
      commands: [],
      tools: [],
      enabled: !configured.filtered,
    });

  const diagnostics: ResourceDiagnostic[] = [
    ...extensions.errors.map((error, index) => ({
      id: `extension:${index}:${error.path}`,
      severity: "error" as const,
      source: "extension" as const,
      message: error.error,
      path: error.path,
    })),
    ...skills.diagnostics.map((item, index) => ({
      id: `skill:${index}:${item.path ?? item.message}`.slice(0, 8_192),
      severity: item.type === "error" ? ("error" as const) : ("warning" as const),
      source: "skill" as const,
      message: item.message,
      path: item.path,
    })),
    ...prompts.diagnostics.map((item, index) => ({
      id: `prompt:${index}:${item.path ?? item.message}`.slice(0, 8_192),
      severity: item.type === "error" ? ("error" as const) : ("warning" as const),
      source: "prompt" as const,
      message: item.message,
      path: item.path,
    })),
  ];
  return { resources, diagnostics };
}
