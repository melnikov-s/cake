import type { AppearanceMode, ColorThemeChoice } from "../themes/color-theme";
export const cakeSettingsSectionIds = ["appearance", "hotkeys"] as const;
export type CakeSettingsSectionId = (typeof cakeSettingsSectionIds)[number];

export const cakeHotkeyActionIds = [
  "new-session",
  "toggle-agent-editor",
  "open-editor",
  "open-changes",
  "toggle-browser",
  "toggle-terminal",
  "new-terminal-tab",
  "toggle-sidebar",
  "toggle-session-tree",
  "return-to-project-chat",
  "history-back",
  "history-forward",
  "next-active-session",
  "previous-active-session",
  "show-ui-hints",
  "toggle-work-logs",
  "cycle-work-log-view",
  "open-hovered-message",
  "open-companion",
  "toggle-dictation-mute",
  "open-settings",
] as const;

export type CakeHotkeyActionId = (typeof cakeHotkeyActionIds)[number];

interface CakeAppearanceSettings {
  readonly theme: AppearanceMode;
  readonly lightTheme: ColorThemeChoice;
  readonly darkTheme: ColorThemeChoice;
  readonly projectAvatarsEnabled: boolean;
  readonly sessionAvatarsEnabled: boolean;
  readonly sidebarCharactersEnabled: boolean;
  readonly workLogViewMode: "auto" | "diff" | "log";
  readonly workLogsExpansion: "collapsed" | "expanded" | "fully-expanded";
}

interface CakeHotkeySetting {
  readonly action: CakeHotkeyActionId;
  readonly label: string;
  readonly description: string;
  readonly defaultBinding: string;
  readonly binding: string;
  readonly customized: boolean;
}

interface CakeHotkeySettings {
  readonly bindings: readonly CakeHotkeySetting[];
}

export type CakeSettingsSectionView =
  | { readonly section: "appearance"; readonly settings: CakeAppearanceSettings }
  | { readonly section: "hotkeys"; readonly settings: CakeHotkeySettings };

export type CakeSettingsUpdate =
  | {
      readonly section: "appearance";
      readonly changes: Partial<CakeAppearanceSettings>;
    }
  | {
      readonly section: "hotkeys";
      readonly changes: {
        readonly bindings: readonly {
          readonly action: CakeHotkeyActionId;
          /** null restores the default; an empty string disables the shortcut. */
          readonly binding: string | null;
        }[];
      };
    };
