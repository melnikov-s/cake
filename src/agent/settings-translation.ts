import type { AgentSession, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { PiSettingUpdate } from "../ipc/session-contract";

export function applyPiSetting(settingsManager: SettingsManager, session: AgentSession, update: PiSettingUpdate) {
  if (update.key === "defaultModel") settingsManager.setDefaultModelAndProvider(update.provider, update.modelId);
  else if (update.key === "defaultThinkingLevel") settingsManager.setDefaultThinkingLevel(update.value);
  else if (update.key === "autoCompact") session.setAutoCompactionEnabled(update.value);
  else if (update.key === "autoResizeImages") settingsManager.setImageAutoResize(update.value);
  else if (update.key === "blockImages") settingsManager.setBlockImages(update.value);
  else if (update.key === "enableSkillCommands") settingsManager.setEnableSkillCommands(update.value);
  else if (update.key === "steeringMode") session.setSteeringMode(update.value);
  else if (update.key === "followUpMode") session.setFollowUpMode(update.value);
  else if (update.key === "transport") {
    settingsManager.setTransport(update.value);
    session.agent.transport = update.value;
  }
  else if (update.key === "httpIdleTimeoutMs") settingsManager.setHttpIdleTimeoutMs(update.value);
  else if (update.key === "hideThinkingBlock") settingsManager.setHideThinkingBlock(update.value);
  else if (update.key === "mermaidRenderingMode") settingsManager.setMermaidRenderingMode(update.value);
  else if (update.key === "showCacheMissNotices") settingsManager.setShowCacheMissNotices(update.value);
  else if (update.key === "collapseChangelog") settingsManager.setCollapseChangelog(update.value);
  else if (update.key === "quietStartup") settingsManager.setQuietStartup(update.value);
  else if (update.key === "enableInstallTelemetry") settingsManager.setEnableInstallTelemetry(update.value);
  else if (update.key === "defaultProjectTrust") settingsManager.setDefaultProjectTrust(update.value);
  else if (update.key === "doubleEscapeAction") settingsManager.setDoubleEscapeAction(update.value);
  else if (update.key === "treeFilterMode") settingsManager.setTreeFilterMode(update.value);
  else if (update.key === "anthropicExtraUsageWarning") settingsManager.setWarnings({ ...settingsManager.getWarnings(), anthropicExtraUsage: update.value });
  else if (update.key === "retryEnabled") settingsManager.setRetryEnabled(update.value);
  else if (update.key === "shellPath") settingsManager.setShellPath(update.value.trim() || undefined);
  else if (update.key === "shellCommandPrefix") settingsManager.setShellCommandPrefix(update.value.trim() || undefined);
  else if (update.key === "npmCommand") settingsManager.setNpmCommand(update.value.length > 0 ? update.value : undefined);
  else if (update.key === "packages") settingsManager.setPackages(update.value);
  else if (update.key === "extensions") settingsManager.setExtensionPaths(update.value);
  else if (update.key === "skills") settingsManager.setSkillPaths(update.value);
  else if (update.key === "prompts") settingsManager.setPromptTemplatePaths(update.value);
}
