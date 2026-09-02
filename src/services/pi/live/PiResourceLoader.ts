import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { PiAgentResourceContext } from "../agent-resource-data";

export async function loadPiResources(
  agentDirectory: string,
  context: PiAgentResourceContext,
  signal?: AbortSignal,
  options?: { readonly noExtensions?: boolean },
) {
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
    additionalExtensionPaths:
      !options?.noExtensions && context.additionalExtensionPaths
        ? [...context.additionalExtensionPaths]
        : [],
    noThemes: true,
    noContextFiles: true,
    noExtensions: options?.noExtensions,
  });
  await resourceLoader.reload({ resolveProjectTrust: async () => context.projectTrusted });
  signal?.throwIfAborted();
  return { resourceLoader, settingsManager };
}
