import type { SettingsPageId } from "../stores/SettingsStore";

export type SettingsSearchItem = {
  page: SettingsPageId;
  label: string;
  targetId: string;
  keywords?: string;
};

type SettingsNavItem = {
  page: SettingsPageId;
  label: string;
  description?: string;
  settings: readonly Omit<SettingsSearchItem, "page">[];
};

export const SETTINGS_NAV_GROUPS: ReadonlyArray<{
  label: string;
  items: readonly SettingsNavItem[];
}> = [
  {
    label: "Intelligence",
    items: [
      {
        page: "models",
        label: "Models",
        description: "Defaults and presets",
        settings: [
          { label: "Current chat model configuration", targetId: "pi-settings-title" },
          { label: "Model presets", targetId: "model-presets-title", keywords: "fast mode" },
          { label: "Default agent model", targetId: "default-model-title", keywords: "reasoning" },
          { label: "Utility model", targetId: "utility-model-title", keywords: "background tasks" },
        ],
      },
      {
        page: "providers",
        label: "Providers",
        description: "Accounts and API keys",
        settings: [
          {
            label: "Provider accounts and API keys",
            targetId: "providers-title",
            keywords: "authentication login oauth token connect disconnect",
          },
        ],
      },
      {
        page: "agent",
        label: "Agent",
        description: "Behavior and content",
        settings: [
          { label: "Auto-compact", targetId: "setting-auto-compact", keywords: "context" },
          { label: "Automatic retry", targetId: "setting-automatic-retry", keywords: "failures" },
          {
            label: "Hide thinking",
            targetId: "setting-hide-thinking",
            keywords: "reasoning blocks",
          },
          {
            label: "Steering mode",
            targetId: "setting-steering-mode",
            keywords: "messages delivery",
          },
          {
            label: "Follow-up mode",
            targetId: "setting-follow-up-mode",
            keywords: "queued messages",
          },
          { label: "Auto-resize images", targetId: "setting-auto-resize-images" },
          { label: "Block images", targetId: "setting-block-images" },
          { label: "Skill commands", targetId: "setting-skill-commands" },
          { label: "Cache miss notices", targetId: "setting-cache-miss-notices" },
        ],
      },
    ],
  },
  {
    label: "Pi runtime",
    items: [
      {
        page: "runtime",
        label: "Execution & resources",
        settings: [
          { label: "Shell path", targetId: "setting-shell-path" },
          { label: "Shell command prefix", targetId: "setting-shell-command-prefix" },
          { label: "npm command", targetId: "setting-npm-command", keywords: "package operations" },
          { label: "Packages", targetId: "setting-packages", keywords: "json sources" },
          { label: "Extension paths", targetId: "setting-extension-paths" },
          { label: "Skill paths", targetId: "setting-skill-paths" },
          { label: "Prompt paths", targetId: "setting-prompt-paths" },
        ],
      },
      {
        page: "network",
        label: "Network & privacy",
        settings: [
          { label: "Transport", targetId: "setting-transport", keywords: "websocket sse" },
          { label: "HTTP idle timeout", targetId: "setting-http-idle-timeout" },
          { label: "Default project trust", targetId: "setting-default-project-trust" },
          {
            label: "Anthropic extra usage warning",
            targetId: "setting-anthropic-extra-usage-warning",
          },
          {
            label: "Install telemetry",
            targetId: "setting-install-telemetry",
            keywords: "update ping",
          },
        ],
      },
    ],
  },
  {
    label: "Application",
    items: [
      {
        page: "appearance",
        label: "Appearance",
        settings: [
          { label: "Theme", targetId: "setting-theme", keywords: "light dark system color" },
        ],
      },
      {
        page: "hotkeys",
        label: "Hotkeys",
        description: "Keyboard shortcuts",
        settings: [
          {
            label: "Keyboard shortcuts",
            targetId: "hotkeys-title",
            keywords: "keys bindings commands",
          },
        ],
      },
      {
        page: "editor",
        label: "VS Code",
        settings: [
          {
            label: "Auto-hide project sidebar",
            targetId: "setting-editor-sidebar-auto-hide",
            keywords: "embedded editor vscode",
          },
          {
            label: "Window width",
            targetId: "setting-editor-sidebar-auto-hide-width",
            keywords: "sidebar threshold narrow",
          },
        ],
      },
    ],
  },
];

const searchTerms = (value: string) =>
  value
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

export function searchSettings(query: string, additionalItems: readonly SettingsSearchItem[] = []) {
  const terms = searchTerms(query);
  if (terms.length === 0) return [];

  const pages = SETTINGS_NAV_GROUPS.flatMap((group) => group.items);
  return pages.flatMap((page) => {
    const items = [
      ...page.settings.map((setting) => ({ ...setting, page: page.page })),
      ...additionalItems.filter((setting) => setting.page === page.page),
    ].filter((setting) => {
      const searchable = searchTerms(
        `${page.label} ${page.description ?? ""} ${setting.label} ${setting.keywords ?? ""}`,
      );
      return terms.every((term) => searchable.some((word) => word.includes(term)));
    });
    return items.length > 0 ? [{ page: page.page, label: page.label, items }] : [];
  });
}
