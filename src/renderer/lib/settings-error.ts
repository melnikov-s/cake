import type { PiSettingUpdate } from "../../contracts/conversations/session-contract";
import type { SettingsPageId } from "../stores/SettingsStore";

export interface SettingsError {
  readonly section: SettingsPageId | "global";
  readonly message: string;
  readonly details?: string;
}

/** Pi settings are edited across several pages, independently of provider authentication. */
export const piSettingSections = {
  defaultModel: "models",
  defaultThinkingLevel: "models",
  autoCompact: "agent",
  autoResizeImages: "agent",
  blockImages: "agent",
  enableSkillCommands: "agent",
  steeringMode: "agent",
  followUpMode: "agent",
  transport: "network",
  httpIdleTimeoutMs: "network",
  hideThinkingBlock: "agent",
  mermaidRenderingMode: "appearance",
  showCacheMissNotices: "agent",
  collapseChangelog: "agent",
  quietStartup: "agent",
  enableInstallTelemetry: "network",
  defaultProjectTrust: "network",
  doubleEscapeAction: "agent",
  treeFilterMode: "agent",
  anthropicExtraUsageWarning: "network",
  retryEnabled: "agent",
  defaultTools: "runtime",
  codemodeInlineBudget: "runtime",
  shellPath: "runtime",
  shellCommandPrefix: "runtime",
  npmCommand: "runtime",
  packages: "runtime",
  extensions: "runtime",
  skills: "runtime",
  prompts: "runtime",
} satisfies Record<PiSettingUpdate["key"], SettingsPageId>;

export function settingsSectionError(
  section: SettingsPageId,
  source: { readonly error?: string; readonly errorDetails?: string } | undefined,
): SettingsError[] {
  return source?.error ? [{ section, message: source.error, details: source.errorDetails }] : [];
}
