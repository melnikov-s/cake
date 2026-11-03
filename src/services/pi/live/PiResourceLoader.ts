import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { PiAgentResourceContext } from "../agent-resource-data";
import { cakeBuiltinSkillsOverride } from "../runtime/cake-builtin-skills";

export async function loadPiResources(
  agentDirectory: string,
  context: PiAgentResourceContext,
  signal?: AbortSignal,
  options?: { readonly noExtensions?: boolean },
) {
  signal?.throwIfAborted();
  // Like Cake's session runtimes, load project resources without Pi's per-folder trust question.
  const settingsManager = SettingsManager.create(context.workingDirectory, agentDirectory, {
    projectTrusted: true,
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd: context.workingDirectory,
    agentDir: agentDirectory,
    settingsManager,
    additionalSkillPaths: context.additionalSkillPaths ? [...context.additionalSkillPaths] : [],
    skillsOverride: await cakeBuiltinSkillsOverride(agentDirectory),
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
  await resourceLoader.reload({ resolveProjectTrust: async () => true });
  signal?.throwIfAborted();
  return { resourceLoader, settingsManager };
}
