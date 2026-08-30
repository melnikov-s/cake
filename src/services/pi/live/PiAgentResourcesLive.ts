import {
  DefaultPackageManager,
  DefaultResourceLoader,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Effect, Layer } from "effect";
import { makePiAgentResources, PiAgentResources } from "../PiAgentResources";
import type { PiAgentResourceContext, PiAgentResourcesSnapshot } from "../agent-resource-data";

const bounded = (value: string, maximum: number) => value.slice(0, maximum);

export async function discoverPiAgentResources(
  agentDirectory: string,
  context: PiAgentResourceContext,
  signal?: AbortSignal,
): Promise<PiAgentResourcesSnapshot> {
  signal?.throwIfAborted();
  const settingsManager = SettingsManager.create(context.workingDirectory, agentDirectory, {
    projectTrusted: context.projectTrusted,
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd: context.workingDirectory,
    agentDir: agentDirectory,
    settingsManager,
    additionalSkillPaths: context.additionalSkillPaths ? [...context.additionalSkillPaths] : [],
    additionalPromptTemplatePaths: context.additionalPromptTemplatePaths
      ? [...context.additionalPromptTemplatePaths]
      : [],
    additionalExtensionPaths: context.additionalExtensionPaths
      ? [...context.additionalExtensionPaths]
      : [],
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload({ resolveProjectTrust: async () => context.projectTrusted });
  signal?.throwIfAborted();

  const skills = resourceLoader
    .getSkills()
    .skills.slice(0, 4_096)
    .map((skill) => ({
      kind: "skill" as const,
      name: bounded(skill.name, 256),
      description: bounded(skill.description, 8_192),
      path: bounded(skill.filePath, 8_192),
      source: bounded(skill.sourceInfo.source, 8_192),
      scope: skill.sourceInfo.scope,
      origin: skill.sourceInfo.origin,
    }));
  const prompts = resourceLoader.getPrompts();
  const promptTemplates = prompts.prompts.slice(0, 4_096).map((prompt) => ({
    kind: "prompt" as const,
    name: bounded(prompt.name, 256),
    description: bounded(prompt.description, 8_192),
    ...(prompt.argumentHint ? { argumentHint: bounded(prompt.argumentHint, 2_048) } : undefined),
    path: bounded(prompt.filePath, 8_192),
    source: bounded(prompt.sourceInfo.source, 8_192),
    scope: prompt.sourceInfo.scope,
    origin: prompt.sourceInfo.origin,
  }));
  const extensions = resourceLoader.getExtensions();
  const extensionSources = extensions.extensions.slice(0, 4_096).map((extension) => ({
    kind: "extension" as const,
    path: bounded(extension.path, 8_192),
    resolvedPath: bounded(extension.resolvedPath, 8_192),
    enabled: !extension.hidden,
    source: bounded(extension.sourceInfo.source, 8_192),
    scope: extension.sourceInfo.scope,
    origin: extension.sourceInfo.origin,
  }));
  const packageSources = new DefaultPackageManager({
    cwd: context.workingDirectory,
    agentDir: agentDirectory,
    settingsManager,
  })
    .listConfiguredPackages()
    .slice(0, 4_096)
    .map((configured) => ({
      kind: "package" as const,
      source: bounded(configured.source, 8_192),
      scope: configured.scope,
      ...(configured.installedPath
        ? { installedPath: bounded(configured.installedPath, 8_192) }
        : undefined),
      enabled: !configured.filtered,
    }));
  const diagnostics: PiAgentResourcesSnapshot["diagnostics"] = [
    ...extensions.errors.map((error, index) => ({
      id: bounded(`extension:${index}:${error.path}`, 8_192),
      severity: "error" as const,
      source: "extension" as const,
      message: bounded(error.error, 32_000),
      path: bounded(error.path, 8_192),
    })),
    ...resourceLoader.getSkills().diagnostics.map((item, index) => ({
      id: bounded(`skill:${index}:${item.path ?? item.message}`, 8_192),
      severity: item.type === "error" ? ("error" as const) : ("warning" as const),
      source: "skill" as const,
      message: bounded(item.message, 32_000),
      ...(item.path ? { path: bounded(item.path, 8_192) } : undefined),
    })),
    ...prompts.diagnostics.map((item, index) => ({
      id: bounded(`prompt:${index}:${item.path ?? item.message}`, 8_192),
      severity: item.type === "error" ? ("error" as const) : ("warning" as const),
      source: "prompt" as const,
      message: bounded(item.message, 32_000),
      ...(item.path ? { path: bounded(item.path, 8_192) } : undefined),
    })),
  ].slice(0, 8_192);

  return { skills, promptTemplates, extensionSources, packageSources, diagnostics };
}

export const makePiAgentResourcesLive = (agentDirectory: string) =>
  Layer.succeed(PiAgentResources)(
    makePiAgentResources({
      load: Effect.fn("PiAgentResourcesLive.load")((context) =>
        Effect.tryPromise({
          try: (signal) => discoverPiAgentResources(agentDirectory, context, signal),
          catch: (cause) => cause,
        }),
      ),
    }),
  );
