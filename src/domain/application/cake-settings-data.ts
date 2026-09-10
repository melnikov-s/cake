export const cakeSettingsSectionIds = ["appearance", "editor", "hotkeys"] as const;
export type CakeSettingsSectionId = (typeof cakeSettingsSectionIds)[number];

export const cakeSettingsSections = [
  {
    id: "appearance",
    scope: "window",
    writable: true,
    description: "Theme, avatars, and work-log presentation",
  },
  {
    id: "editor",
    scope: "window",
    writable: true,
    description: "Embedded VS Code presentation",
  },
  {
    id: "hotkeys",
    scope: "window",
    writable: true,
    description: "Application keyboard shortcuts",
  },
] as const;

export const cakeHotkeyActionIds = [
  "toggle-agent-editor",
  "open-editor",
  "open-changes",
  "toggle-terminal",
  "new-terminal-tab",
  "toggle-sidebar",
  "toggle-session-tree",
  "split-right",
  "split-down",
  "focus-left",
  "focus-right",
  "focus-above",
  "focus-below",
  "focus-pane-1",
  "focus-pane-2",
  "focus-pane-3",
  "focus-pane-4",
  "history-back",
  "history-forward",
  "show-ui-hints",
  "toggle-work-logs",
  "cycle-work-log-view",
  "open-hovered-message",
  "open-settings",
] as const;

export type CakeHotkeyActionId = (typeof cakeHotkeyActionIds)[number];

interface CakeAppearanceSettings {
  readonly theme: "system" | "light" | "dark";
  readonly projectAvatarsEnabled: boolean;
  readonly sessionAvatarsEnabled: boolean;
  readonly workLogViewMode: "auto" | "diff" | "log";
  readonly workLogsExpansion: "collapsed" | "expanded" | "fully-expanded";
}

export interface CakeEditorSettings {
  readonly sidebarAutoHide: "never" | "always" | "below-width";
  readonly sidebarAutoHideWidth: 1024 | 1280 | 1440 | 1728 | 1920;
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
  | { readonly section: "editor"; readonly settings: CakeEditorSettings }
  | { readonly section: "hotkeys"; readonly settings: CakeHotkeySettings };

export type CakeSettingsUpdate =
  | {
      readonly section: "appearance";
      readonly changes: Partial<CakeAppearanceSettings>;
    }
  | {
      readonly section: "editor";
      readonly changes: Partial<CakeEditorSettings>;
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
